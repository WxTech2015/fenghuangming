import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { open, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
export interface ConsoleActions {
  state(): unknown;
  brake(blocked: boolean): Promise<void>;
  configure(endpoint: string, token?: string): Promise<void>;
  control(action: 'pause' | 'resume' | 'volume' | 'seek', value?: number): Promise<void>;
  secrets(): string[];
}
export class LocalConsoleServer {
  private server?: Server;
  port = 0;
  constructor(readonly directory: string, readonly secret: string, readonly actions: ConsoleActions) {}
  async start() {
    this.server = createServer((req, res) => {
      void (async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        const credential = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? ''); const expected = Buffer.from(this.secret);
        if (req.headers.origin || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || credential.length !== expected.length || !timingSafeEqual(credential, expected)) { res.writeHead(401); res.end('{"error":"本机控制凭证无效"}'); return; }
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && path === '/state') { res.end(JSON.stringify(this.actions.state())); return; }
        if (req.method === 'GET' && path === '/logs') { res.end(JSON.stringify({ text: await this.logs() })); return; }
        if (req.method !== 'POST') { res.writeHead(404); res.end('{"error":"接口不存在"}'); return; }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('请求过大'); chunks.push(Buffer.from(chunk)); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (path === '/brake' && typeof body.blocked === 'boolean') await this.actions.brake(body.blocked);
        else if (path === '/config' && typeof body.endpoint === 'string' && (body.token === undefined || typeof body.token === 'string')) await this.actions.configure(body.endpoint, body.token);
        else if (path === '/control' && body.action === 'seek' && Number.isInteger(body.position) && body.position >= 0 && body.position <= 86400) await this.actions.control('seek', body.position);
        else if (path === '/control' && (body.action === 'pause' || body.action === 'resume')) await this.actions.control(body.action);
        else if (path === '/control' && body.action === 'volume' && Number.isInteger(body.volume) && body.volume >= 0 && body.volume <= 100) await this.actions.control('volume', body.volume);
        else { res.writeHead(400); res.end('{"error":"控制参数无效"}'); return; }
        res.end('{"ok":true}');
      })().catch(error => { if (!res.headersSent) res.writeHead(400); if (!res.destroyed) res.end(JSON.stringify({ error: this.redact(error instanceof Error ? error.message : '操作失败') })); });
    });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    this.server.on('connection', socket => socket.setTimeout(5000, () => socket.destroy()));
    await new Promise<void>((ok, fail) => { this.server!.once('error', fail); this.server!.listen(0, '127.0.0.1', ok); });
    this.port = (this.server.address() as import('node:net').AddressInfo).port;
    const filename = resolve(this.directory, 'control-info.json'); await writeFile(filename + '.tmp', JSON.stringify({ port: this.port, version: '0.1.4' }), { mode: 0o600 }); await rename(filename + '.tmp', filename);
  }
  private redact(text: string) {
    for (const secret of [this.secret, ...this.actions.secrets()].filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(ticket=)[^\s&"']+/gi, '$1[REDACTED]').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
  }
  private async logs() {
    const lines: string[] = [];
    for (const name of ['service.log', 'service-error.log', 'player.log', 'player-error.log']) {
      let file;
      try { file = await open(resolve(this.directory, name), 'r'); const info = await file.stat(); const buffer = Buffer.alloc(Math.min(info.size, 32768)); await file.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length)); lines.push(`--- ${name} ---\n${buffer.toString('utf8')}`); } catch { /* first run has no log file yet */ }
      finally { await file?.close(); }
    }
    return this.redact(lines.join('\n'));
  }
  async close() { await new Promise<void>(ok => { if (!this.server) { ok(); return; } this.server.close(() => ok()); this.server.closeAllConnections(); }); }
}
