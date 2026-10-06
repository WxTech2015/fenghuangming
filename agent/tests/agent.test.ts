import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer, WebSocket } from '../node_modules/ws';
import { loadConfig } from '../src/config';
import { AgentService } from '../src/service';

it('Agent 通过非 localhost 的 HTTP / WS 地址下载、校验、执行 IPC，并拒绝重复/过期指令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-agent-')); const audio = Buffer.alloc(4096, 7); const sha256 = createHash('sha256').update(audio).digest('hex');
  const token = 'test-device-token-'.repeat(4); let mediaAuthorization = ''; const received: any[] = []; const workerCommands: any[] = [];
  const http = createServer((req, res) => { mediaAuthorization = req.headers.authorization ?? ''; res.writeHead(200, { 'Content-Length': audio.length }); res.end(audio); });
  const wss = new WebSocketServer({ server: http }); let peer: WebSocket | undefined;
  wss.on('connection', socket => { peer = socket; socket.on('message', raw => { const data = JSON.parse(raw.toString()); received.push(data); if (data.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', v: 1, epoch: 1, agentId: 'agent_test', zoneId: 'zone_test', leaseMs: 60000 })); if (data.type === 'playback') socket.send(JSON.stringify({ type: 'event-ack', eventId: data.eventId })); }); });
  // A loopback alias exercises the formerly rejected non-localhost URL without exposing a test port.
  http.listen(0, '127.0.0.2'); await once(http, 'listening');
  const filename = join(directory, 'config.json'); await writeFile(filename, JSON.stringify({ serverUrl: `http://127.0.0.2:${(http.address() as AddressInfo).port}`, token, mpvPath: 'C:\\Tools\\mpv.exe', dataDir: directory }));
  const config = await loadConfig(filename); const service = new AgentService(config); await service.start();
  const worker = connect(config.pipe); let input = ''; await once(worker, 'connect');
  worker.write(JSON.stringify({ type: 'worker-hello', secret: config.ipcSecret, state: { ready: true, playbackId: null, position: 0, paused: false } }) + '\n');
  worker.on('data', chunk => { input += chunk.toString(); let newline: number; while ((newline = input.indexOf('\n')) >= 0) { const data = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); if (data.requestId) { workerCommands.push(data); worker.write(JSON.stringify({ type: 'result', requestId: data.requestId, ok: true }) + '\n'); if (data.action === 'start') worker.write(JSON.stringify({ type: 'playback', eventId: 'worker-started', playbackId: data.playbackId, state: 'started' }) + '\n'); } } });
  try {
    await waitUntil(() => received.some(x => (x.type === 'heartbeat' || x.type === 'hello') && x.ready));
    const command = { v: 1, kind: 'command', id: 'cmd_test', agentId: 'agent_test', zoneId: 'zone_test', epoch: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { action: 'start', playbackId: 'play_test', queueItemId: 'item_test', assetId: 'asset_test', ticket: 'ticket', sha256, bytes: audio.length, mime: 'audio/wav', volume: 50 } };
    peer!.send(JSON.stringify(command)); peer!.send(JSON.stringify(command));
    await waitUntil(() => received.some(x => x.type === 'playback' && x.state === 'started'));
    expect(workerCommands.filter(x => x.action === 'start')).toHaveLength(1); expect(received.some(x => x.type === 'ack' && x.status === 'duplicate')).toBe(true);
    expect(mediaAuthorization).toBe(`Bearer ${token}`); expect(await readFile(workerCommands[0].filename)).toEqual(audio);
    peer!.send(JSON.stringify({ ...command, id: 'cmd_expired', expiresAt: '2000-01-01T00:00:00.000Z' }));
    peer!.send(JSON.stringify({ ...command, id: 'cmd_wrong_agent', agentId: 'agent_other' }));
    await waitUntil(() => received.filter(x => x.type === 'ack' && x.status === 'rejected').length === 2);
    expect(workerCommands.filter(x => x.action === 'start')).toHaveLength(1);
    worker.write(JSON.stringify({ type: 'status', state: { ready: false, playbackId: 'play_test', started: true, recovering: true, position: 17, paused: false } }) + '\n');
    await waitUntil(() => service.consoleState().playerReady === false);
    peer!.send(JSON.stringify({ ...command, id: 'cmd_stop_recovery', payload: { action: 'stop', playbackId: 'play_test' } }));
    await waitUntil(() => workerCommands.some(x => x.action === 'stop' && x.playbackId === 'play_test'));
    expect(received.some(x => x.type === 'ack' && x.commandId === 'cmd_stop_recovery' && x.status === 'accepted')).toBe(true);
  } finally { worker.destroy(); await service.close(); peer?.terminate(); wss.close(); await new Promise<void>(done => http.close(() => done())); if (!directory.startsWith(join(tmpdir(), 'qqmusic-agent-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
}, 20000);
async function waitUntil(check: () => boolean, timeout = 10000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('等待 Agent 状态超时'); await new Promise(r => setTimeout(r, 20)); } }
