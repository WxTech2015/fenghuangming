import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { AgentService } from '../src/service';
import { parseConfig } from '../src/config';
it('制动持久化、重启保持，端点修改保留本机 IPC 凭证并自动保持制动', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-brake-'));
  const http = createServer(); const wss = new WebSocketServer({ server: http }); const peers: import('ws').WebSocket[] = [];
  wss.on('connection', socket => peers.push(socket)); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: 'fixture-token-'.repeat(4), ipcSecret: createHash('sha256').update(directory).digest('hex'), mpvPath: 'mpv.exe', dataDir: directory }, join(directory, 'agent.config.json'));
  let service = new AgentService(config); await service.start();
  try {
    await service.setBrake(true); expect(service.consoleState().emergencyStopped).toBe(true); await service.close();
    service = new AgentService(config); await service.start(); expect(service.consoleState().emergencyStopped).toBe(true);
    await service.setBrake(false); expect(service.consoleState().emergencyStopped).toBe(false);
    const secret = config.ipcSecret; await expect(service.configureEndpoint(config.serverUrl + '/api')).rejects.toThrow('根地址');
    await service.configureEndpoint(config.serverUrl, 'replacement-token-'.repeat(3)); expect(config.ipcSecret).toBe(secret); expect(service.consoleState().emergencyStopped).toBe(true);
    const saved = JSON.parse(await readFile(join(directory, 'agent.config.json'), 'utf8')); expect(saved.ipcSecret).toBe(secret); expect(saved.token).toBe('replacement-token-'.repeat(3));
  } finally { await service.close(); peers.forEach(peer => peer.terminate()); wss.close(); await new Promise<void>(ok => http.close(() => ok())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-brake-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
});

it('远程整数秒跳转进入当前 Worker，拒绝旧歌曲与制动后的指令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-remote-seek-'));
  const http = createServer(); const wss = new WebSocketServer({ server: http }); let peer: import('ws').WebSocket; const reports: any[] = [];
  wss.on('connection', socket => { peer = socket; socket.on('message', raw => { const value = JSON.parse(raw.toString()); reports.push(value); if (value.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', v: 1, epoch: 1, agentId: 'agent_test', zoneId: 'zone_test', leaseMs: 60000 })); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const config = parseConfig({ serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: 'fixture-token-'.repeat(4), ipcSecret: createHash('sha256').update(directory).digest('hex'), mpvPath: 'mpv.exe', dataDir: directory }, join(directory, 'agent.config.json'));
  const service = new AgentService(config); await service.start(); const worker = connect(config.pipe); const received: any[] = [];
  try {
    await once(worker, 'connect');
    const state = { ready: true, playbackId: 'play_current', started: true, position: 10, paused: true, durationSeconds: 60, seekable: true };
    worker.write(JSON.stringify({ type: 'worker-hello', secret: config.ipcSecret, state }) + '\n');
    let input = ''; worker.on('data', raw => { input += raw.toString(); let newline; while ((newline = input.indexOf('\n')) >= 0) { const value = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); if (value.requestId) { received.push(value); worker.write(JSON.stringify({ type: 'result', requestId: value.requestId, ok: true }) + '\n'); } } });
    await vi.waitFor(() => expect(service.consoleState()).toMatchObject({ authorized: true, playerReady: true }));
    expect(reports.find(report => report.type === 'hello').capabilities).toEqual(['seek']);
    const send = (id: string, playbackId = 'play_current') => peer!.send(JSON.stringify({ v: 1, kind: 'command', id, agentId: 'agent_test', zoneId: 'zone_test', epoch: 1, expiresAt: new Date(Date.now() + 10000).toISOString(), payload: { action: 'seek', playbackId, position: 21 } }));
    send('valid'); await vi.waitFor(() => expect(received.some(value => value.action === 'seek' && value.playbackId === 'play_current' && value.position === 21)).toBe(true));
    send('old', 'play_old'); await vi.waitFor(() => expect(reports.some(value => value.commandId === 'old' && value.status === 'rejected')).toBe(true));
    await service.setBrake(true); send('braked'); await vi.waitFor(() => expect(reports.some(value => value.commandId === 'braked' && value.status === 'rejected')).toBe(true));
    expect(received.filter(value => value.action === 'seek')).toHaveLength(1);
  } finally { worker.destroy(); await service.close(); peer!?.terminate(); wss.close(); await new Promise<void>(ok => http.close(() => ok())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-remote-seek-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
});
