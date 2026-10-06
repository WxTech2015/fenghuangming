import { connect, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentConfig } from './config';
import { Mpv } from './mpv';
export interface PlayerState { ready: boolean; playbackId: string | null; started?: boolean; position: number; paused: boolean; filename?: string; durationSeconds?: number; seekable?: boolean; recovering?: boolean }
interface Recovery { playbackId: string; filename: string; position: number; paused: boolean; volume: number; generation: number }
interface WorkerOptions { createPlayer?: () => Mpv; restartDelayMs?: number }
export class Worker {
  readonly state: PlayerState = { ready: false, playbackId: null, started: false, position: 0, paused: false };
  private socket?: Socket;
  private player: Mpv;
  private stopped = false;
  private leaseUntil = 0;
  private epoch = 0;
  private interval?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private connectionError = '';
  private playerRestart?: NodeJS.Timeout;
  private playerStarting = false;
  private playerFailures = 0;
  private braked = false;
  private playerAvailable = false;
  private controlGeneration = 0;
  private recovery?: Recovery;
  private lastRecoveryAt = 0;
  private volume = 50;
  constructor(readonly config: AgentConfig, private readonly options: WorkerOptions = {}) { this.player = this.createPlayer(); }
  private createPlayer() { return this.options.createPlayer?.() ?? new Mpv(this.config.mpvPath, this.config.mpvPipe); }
  async start() {
    await mkdir(this.config.dataDir, { recursive: true }); this.braked = await this.persistedBrake(); this.connect();
    this.interval = setInterval(() => { if (this.state.playbackId && performance.now() > this.leaseUntil) void this.stopPlayback().catch(() => {}); this.status(); }, 1000);
    await this.startPlayer();
  }
  private async startPlayer() {
    if (this.stopped || this.playerStarting) return;
    this.playerStarting = true;
    if (await this.persistedBrake()) this.braked = true;
    if (this.stopped) { this.playerStarting = false; return; }
    const player = this.player;
    player.on('log', (line: string) => console.error(new Date().toISOString(), 'mpv:', line));
    player.on('unavailable', (reason?: string) => this.playerUnavailable(reason ?? 'mpv 进程已退出'));
    player.on('event', (data: { event: string; name?: string; data?: unknown; reason?: string; error?: string }) => {
      if (this.stopped || player !== this.player) return;
      if (data.event === 'property-change' && data.name === 'time-pos') this.state.position = typeof data.data === 'number' ? Math.max(0, data.data) : 0;
      if (data.event === 'property-change' && data.name === 'pause') this.state.paused = !!data.data;
      if (data.event === 'property-change' && data.name === 'duration') this.state.durationSeconds = typeof data.data === 'number' && Number.isFinite(data.data) ? Math.max(0, data.data) : 0;
      if (data.event === 'property-change' && data.name === 'seekable') this.state.seekable = data.data === true;
      if (data.event === 'property-change' && data.name === 'audio-device-list') console.log(new Date().toISOString(), 'Windows 音频设备列表:', JSON.stringify(data.data));
      if (data.event === 'property-change' && data.name === 'current-ao') console.log(new Date().toISOString(), '当前音频输出:', data.data ?? '尚未打开');
      if (data.event === 'file-loaded' && this.state.playbackId && !this.state.started) { this.state.started = true; this.event('started'); }
      if (data.event === 'end-file' && this.state.playbackId) {
        if (data.reason === 'error' && /audio output|audio device|wasapi/i.test(data.error ?? '')) this.playerUnavailable(data.error ?? '音频输出失效');
        else this.event(data.reason === 'eof' ? 'ended' : data.reason === 'error' ? 'failed' : 'stopped', data.error);
      }
    });
    try {
      await player.start(); if (this.stopped) return;
      this.playerAvailable = true;
      if (this.recovery) await this.restorePlayback(player, this.recovery);
      this.state.ready = this.playerAvailable && !this.braked; this.playerFailures = 0; console.log(new Date().toISOString(), 'mpv 播放器已就绪。'); this.status();
    } catch (error) { this.playerUnavailable(error instanceof Error ? error.message : 'mpv 启动失败'); }
    finally { this.playerStarting = false; if (!this.stopped && !this.playerAvailable) this.restartPlayer(); }
  }
  private playerUnavailable(reason: string) {
    if (this.stopped) return;
    this.playerAvailable = false; this.state.ready = false;
    console.error(new Date().toISOString(), '播放器未就绪:', reason);
    if (this.state.playbackId && !this.recovery && this.state.started && this.state.filename && !this.braked && performance.now() < this.leaseUntil && Date.now() - this.lastRecoveryAt > 10000) {
      this.lastRecoveryAt = Date.now(); this.recovery = { playbackId: this.state.playbackId, filename: this.state.filename, position: this.state.position, paused: this.state.paused, volume: this.volume, generation: this.controlGeneration }; this.state.recovering = true;
      console.log(new Date().toISOString(), `尝试恢复当前歌曲，位置 ${Math.floor(this.state.position)} 秒。`);
    } else if (this.state.playbackId) this.event('failed', reason.slice(0, 450));
    this.player.close();
    this.status(); if (!this.playerStarting) this.restartPlayer();
  }
  private async restorePlayback(player: Mpv, recovery: Recovery) {
    const allowed = () => { if (this.stopped || this.braked || recovery.generation !== this.controlGeneration || player !== this.player || recovery.playbackId !== this.state.playbackId || performance.now() > this.leaseUntil) throw new Error('恢复播放已取消'); };
    let dispose = () => {};
    try {
      if (await this.persistedBrake()) throw new Error('本机制动锁已启用');
      allowed(); await player.command(['set_property', 'pause', true]); allowed(); await player.command(['set_property', 'volume', recovery.volume]); allowed();
      const loaded = new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('恢复歌曲加载超时')), 5000);
        const onEvent = (event: { event: string; reason?: string; error?: string }) => { if (event.event === 'file-loaded') ok(); if (event.event === 'end-file' && event.reason === 'error') fail(new Error(event.error ?? '恢复歌曲加载失败')); if (event.event === 'end-file' && this.state.playbackId !== recovery.playbackId) fail(new Error('恢复播放已取消')); };
        const onLost = () => fail(new Error('恢复时播放器再次退出'));
        player.on('event', onEvent); player.once('unavailable', onLost);
        dispose = () => { clearTimeout(timer); player.off('event', onEvent); player.off('unavailable', onLost); };
      });
      await Promise.all([loaded, player.command(['loadfile', recovery.filename, 'replace'])]); allowed();
      await player.command(['seek', recovery.position, 'absolute+exact']); allowed(); await player.command(['set_property', 'pause', recovery.paused]); allowed();
      this.state.position = recovery.position; this.state.paused = recovery.paused; console.log(new Date().toISOString(), '当前歌曲已恢复。');
    } catch (error) {
      if (recovery.playbackId === this.state.playbackId) this.event('failed', (error as Error).message);
      // A brake or expired lease may arrive while loadfile is in flight.
      if (player === this.player) await player.command(['stop']).catch(() => {});
      console.error(new Date().toISOString(), '恢复播放终止:', (error as Error).message);
    } finally { dispose(); if (this.recovery === recovery) this.recovery = undefined; this.state.recovering = false; }
  }
  private restartPlayer() {
    if (this.stopped || this.playerRestart) return;
    const delay = Math.min(30000, (this.options.restartDelayMs ?? 2000) * 2 ** Math.min(this.playerFailures++, 4));
    console.log(new Date().toISOString(), `将在 ${delay / 1000} 秒后重启 mpv。`);
    this.playerRestart = setTimeout(() => {
      this.playerRestart = undefined; if (this.stopped) return;
      this.player.removeAllListeners(); this.player = this.createPlayer(); void this.startPlayer();
    }, delay);
  }
  private connect() {
    if (this.stopped) return;
    const socket = connect(this.config.pipe); this.socket = socket; let input = ''; let work = Promise.resolve();
    socket.on('error', error => {
      if (this.connectionError !== error.message) { this.connectionError = error.message; console.error(new Date().toISOString(), '本机服务连接失败:', error.message); }
    });
    socket.on('connect', () => { this.connectionError = ''; console.log(new Date().toISOString(), '播放器已连接本机服务。'); socket.write(JSON.stringify({ type: 'worker-hello', secret: this.config.ipcSecret, state: this.state }) + '\n'); });
    socket.on('close', () => { if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 2000); });
    socket.on('data', chunk => {
      input += chunk.toString(); if (input.length > 100000) { socket.destroy(); return; }
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          if (data.secret !== this.config.ipcSecret) { socket.destroy(); return; }
          if (data.type === 'emergency-stop' && typeof data.blocked === 'boolean') {
            if (data.blocked) this.controlGeneration++;
            this.braked = data.blocked; this.state.ready = this.playerAvailable && !this.braked && !this.playerStarting; this.status();
            const player = this.player;
            const kill = this.braked ? setTimeout(() => { if (this.player !== player || this.stopped) return; player.close(); this.playerUnavailable('制动时 mpv 未及时响应，已终止播放器'); }, 250) : undefined;
            const stop = this.braked ? this.stopPlayback() : Promise.resolve();
            void stop.then(() => this.send({ type: 'result', requestId: data.requestId, ok: true })).catch(error => { player.close(); this.send({ type: 'result', requestId: data.requestId, ok: false, error: String(error.message) }); this.playerUnavailable('紧急停止未成功，已终止播放器'); }).finally(() => { if (kill) clearTimeout(kill); });
            continue;
          }
          if (data.type === 'lease') { if (typeof data.epoch === 'number' && data.epoch >= this.epoch && typeof data.leaseMs === 'number' && Number.isFinite(data.leaseMs) && data.leaseMs > 0) { this.epoch = data.epoch; this.leaseUntil = performance.now() + Math.min(60000, data.leaseMs); } continue; }
          work = work.then(async () => {
            try { if (data.epoch !== this.epoch || performance.now() > this.leaseUntil) throw new Error('服务连接租约已过期'); await this.execute(data); this.send({ type: 'result', requestId: data.requestId, ok: true }); }
            catch (error) { this.send({ type: 'result', requestId: data.requestId, ok: false, error: error instanceof Error ? error.message : '播放失败' }); }
          });
        } catch { socket.destroy(); }
      }
    });
  }
  private async execute(data: Record<string, unknown>) {
    if (data.action === 'stop') { await this.stopPlayback(String(data.playbackId)); this.status(); return; }
    const generation = this.controlGeneration;
    const player = this.player;
    const allowed = () => { if (this.braked || generation !== this.controlGeneration) throw new Error('本机已紧急制动'); if (this.stopped || player !== this.player || !this.playerAvailable) throw new Error('播放器已停止或发生变化'); };
    if (data.action === 'start' && await this.persistedBrake()) { this.braked = true; this.state.ready = false; this.status(); }
    allowed();
    if (!this.state.ready) throw new Error('mpv 未就绪');
    if (data.action === 'start') {
      const filename = resolve(String(data.filename)); const cacheDir = resolve(this.config.dataDir, 'cache') + sep;
      if (!filename.startsWith(cacheDir)) throw new Error('不允许播放缓存目录之外的文件');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) { allowed(); hash.update(chunk); }
      if (hash.digest('hex') !== data.sha256) throw new Error('播放文件校验失败');
      allowed();
      if (this.state.playbackId === data.playbackId) return;
      await this.stopPlayback(); this.state.playbackId = String(data.playbackId); this.state.started = false; this.state.filename = filename; this.state.position = 0; this.state.paused = false; this.lastRecoveryAt = 0; this.volume = Math.max(0, Math.min(100, Number(data.volume)));
      await this.player.command(['set_property', 'volume', Math.max(0, Math.min(100, Number(data.volume)))]);
      await this.player.command(['set_property', 'pause', false]);
      try { allowed(); await this.player.command(['loadfile', filename, 'replace']); if (this.braked || generation !== this.controlGeneration) await this.player.command(['stop']); } catch (error) { this.event('failed', (error as Error).message); throw error; }
    } else if (data.action === 'pause' || data.action === 'resume') { if (data.playbackId !== this.state.playbackId) throw new Error('播放任务已改变'); await this.player.command(['set_property', 'pause', data.action === 'pause']); }
    else if (data.action === 'volume') { this.volume = Math.max(0, Math.min(100, Number(data.volume))); await this.player.command(['set_property', 'volume', this.volume]); }
    else if (data.action === 'seek') {
      if (data.playbackId !== this.state.playbackId) throw new Error('播放任务已改变');
      if (!this.state.started || !this.state.seekable || !this.state.durationSeconds) throw new Error('当前歌曲尚不可调整进度');
      if (typeof data.position !== 'number' || !Number.isInteger(data.position) || data.position < 0 || data.position > 86400) throw new Error('进度必须为 0–86400 的整数秒');
      const target = Math.min(data.position, Math.max(0, Math.floor(this.state.durationSeconds) - 1));
      allowed(); await player.command(['seek', target, 'absolute+exact']); allowed();
      this.state.position = target; console.log(new Date().toISOString(), `本机调整播放进度：${target} 秒。`);
    }
    else throw new Error('未知播放器指令');
    this.status();
  }
  private async stopPlayback(requestedId?: string) {
    const playbackId = this.state.playbackId;
    if (requestedId && playbackId && requestedId !== playbackId) throw new Error('播放任务已改变');
    this.recovery = undefined; this.state.recovering = false; this.state.playbackId = null; this.state.started = false; this.state.filename = undefined; this.state.position = 0; this.state.durationSeconds = 0; this.state.seekable = false;
    try { await this.player.command(['stop']); } finally { if (playbackId || requestedId) this.send({ type: 'playback', eventId: randomUUID(), playbackId: playbackId ?? requestedId, state: 'stopped' }); }
  }
  private event(state: 'started' | 'ended' | 'failed' | 'stopped', error?: string) {
    const playbackId = this.state.playbackId; if (!playbackId) return;
    this.send({ type: 'playback', eventId: randomUUID(), playbackId, state, error });
    if (state !== 'started') { this.recovery = undefined; this.state.recovering = false; this.state.playbackId = null; this.state.started = false; this.state.filename = undefined; this.state.position = 0; this.state.durationSeconds = 0; this.state.seekable = false; } this.status();
  }
  private send(value: unknown) { if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(value) + '\n'); }
  private async persistedBrake() { try { return JSON.parse(await readFile(resolve(this.config.dataDir, 'control-state.json'), 'utf8')).emergencyStopped === true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; } }
  private status() { this.send({ type: 'status', state: this.state }); }
  async close() { this.stopped = true; if (this.interval) clearInterval(this.interval); if (this.reconnect) clearTimeout(this.reconnect); if (this.playerRestart) clearTimeout(this.playerRestart); await this.stopPlayback().catch(() => {}); this.socket?.destroy(); this.player.removeAllListeners(); this.player.close(); }
}
