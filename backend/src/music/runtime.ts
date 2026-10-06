import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MusicRuntimeStatus, Settings } from '../contracts';
import { AppError } from '../core/errors';
import { findInstalledGoMusicDl, GOMUSIC_VERSION, installGoMusicDl } from './install';
import { captureOutput, diagnostics } from '../core/diagnostics';
import { syncManagedMusicLogin } from './go-login';

type Config = Settings['gomusicdl'];
export interface RuntimeOptions {
  dataDir: string;
  changed: (status: MusicRuntimeStatus) => void;
  install?: typeof installGoMusicDl;
  findInstalled?: typeof findInstalledGoMusicDl;
  launch?: (executable: string, args: string[], cwd: string) => ChildProcess;
  startupTimeoutMs?: number;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return port;
}

export class GoMusicDlRuntime {
  status: MusicRuntimeStatus = { mode: 'managed', phase: 'uninstalled', installed: false, version: GOMUSIC_VERSION, baseUrl: null, error: null };
  private config?: Config;
  private enabled = false;
  private installRequested = false;
  private child?: ChildProcess;
  private operation: Promise<void> = Promise.resolve();
  private abort?: AbortController;
  private generation = 0;
  private closed = false;
  private retries = 0;
  private readonly onExit = () => this.child?.kill();
  constructor(private readonly options: RuntimeOptions) { process.on('exit', this.onExit); options.changed(this.status); }
  private update(phase: MusicRuntimeStatus['phase'], baseUrl: string | null = null, error: string | null = null) {
    this.status = { mode: this.config?.mode ?? 'managed', phase, installed: this.status.installed, version: this.config?.mode === 'external' ? '' : GOMUSIC_VERSION, baseUrl, error };
    diagnostics.info('gomusicdl.runtime.state', 'go-music-dl 状态变化', { phase, mode: this.status.mode, installed: this.status.installed, baseUrl, error });
    this.options.changed({ ...this.status });
  }
  configure(config: Config, force = false, enabled = true): Promise<void> {
    if (this.closed) return Promise.resolve();
    const sameConfig = this.config?.mode === config.mode && (config.mode === 'managed' || this.config.baseUrl === config.baseUrl);
    if (!force && this.installRequested && sameConfig) {
      this.enabled = enabled;
      return this.operation.then(() => {
        if (!this.closed && this.status.installed && (this.enabled && this.status.phase === 'stopped' || !this.enabled && this.status.phase === 'ready')) return this.configure(this.config!, true, this.enabled);
      });
    }
    if (!force && this.enabled === enabled && sameConfig) return this.operation;
    this.config = { ...config }; this.enabled = enabled; this.retries = 0;
    return this.schedule();
  }
  private schedule(backoffMs = 0, install = false) {
    const generation = ++this.generation;
    this.installRequested = install;
    this.abort?.abort();
    const abort = this.abort = new AbortController(); const config = { ...this.config! };
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.stopChild();
      if (generation !== this.generation || this.closed) return;
      if (config.mode === 'external') { this.update(this.enabled ? 'external' : 'stopped', this.enabled ? config.baseUrl : null); return; }
      try {
        if (backoffMs) await delay(backoffMs, undefined, { signal: abort.signal });
        let executable: string | null;
        if (install) {
          this.update('installing');
          executable = await (this.options.install ?? installGoMusicDl)({ dataDir: this.options.dataDir, signal: abort.signal });
        } else executable = await (this.options.findInstalled ?? findInstalledGoMusicDl)(this.options.dataDir);
        abort.signal.throwIfAborted();
        this.status.installed = !!executable;
        if (!executable) { this.update('uninstalled'); return; }
        if (!this.enabled) { this.update('stopped'); return; }
        const cwd = resolve(this.options.dataDir, 'tools', 'gomusicdl', 'state'); await mkdir(cwd, { recursive: true });
        const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}/music`;
        abort.signal.throwIfAborted(); this.update('starting');
        // Upstream's desktop mode binds only to loopback and requires no WebUI setup.
        const args = ['web', '--port', String(port), '--desktop', '--no-browser'];
        diagnostics.info('gomusicdl.process.start', '启动 go-music-dl 进程', { executable, cwd, args });
        const child = this.child = this.options.launch ? this.options.launch(executable, args, cwd) : spawn(executable, args, {
          cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MUSIC_DL_CONFIG_DB: resolve(cwd, 'config.db'), MUSIC_DL_COOKIE_FILE: resolve(cwd, 'cookies.json') },
        });
        captureOutput(child.stdout, 'gomusicdl.process.stdout', 'go-music-dl 输出', { engine: 'gomusicdl' });
        captureOutput(child.stderr, 'gomusicdl.process.stderr', 'go-music-dl 标准错误输出', { engine: 'gomusicdl' });
        let launchError: Error | undefined;
        child.on('error', error => { launchError = error; diagnostics.error('gomusicdl.process.error', 'go-music-dl 进程错误', { error }); });
        child.once('exit', (code, signal) => {
          diagnostics.info('gomusicdl.process.exit', 'go-music-dl 进程退出', { code, signal });
          if (this.child !== child || generation !== this.generation || this.closed) return;
          this.child = undefined;
          if (this.status.phase === 'ready') {
            this.update('failed', null, `go-music-dl 意外退出（${signal ?? code}）${this.retries < 3 ? '，正在自动重启' : '，请点击重试'}`);
            if (this.retries < 3) void this.schedule(1000 * 2 ** this.retries++);
          }
        });
        const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30000);
        let lastHealthLog = 0;
        while (Date.now() < deadline) {
          abort.signal.throwIfAborted();
          if (launchError) throw launchError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`go-music-dl 启动后退出（${child.signalCode ?? child.exitCode}）`);
          let healthy = false;
          try {
            const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(750)]) });
            if (response.ok) {
              const health = await response.json() as { app?: string; status?: string };
              if (health.app === 'go-music-dl' && health.status === 'ok') {
                // Check process ownership before trusting the listener.
                await delay(100, undefined, { signal: abort.signal });
                if (child.exitCode !== null || child.signalCode !== null || this.child !== child) throw new Error('go-music-dl 监听失败，请重试');
                healthy = true;
              }
            }
          } catch (error) { if (Date.now() - lastHealthLog > 1000) { lastHealthLog = Date.now(); diagnostics.debug('gomusicdl.health.waiting', '等待 go-music-dl 健康接口', { baseUrl, error }); } abort.signal.throwIfAborted(); }
          if (healthy) { await syncManagedMusicLogin(baseUrl, abort.signal); this.update('ready', baseUrl); return; }
          await delay(150, undefined, { signal: abort.signal });
        }
        throw new Error('go-music-dl 启动超时，请重试或连接已有服务');
      } catch (error) {
        diagnostics.error('gomusicdl.runtime.failed', 'go-music-dl 安装或启动失败', { error });
        await this.stopChild();
        if (generation === this.generation && !this.closed) this.update('failed', null, error instanceof Error ? error.message : 'go-music-dl 启动失败');
      } finally {
        if (generation === this.generation) this.installRequested = false;
      }
    });
    return this.operation;
  }
  async endpoint(config: Config) {
    if (config.mode === 'external') return config.baseUrl;
    await this.configure(config);
    if (this.status.phase === 'uninstalled') throw new AppError('ENGINE_NOT_INSTALLED', 'go-music-dl 未安装，请在后台点击安装');
    if (this.status.phase !== 'ready' || !this.status.baseUrl) throw new AppError('ENGINE_NOT_READY', this.status.error ?? '音源正在准备，请稍后重试');
    return this.status.baseUrl;
  }
  restart() { return this.config ? this.configure(this.config, true, this.enabled) : Promise.resolve(); }
  install() {
    if (this.closed || !this.config || this.config.mode !== 'managed') throw new AppError('ENGINE_UNAVAILABLE', '请先保存 go-music-dl 本地托管模式', 400);
    if (this.installRequested) return this.operation;
    return this.schedule(0, true);
  }
  suspend() { return this.config ? this.configure(this.config, false, false) : Promise.resolve(); }
  private async stopChild() {
    const child = this.child; this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2500);
      child.once('exit', () => { clearTimeout(timer); done(); }); child.kill();
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.abort?.abort();
    await this.operation; await this.stopChild(); process.off('exit', this.onExit); this.update('stopped');
  }
}
