import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AudioEngine, MusicRuntimeStatus, Track } from '../contracts';
import { AppError } from '../core/errors';
import { findInstalledMusicDl, installMusicDl, MUSICDL_VERSION, pythonEnvironment } from './python-install';
import { captureOutput, diagnostics } from '../core/diagnostics';

export type LibraryEngine = Exclude<AudioEngine, 'gomusicdl' | 'gdstudio'>;
type Engine = LibraryEngine;
interface Endpoint { send(message: unknown): void; stop(): Promise<void>; kill(): void }
interface Pending { resolve(value: any): void; reject(error: Error): void; debug(data: any): void }
export interface AdapterOptions { engine: Engine; dataDir: string; changed: (status: MusicRuntimeStatus) => void; installPython?: typeof installMusicDl; findInstalledPython?: typeof findInstalledMusicDl; workerPath?: string; requestTimeoutMs?: number }
export class AdapterRuntime {
  status: MusicRuntimeStatus;
  private endpoint?: Endpoint;
  private abort?: AbortController;
  private operation: Promise<void> = Promise.resolve();
  private calls: Promise<any> = Promise.resolve();
  private pending = new Map<number, Pending>();
  private serial = 0;
  private generation = 0;
  private enabled = false;
  private configured = false;
  private installRequested = false;
  private closed = false;
  private readonly onExit = () => this.endpoint?.kill();
  constructor(private readonly options: AdapterOptions) {
    this.status = { mode: options.engine === 'musicdl' ? 'managed' : 'builtin', phase: options.engine === 'musicdl' ? 'uninstalled' : 'stopped', installed: options.engine !== 'musicdl', version: options.engine === 'musicdl' ? MUSICDL_VERSION : options.engine === 'meting' ? '1.6.1' : '4.41.0', baseUrl: null, error: null };
    process.on('exit', this.onExit); options.changed({ ...this.status });
  }
  private update(phase: MusicRuntimeStatus['phase'], error: string | null = null) { this.status = { ...this.status, phase, error: error ? diagnostics.summary(error) : null }; diagnostics.info('music.runtime.state', '音源进程状态变化', { engine: this.options.engine, phase, installed: this.status.installed, error: this.status.error }); this.options.changed({ ...this.status }); }
  configure(enabled: boolean, force = false): Promise<void> {
    if (!this.closed && this.installRequested && !force) {
      this.enabled = enabled; this.configured = true;
      return this.operation.then(() => {
        if (!this.closed && this.status.installed && (this.enabled && this.status.phase === 'stopped' || !this.enabled && this.status.phase === 'ready')) return this.configure(this.enabled, true);
      });
    }
    if (this.closed || this.configured && !force && enabled === this.enabled) return this.operation;
    this.enabled = enabled; this.configured = true;
    return this.schedule();
  }
  private schedule(install = false) {
    this.installRequested = install;
    this.abort?.abort(); const abort = this.abort = new AbortController(); const generation = ++this.generation;
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.stop(); if (this.closed || generation !== this.generation) return;
      try {
        let executable = '';
        if (this.options.engine === 'musicdl') {
          let python: string | null;
          if (install) {
            this.update('installing');
            python = await (this.options.installPython ?? installMusicDl)(this.options.dataDir, abort.signal);
          } else python = await (this.options.findInstalledPython ?? findInstalledMusicDl)(this.options.dataDir);
          abort.signal.throwIfAborted(); this.status.installed = !!python;
          if (!python) { this.update('uninstalled'); return; }
          executable = python;
        }
        if (!this.enabled) { this.update('stopped'); return; }
        abort.signal.throwIfAborted(); this.update('starting');
        const cwd = resolve(this.options.dataDir, 'tools', this.options.engine, 'state'); await mkdir(cwd, { recursive: true });
        await this.launch(cwd, executable, abort.signal, generation); abort.signal.throwIfAborted(); this.update('ready');
      } catch (error) {
        diagnostics.error('music.runtime.failed', '音源安装或启动失败', { engine: this.options.engine, error });
        await this.stop();
        if (!this.closed && generation === this.generation) this.update('failed', error instanceof Error && /准备|初始化|安装|启动|GitHub|PyPI|支持/.test(error.message) ? error.message : '音源准备失败，请点击重试');
      } finally {
        if (generation === this.generation) this.installRequested = false;
      }
    });
    return this.operation;
  }
  private async launch(cwd: string, executable: string, signal: AbortSignal, generation: number) {
    await new Promise<void>((ready, fail) => {
      let settled = false;
      const timer = setTimeout(() => reject(new Error('音源初始化超时，请点击重试')), 60000);
      const aborted = () => reject(new Error('音源启动已取消'));
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      const reject = (error: Error) => { if (!settled) { settled = true; cleanup(); fail(error); } };
      const died = () => {
        if (this.endpoint !== endpoint) return;
        diagnostics.warn('music.worker.exited', '音源 Worker 已退出', { engine: this.options.engine }); reject(new Error('音源启动后退出，请重试')); this.rejectPending(new Error('音源进程已退出'));
        if (generation === this.generation && this.enabled && !this.closed && this.status.phase === 'ready') this.update('failed', '音源意外退出，下次调用会重新启动，也可点击重试');
      };
      const message = (data: any) => {
        if (data?.type === 'ready') { if (!settled) { settled = true; cleanup(); ready(); } }
        else if (data?.type === 'failed') { diagnostics.error('music.worker.init_failed', '音源 Worker 初始化失败', { engine: this.options.engine, error: data.error }); reject(Object.assign(new Error(diagnostics.summary(data.error)), { cause: data.error })); }
        else if (data?.type === 'debug') { const waiter = [...this.pending.values()][0]; if (waiter) waiter.debug(data); else diagnostics.debug(data.event ?? 'music.worker.debug', data.message ?? '音源内部调试信息', { engine: this.options.engine, error: data.error, output: data.output }); }
        else if (data?.type === 'result') {
          const waiter = this.pending.get(data.id); this.pending.delete(data.id);
          if (data.error) { const error = Object.assign(new AppError('SOURCE_UNAVAILABLE', diagnostics.summary(data.error)), { cause: data.error }); waiter?.reject(error); } else waiter?.resolve(data.result);
        }
      };
      let endpoint: Endpoint;
      if (this.options.engine === 'musicdl') {
        diagnostics.info('music.worker.launch', '启动 Python 音源 Worker', { engine: this.options.engine, executable });
        const child = spawn(executable, ['-u', this.options.workerPath ?? resolve(__dirname, 'musicdl-worker.py')], { cwd, env: pythonEnvironment(this.options.dataDir), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        captureOutput(child.stderr, 'music.worker.stderr', 'Python Worker 标准错误输出', { engine: this.options.engine });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => { if (line.length > 1024 * 1024) { diagnostics.warn('music.worker.rpc_oversized', 'Python Worker 响应超过限制', { engine: this.options.engine, bytes: line.length }); child.kill(); died(); return; } try { message(JSON.parse(line)); } catch (error) { diagnostics.debug('music.worker.non_rpc_output', 'Python Worker 输出不是有效 RPC 消息', { engine: this.options.engine, error, output: line.length <= 16000 ? line : '[超长输出已省略]' }); } });
        child.stdin.on('error', error => { diagnostics.warn('music.worker.stdin_failed', 'Python Worker 输入管道错误', { engine: this.options.engine, error }); died(); }); child.on('error', error => { diagnostics.error('music.worker.spawn_failed', 'Python Worker 进程启动失败', { engine: this.options.engine, error }); died(); }); child.once('exit', died);
        endpoint = { send: data => { child.stdin.write(JSON.stringify(data) + '\n'); }, kill: () => { child.kill(); }, stop: async () => {
          lines.close(); if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
          await new Promise<void>(done => { const timeout = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2500); child.once('exit', () => { clearTimeout(timeout); done(); }); child.kill(); });
        } };
      } else {
        const worker = new Worker(this.options.workerPath ?? resolve(__dirname, 'native-worker.js'), { workerData: { engine: this.options.engine }, stdout: true, stderr: true, env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd } });
        captureOutput(worker.stdout, 'music.worker.stdout', 'Node 音源 Worker 输出', { engine: this.options.engine }); captureOutput(worker.stderr, 'music.worker.stderr', 'Node 音源 Worker 标准错误输出', { engine: this.options.engine }); worker.on('message', message); worker.on('error', error => { diagnostics.error('music.worker.error', 'Node 音源 Worker 错误', { engine: this.options.engine, error }); died(); }); worker.once('exit', died);
        endpoint = { send: data => worker.postMessage(data), kill: () => { void worker.terminate(); }, stop: async () => { await worker.terminate(); } };
      }
      this.endpoint = endpoint; signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
    });
  }
  call<T>(method: 'resolve' | 'search', track: Track): Promise<T> {
    const operation = this.calls.catch(() => {}).then(async () => {
      const started = Date.now(); diagnostics.info('music.rpc.start', '调用音源 Worker', { engine: this.options.engine, method, platform: track.platform, externalId: track.externalId });
      if (this.closed) throw new AppError('ENGINE_UNAVAILABLE', '音源已关闭');
      await this.configure(true, this.status.phase === 'failed');
      if (this.status.phase === 'uninstalled') throw new AppError('ENGINE_NOT_INSTALLED', 'musicdl 未安装，请在后台点击安装');
      if (this.status.phase !== 'ready' || !this.endpoint) throw new AppError('ENGINE_NOT_READY', this.status.error ?? '音源尚未就绪');
      const id = ++this.serial; const endpoint = this.endpoint;
      return await new Promise<T>((ok, fail) => {
        const timer = setTimeout(() => {
          diagnostics.warn('music.rpc.timeout', '音源 Worker 调用超时', { engine: this.options.engine, method, durationMs: Date.now() - started });
          this.pending.delete(id); this.update('failed', '取源超时，已停止该进程；下次调用会重启');
          void this.stop(); fail(new AppError('SOURCE_TIMEOUT', '此音源取源超时'));
        }, this.options.requestTimeoutMs ?? (this.options.engine === 'musicdl' ? 45000 : 30000));
        this.pending.set(id, { resolve: diagnostics.bind(value => { clearTimeout(timer); diagnostics.info('music.rpc.complete', '音源 Worker 调用成功', { engine: this.options.engine, method, durationMs: Date.now() - started, url: value?.url, resultCount: Array.isArray(value) ? value.length : undefined }); ok(value); }), reject: diagnostics.bind(error => { clearTimeout(timer); diagnostics.warn('music.rpc.failed', '音源 Worker 调用失败', { engine: this.options.engine, method, durationMs: Date.now() - started, error }); fail(error); }), debug: diagnostics.bind(data => diagnostics.debug(data.event ?? 'music.worker.debug', data.message ?? '音源内部调试信息', { engine: this.options.engine, error: data.error, output: data.output })) });
        try { endpoint.send({ id, method, track }); } catch (error) { diagnostics.warn('music.rpc.send_failed', '向音源 Worker 发送请求失败', { engine: this.options.engine, error }); this.pending.get(id)?.reject(new AppError('ENGINE_UNAVAILABLE', '音源连接已关闭')); this.pending.delete(id); }
      });
    });
    this.calls = operation; return operation;
  }
  restart() { return this.configure(this.enabled, true); }
  install() {
    if (this.closed || this.options.engine !== 'musicdl') throw new AppError('ENGINE_UNAVAILABLE', '此音源使用随项目安装的依赖', 400);
    if (this.installRequested) return this.operation;
    return this.schedule(true);
  }
  private rejectPending(error: Error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }
  private async stop() { const endpoint = this.endpoint; this.endpoint = undefined; this.rejectPending(new AppError('ENGINE_UNAVAILABLE', '音源连接已关闭')); await endpoint?.stop(); }
  async close() { if (this.closed) return; this.closed = true; this.generation++; this.abort?.abort(); await this.operation.catch(() => {}); await this.stop(); process.off('exit', this.onExit); this.update('stopped'); }
}
