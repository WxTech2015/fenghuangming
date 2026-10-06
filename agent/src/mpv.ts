import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
export class Mpv extends EventEmitter {
  private process?: ChildProcess;
  private socket?: Socket;
  private sequence = 0;
  private unavailable = false;
  private closing = false;
  private stderr = '';
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly executable: string, readonly pipe: string) { super(); }
  async start() {
    if (process.platform !== 'win32') await unlink(this.pipe).catch(() => {});
    this.process = spawn(this.executable, ['--idle=yes', '--no-video', '--no-config', '--terminal=yes', '--msg-level=all=warn', '--audio-display=no', '--audio-device=auto', '--audio-exclusive=no', `--input-ipc-server=${this.pipe}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const output = (chunk: Buffer) => { const line = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').trim(); if (line) { this.stderr = (this.stderr + '\n' + line).slice(-2000); this.emit('log', line.slice(-2000)); } };
    this.process.stdout?.on('data', output); this.process.stderr?.on('data', output);
    let launchError: Error | undefined; this.process.on('error', error => { launchError = error; this.markUnavailable(error.message); });
    this.process.on('exit', (code, signal) => { launchError ??= new Error(`mpv 已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）${this.stderr ? ': ' + this.stderr : ''}`); this.markUnavailable(launchError.message); this.socket?.destroy(); });
    for (let i = 0; i < 50; i++) {
      if (launchError) throw launchError;
      if (this.closing) throw new Error('mpv 已停止');
      try { this.socket = await new Promise<Socket>((accept, reject) => { const socket = connect(this.pipe); socket.once('connect', () => accept(socket)); socket.once('error', reject); }); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!this.socket) { this.process.kill(); throw new Error('无法连接 mpv IPC，请检查 mpvPath'); }
    let input = '';
    this.socket.on('error', () => {});
    this.socket.on('close', () => { for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('mpv 已断开')); } this.requests.clear(); this.markUnavailable('mpv IPC 已断开'); });
    this.socket.on('data', chunk => {
      input += chunk.toString(); if (input.length > 1000000) { this.socket?.destroy(); return; }
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const data = JSON.parse(line) as { request_id?: number; error?: string; data?: unknown; event?: string };
          if (data.request_id) { const request = this.requests.get(data.request_id); if (request) { clearTimeout(request.timer); this.requests.delete(data.request_id); if (data.error && data.error !== 'success') request.reject(new Error(`mpv: ${data.error}`)); else request.resolve(data.data); } }
          if (data.event) this.emit('event', data);
        } catch { /* ignore malformed IPC data */ }
      }
    });
    for (const [index, property] of ['time-pos', 'pause', 'duration', 'seekable', 'audio-device-list', 'current-ao'].entries()) await this.command(['observe_property', index + 1, property]);
  }
  command(command: unknown[]): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('mpv 未就绪'));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error('mpv 控制超时')); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer }); this.socket!.write(JSON.stringify({ command, request_id: requestId }) + '\n');
    });
  }
  private markUnavailable(reason: string) { if (this.unavailable || this.closing) return; this.unavailable = true; this.emit('unavailable', reason); }
  close() { this.closing = true; this.socket?.destroy(); this.process?.kill(); }
}
