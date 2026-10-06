import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, stat, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { WebSocket } from 'ws';
import { AgentMessageSchema, WireCommandSchema, type AgentMessage, type WireCommand } from './contracts';
import type { AgentConfig } from './config';
import type { PlayerState } from './worker';
import { parseConfig } from './config';
import { LocalConsoleServer } from './control';
import { downloadCachedAudio, type TransferProgress } from './download';

type PlaybackEvent = Extract<AgentMessage, { type: 'playback' }>;
export class AgentService {
  private server?: Server;
  private worker?: Socket;
  private socket?: WebSocket;
  private state: PlayerState = { ready: false, playbackId: null, position: 0, paused: false };
  private activeFile?: string;
  private epoch = 0;
  private agentId = '';
  private zoneId = '';
  private welcomed = false;
  private leaseUntil = 0;
  private stopped = false;
  private retries = 0;
  private reconnect?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private readonly bootId = randomUUID();
  private journal: { commands: string[]; events: PlaybackEvent[] } = { commands: [], events: [] };
  private saving: Promise<unknown> = Promise.resolve();
  private pendingStart?: { command: WireCommand; abort: AbortController };
  private emergencyStopped = false;
  private brakeVersion = 0;
  private controlSaving: Promise<unknown> = Promise.resolve();
  private consoleServer?: LocalConsoleServer;
  private currentTrack: { title: string; artists: string[]; durationSeconds: number } | null = null;
  private currentPlaybackId: string | null = null;
  private readonly starts = new Set<Promise<void>>();
  private transfer: TransferProgress | null = null;
  private overview: Record<string, unknown> | null = null;
  private readonly previousTokens: string[] = [];
  private readonly requests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly config: AgentConfig) {}
  async start() {
    await mkdir(resolve(this.config.dataDir, 'cache'), { recursive: true });
    try { this.emergencyStopped = JSON.parse(await readFile(resolve(this.config.dataDir, 'control-state.json'), 'utf8')).emergencyStopped === true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.emergencyStopped = true; console.error('制动状态文件损坏，保持制动:', (error as Error).message); } }
    try { this.journal = JSON.parse(await readFile(resolve(this.config.dataDir, 'journal.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (process.platform !== 'win32') await unlink(this.config.pipe).catch(() => {});
    this.server = createServer(socket => this.localWorker(socket));
    await new Promise<void>((accept, reject) => {
      this.server!.once('error', reject);
      // Windows service and desktop Worker run under different accounts.
      // The protected ipcSecret still authenticates every local connection.
      this.server!.listen({ path: this.config.pipe,
        readableAll: process.platform === 'win32', writableAll: process.platform === 'win32' }, accept);
    });
    this.consoleServer = new LocalConsoleServer(this.config.dataDir, this.config.ipcSecret, { state: () => this.consoleState(), brake: blocked => this.setBrake(blocked), configure: (endpoint, token) => this.configureEndpoint(endpoint, token), control: (action, volume) => this.manualControl(action, volume), secrets: () => [this.config.token, ...this.previousTokens] });
    await this.consoleServer.start();
    this.connect();
    this.interval = setInterval(() => {
      if (performance.now() > this.leaseUntil) this.pendingStart?.abort.abort();
      if (this.welcomed) { this.send({ type: 'heartbeat', ...this.wireState() }); for (const event of this.journal.events) this.send(event); }
    }, 5000);
    console.log('设备服务已启动，等待用户会话中的播放器。');
  }
  private localWorker(socket: Socket) {
    let authenticated = false; let input = '';
    const handshake = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString(); if (input.length > 100000) { socket.destroy(); return; }
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          if (!authenticated) {
            if (data.type !== 'worker-hello' || data.secret !== this.config.ipcSecret || this.worker) { socket.destroy(); return; }
            authenticated = true; clearTimeout(handshake); this.worker = socket; this.updateState(data.state); this.localLease();
            socket.write(JSON.stringify({ type: 'emergency-stop', blocked: this.emergencyStopped, secret: this.config.ipcSecret }) + '\n');
            console.log(new Date().toISOString(), '用户播放器已连接。'); continue;
          }
          if (this.worker !== socket) return;
          if (data.type === 'status') this.updateState(data.state);
          if (data.type === 'playback') { const parsed = AgentMessageSchema.safeParse(data); if (parsed.success && parsed.data.type === 'playback') void this.event(parsed.data).catch(console.error); }
          if (data.type === 'result') {
            const requestId = String(data.requestId); const request = this.requests.get(requestId);
            if (request) { clearTimeout(request.timer); this.requests.delete(requestId); if (data.ok === true) request.resolve(); else request.reject(new Error(String(data.error ?? '播放器拒绝指令'))); }
          }
        } catch { socket.destroy(); }
      }
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      if (this.worker === socket) { this.worker = undefined; const current = this.state.playbackId; this.state = { ready: false, playbackId: null, position: 0, paused: false }; if (current) void this.event({ type: 'playback', eventId: randomUUID(), playbackId: current, state: 'failed', error: '用户播放器已断开' }).catch(console.error); }
    });
  }
  private updateState(value: unknown) {
    const data = value as Partial<PlayerState>;
    if (typeof data?.ready === 'boolean' && (data.playbackId === null || typeof data.playbackId === 'string') && typeof data.position === 'number' && Number.isFinite(data.position)) this.state = { ready: data.ready, playbackId: data.playbackId, started: typeof data.started === 'boolean' ? data.started : !!data.playbackId, position: Math.max(0, data.position), paused: !!data.paused, durationSeconds: typeof data.durationSeconds === 'number' && Number.isFinite(data.durationSeconds) ? Math.max(0, data.durationSeconds) : 0, seekable: data.seekable === true, recovering: data.recovering === true };
    if (typeof data?.filename === 'string') this.activeFile = data.filename;
    else if (data?.playbackId === null) this.activeFile = undefined;
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/ws/agents', this.config.serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 64000, handshakeTimeout: 15000 }); this.socket = socket;
    socket.on('open', () => { this.retries = 0; console.log(new Date().toISOString(), 'WebSocket 已连接服务器。'); this.send({ type: 'hello', v: 1, ...this.wireState(), version: '0.1.4', capabilities: ['seek'], bootId: this.bootId }); });
    socket.on('error', error => console.error('连接失败:', error.message));
    let handling = Promise.resolve();
    socket.on('message', raw => {
      handling = handling.then(async () => {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === 'overview') { this.overview = data; return; }
        if (data.type === 'welcome' || data.type === 'lease') {
          if (!Number.isInteger(data.epoch) || Number(data.epoch) < 1 || typeof data.leaseMs !== 'number' || !Number.isFinite(data.leaseMs) || data.leaseMs <= 0) throw new Error('无效连接租约');
          if (data.type === 'welcome') { if (typeof data.agentId !== 'string' || typeof data.zoneId !== 'string') throw new Error('无效设备身份'); this.agentId = data.agentId; this.zoneId = data.zoneId; this.epoch = Number(data.epoch); this.welcomed = true; console.log(new Date().toISOString(), '服务器已确认设备身份。'); }
          if (data.epoch !== this.epoch) return;
          this.leaseUntil = performance.now() + Math.min(60000, data.leaseMs); this.localLease(); return;
        }
        if (data.type === 'event-ack') { this.journal.events = this.journal.events.filter(e => e.eventId !== data.eventId); await this.save(); return; }
        const parsed = WireCommandSchema.safeParse(data); if (!parsed.success || !this.welcomed) return;
        await this.accept(parsed.data);
      }).catch(error => { console.error('协议错误:', error instanceof Error ? error.message : error); socket.close(1008, 'protocol error'); });
    });
    socket.on('close', () => { this.welcomed = false; this.pendingStart?.abort.abort(); if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)) + Math.random() * 500); });
  }
  private async accept(command: WireCommand) {
    if (this.stopped) return;
    if (command.agentId !== this.agentId || command.zoneId !== this.zoneId || command.epoch !== this.epoch || Date.parse(command.expiresAt) <= Date.now()) { this.send({ type: 'ack', commandId: command.id, status: 'rejected', error: '设备身份或指令期限不正确' }); return; }
    if (this.journal.commands.includes(command.id)) { this.send({ type: 'ack', commandId: command.id, status: 'duplicate' }); return; }
    if (!this.worker || command.payload.action !== 'stop' && (this.emergencyStopped || !this.state.ready)) { this.send({ type: 'ack', commandId: command.id, status: 'rejected', error: this.emergencyStopped ? '本机已紧急制动，请在桌面控制台解除' : '用户会话播放器尚未就绪' }); return; }
    if (command.payload.action === 'seek' && (command.payload.playbackId !== this.state.playbackId || !this.state.started || !this.state.seekable)) { this.send({ type: 'ack', commandId: command.id, status: 'rejected', error: '当前播放任务已改变或不可调整进度' }); return; }
    this.journal.commands = [...this.journal.commands.slice(-499), command.id]; await this.save();
    this.send({ type: 'ack', commandId: command.id, status: 'accepted' });
    if (command.payload.action === 'start') {
      this.pendingStart?.abort.abort(); const abort = new AbortController(); this.pendingStart = { command, abort };
      const job = this.startPlayback(command, abort).catch(error => this.event({ type: 'playback', eventId: randomUUID(), playbackId: (command.payload as { playbackId: string }).playbackId, state: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : '下载失败' })).catch(console.error).finally(() => this.starts.delete(job));
      this.starts.add(job);
    } else {
      if (command.payload.action === 'stop') this.pendingStart?.abort.abort();
      void this.localCommand(command.payload).catch(error => console.error('播放控制失败:', error instanceof Error ? error.message : error));
    }
  }
  private async startPlayback(command: WireCommand, abort: AbortController) {
    const payload = command.payload; if (payload.action !== 'start') return;
    this.currentPlaybackId = payload.playbackId;
    this.currentTrack = { title: payload.title ?? '正在准备歌曲', artists: payload.artists ?? [], durationSeconds: payload.durationSeconds ?? 0 };
    const filename = resolve(this.config.dataDir, 'cache', `${payload.sha256}.audio`);
    let valid = false;
    try { valid = (await stat(filename)).size === payload.bytes && await hashAudio(filename) === payload.sha256; } catch { /* first download */ }
    if (!valid) {
      const url = new URL(`/api/v1/media/${encodeURIComponent(payload.assetId)}`, this.config.serverUrl); url.searchParams.set('ticket', payload.ticket);
      const temporary = filename + '.' + createHash('sha256').update(command.id).digest('hex').slice(0, 16) + '.tmp'; const file = await open(temporary, 'wx');
      try {
        const started = Date.now(); console.log(new Date().toISOString(), '开始下载缓存音频:', payload.bytes, 'bytes');
        await downloadCachedAudio(url, this.config.token, file, payload.bytes, abort.signal, progress => { this.transfer = progress; });
        await file.close(); if (await hashAudio(temporary) !== payload.sha256) throw new Error('下载音频校验失败'); await rename(temporary, filename);
        console.log(new Date().toISOString(), '缓存音频下载完成:', payload.bytes, 'bytes', Date.now() - started, 'ms');
      } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
      finally { this.transfer = null; }
    }
    if (this.emergencyStopped || abort.signal.aborted || command.epoch !== this.epoch || !this.welcomed || performance.now() > this.leaseUntil) throw new Error('播放任务已取消或连接已过期');
    await this.localCommand({ ...payload, filename });
    await utimes(filename, new Date(), new Date()).catch(() => {});
    await this.evictCache(filename).catch(error => console.error('缓存清理失败:', error instanceof Error ? error.message : error));
    if (this.pendingStart?.command.id === command.id) this.pendingStart = undefined;
  }
  private localCommand(payload: unknown) {
    if (!this.worker || this.worker.destroyed) return Promise.reject(new Error('播放器未连接'));
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error('播放器响应超时')); }, 15000);
      this.requests.set(requestId, { resolve, reject, timer }); this.worker!.write(JSON.stringify({ ...payload as object, requestId, epoch: this.epoch, secret: this.config.ipcSecret }) + '\n');
    });
  }
  private async evictCache(protectedFile: string) {
    const directory = resolve(this.config.dataDir, 'cache');
    const assets = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.audio$/.test(name)).map(async name => { const filename = resolve(directory, name); const info = await stat(filename); return { filename, bytes: info.size, modified: info.mtimeMs }; }));
    let total = assets.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of assets.sort((a, b) => a.modified - b.modified)) if (total > this.config.cacheMaxMb * 1024 * 1024 && item.filename !== protectedFile && item.filename !== this.activeFile) { try { await unlink(item.filename); total -= item.bytes; } catch { /* a file still held by mpv is retained */ } }
  }
  private localLease() { if (this.worker && this.welcomed && performance.now() < this.leaseUntil) this.worker.write(JSON.stringify({ type: 'lease', epoch: this.epoch, leaseMs: this.leaseUntil - performance.now(), secret: this.config.ipcSecret }) + '\n'); }
  private async event(event: PlaybackEvent) { if (event.state !== 'started' && event.playbackId === this.currentPlaybackId) { this.currentTrack = null; this.currentPlaybackId = null; } this.journal.events.push(event); await this.save(); if (this.welcomed) this.send(event); }
  private wireState() { return { ...this.state, ready: this.state.ready && !this.emergencyStopped }; }
  consoleState() { return { version: '0.1.4', endpoint: this.config.serverUrl, serverConnected: this.socket?.readyState === WebSocket.OPEN, authorized: this.welcomed, playerConnected: !!this.worker && !this.worker.destroyed, playerReady: this.state.ready, emergencyStopped: this.emergencyStopped, playbackId: this.state.playbackId, started: this.state.started, position: this.state.position, durationSeconds: this.state.durationSeconds, seekable: this.state.seekable, recovering: this.state.recovering, paused: this.state.paused, current: this.currentTrack, transfer: this.transfer, overview: this.overview }; }
  async setBrake(blocked: boolean) {
    const version = ++this.brakeVersion;
    if (blocked) { this.emergencyStopped = true; this.pendingStart?.abort.abort(); this.send({ type: 'heartbeat', ...this.wireState() }); if (this.worker) void this.localCommand({ type: 'emergency-stop', blocked: true }).catch(error => console.error('本机制动 IPC:', error.message)); }
    const persist = this.controlSaving.then(async () => { const filename = resolve(this.config.dataDir, 'control-state.json'); await import('node:fs/promises').then(fs => fs.writeFile(filename + '.tmp', JSON.stringify({ emergencyStopped: blocked }), { mode: 0o600 })); await rename(filename + '.tmp', filename); });
    this.controlSaving = persist.catch(() => {}); await persist;
    if (version !== this.brakeVersion) return;
    this.emergencyStopped = blocked;
    if (this.worker && !blocked) await this.localCommand({ type: 'emergency-stop', blocked: false });
    this.send({ type: 'heartbeat', ...this.wireState() }); console.log(new Date().toISOString(), blocked ? '本机紧急制动已锁定。' : '本机制动已解除。');
  }
  async configureEndpoint(endpoint: string, token?: string) {
    const next = parseConfig({ ...this.config, serverUrl: endpoint, token: token?.trim() || this.config.token }, resolve(this.config.dataDir, 'agent.config.json'));
    await this.setBrake(true);
    const filename = resolve(this.config.dataDir, 'agent.config.json'); await import('node:fs/promises').then(fs => fs.writeFile(filename + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 })); await rename(filename + '.tmp', filename);
    this.previousTokens.push(this.config.token); this.config.serverUrl = next.serverUrl; this.config.token = next.token; this.overview = null;
    this.welcomed = false; this.pendingStart?.abort.abort(); this.socket?.terminate(); console.log(new Date().toISOString(), '服务器端点已更新，重新连接。');
  }
  private async manualControl(action: 'pause' | 'resume' | 'volume' | 'seek', value?: number) {
    if (this.emergencyStopped) throw new Error('请先解除本机制动');
    if (action === 'volume') { if (value === undefined) throw new Error('请填写音量'); await this.localCommand({ action, volume: value }); }
    else if (action === 'seek') { if (!this.state.playbackId || !this.state.started || !this.state.seekable || !this.state.ready) throw new Error('当前歌曲尚不可调整进度'); await this.localCommand({ action, playbackId: this.state.playbackId, position: value }); }
    else { if (!this.state.playbackId) throw new Error('当前没有播放歌曲'); await this.localCommand({ action, playbackId: this.state.playbackId }); }
  }
  private save() { const snapshot = JSON.stringify(this.journal); const filename = resolve(this.config.dataDir, 'journal.json'); const task = this.saving.then(async () => { await import('node:fs/promises').then(fs => fs.writeFile(filename + '.tmp', snapshot, { mode: 0o600 })); await rename(filename + '.tmp', filename); }); this.saving = task.catch(() => {}); return task; }
  private send(value: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  async close() { this.stopped = true; if (this.interval) clearInterval(this.interval); if (this.reconnect) clearTimeout(this.reconnect); this.pendingStart?.abort.abort(); this.socket?.terminate(); this.worker?.destroy(); for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(new Error('服务关闭')); } this.requests.clear(); await this.consoleServer?.close(); await new Promise<void>(accept => this.server ? this.server.close(() => accept()) : accept()); await Promise.allSettled(this.starts); await this.saving; await this.controlSaving; }
}
async function hashAudio(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
