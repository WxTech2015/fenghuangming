import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from '../node_modules/ws';
import { TrackSchema } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { createApplication } from '../src/app';
import { GoMusicDlProvider, MusicService } from '../src/music/providers';

function wav() {
  const bytes = 6 * 8000 * 2; const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(bytes + 36, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
describe('真实 HTTP + WebSocket + 下载缓存链路', () => {
  let backend: Awaited<ReturnType<typeof createApplication>>; let base = ''; let cookie = ''; let directory = ''; let engine: Server; let engineBase = ''; let requestedPath = ''; const audio = wav();
  const peers: WebSocket[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qqmusic-integration-'));
    engine = createServer((req, res) => { requestedPath = req.url ?? ''; res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }); res.end(audio); });
    engine.listen(0, '127.0.0.1'); await once(engine, 'listening'); engineBase = `http://127.0.0.1:${(engine.address() as AddressInfo).port}/music`;
    backend = await createApplication({ store: await new FileStore().init(), dataDir: directory, auth: { username: 'admin', password: 'test-password', secret: 'a'.repeat(40), secure: false }, botToken: 'test-onebot-token', logger: false, metadata: null, manageMusic: false, music: new MusicService([new GoMusicDlProvider()], { original: async function* () {} }) });
    await backend.app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${(backend.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { for (const p of peers) p.terminate(); await backend?.close(); await new Promise<void>(done => engine?.close(() => done())); if (!directory.startsWith(join(tmpdir(), 'qqmusic-integration-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); });
  async function request(path: string, method = 'GET', body?: unknown) { return fetch(base + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  it('管理员认证与来源检查', async () => {
    expect((await request('/snapshot')).status).toBe(401);
    expect((await fetch(base + '/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) })).status).toBe(403);
    const response = await request('/login', 'POST', { username: 'admin', password: 'test-password' }); expect(response.status).toBe(201); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await request('/snapshot')).status).toBe(200);
    expect((await request('/settings', 'PUT', { dailyJumpLimit: -1 })).status).toBe(400);
  });
  it('入队→下载→确认接收→实际开始→结束；媒体鉴权和重复事件', async () => {
    await request('/settings', 'PUT', { gomusicdl: { mode: 'external', baseUrl: engineBase } });
    const registered = await (await request('/agents', 'POST', { name: '测试电脑', zoneId: 'zone_default' })).json() as { agent: { id: string }; token: string };
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/agents', { headers: { Authorization: `Bearer ${registered.token}` } }); peers.push(ws);
    const commands: any[] = []; let welcomed = false;
    ws.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'welcome') welcomed = true; if (value.kind === 'command') commands.push(value); });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', v: 1, ready: true, version: '0.1.4', capabilities: ['seek'], bootId: 'test', playbackId: null, position: 0 }));
    await waitUntil(() => welcomed);
    const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '六秒测试音频', durationSeconds: 6 });
    const item = await (await request('/queue', 'POST', { zoneId: 'zone_default', requestKey: 'integration-request', userId: '12345', track })).json() as { id: string };
    await backend.context.playback.tick();
    const prepared = (await backend.context.system.snapshot()).queue.find(x => x.id === item.id);
    expect(prepared?.error).toBeNull(); expect(prepared?.status).toBe('dispatching');
    await backend.context.gateway.flush();
    await waitUntil(() => commands.length > 0, 10000); const command = commands.find(c => c.payload.action === 'start'); expect(command).toBeDefined();
    expect(requestedPath).toContain('/music/download?'); expect(requestedPath).toContain('stream=1');
    const assetId = command.payload.assetId; expect((await fetch(base + '/api/v1/media/' + assetId)).status).toBe(401);
    const media = await fetch(base + `/api/v1/media/${assetId}?ticket=${command.payload.ticket}`, { headers: { Authorization: `Bearer ${registered.token}`, Range: 'bytes=0-43' } }); expect(media.status).toBe(206); expect(Buffer.from(await media.arrayBuffer())).toEqual(audio.subarray(0, 44));
    ws.send(JSON.stringify({ type: 'ack', commandId: command.id, status: 'accepted' }));
    await new Promise(r => setTimeout(r, 30)); expect((await backend.context.system.snapshot()).queue.find(x => x.id === item.id)?.status).toBe('dispatching');
    ws.send(JSON.stringify({ type: 'playback', eventId: 'started', playbackId: command.payload.playbackId, state: 'started' }));
    await waitUntil(async () => (await backend.context.system.snapshot()).queue.find(x => x.id === item.id)?.status === 'playing');
    ws.send(JSON.stringify({ type: 'heartbeat', ready: true, playbackId: command.payload.playbackId, started: true, position: 2, paused: true, durationSeconds: 6, seekable: true }));
    await waitUntil(async () => (await backend.context.system.snapshot()).agents[0]?.seekable === true);
    expect((await backend.context.system.snapshot()).agents[0]).toMatchObject({ supportsSeek: true, durationSeconds: 6, playbackId: command.payload.playbackId, position: 2, paused: true });
    const seek = (position: unknown, playbackId = command.payload.playbackId) => request('/zones/zone_default/control', 'POST', { action: 'seek', position, playbackId });
    expect((await seek(4)).status).toBe(201);
    await waitUntil(() => commands.some(c => c.payload.action === 'seek'));
    const seekCommand = commands.find(c => c.payload.action === 'seek'); expect(seekCommand.payload).toEqual({ action: 'seek', position: 4, playbackId: command.payload.playbackId });
    expect(Date.parse(seekCommand.expiresAt) - Date.now()).toBeLessThanOrEqual(10000);
    // 模拟本轮派发已读取旧命令快照，新跳转不能等五秒后的定时器。
    const store = backend.context.gateway.store; const originalTransaction = store.transaction.bind(store);
    let releaseFlush!: () => void; let snapshotReady!: () => void;
    const blocked = new Promise<void>(resolve => { releaseFlush = resolve; });
    const captured = new Promise<void>(resolve => { snapshotReady = resolve; });
    const transaction = vi.spyOn(store, 'transaction').mockImplementationOnce(async work => { const result = await originalTransaction(work); snapshotReady(); await blocked; return result; });
    const inFlight = backend.context.gateway.flush(true);
    try {
      await captured;
      const response = seek(3);
      await waitUntil(async () => (await originalTransaction(tx => tx.all('command'))).some(c => c.payload.action === 'seek' && c.payload.position === 3));
      releaseFlush(); await inFlight; expect((await response).status).toBe(201);
      await waitUntil(() => commands.some(c => c.payload.action === 'seek' && c.payload.position === 3), 1000);
    } finally { releaseFlush(); await inFlight; transaction.mockRestore(); }
    for (const invalid of [-1, 0.5, 6, '4']) expect((await seek(invalid)).status).toBe(400);
    expect((await seek(4, 'old-playback')).status).toBe(400);
    const live = backend.context.events.agentPlayback.get(registered.agent.id)!; live.supportsSeek = false;
    const unsupported = await seek(4); expect(unsupported.status).toBe(400); expect((await unsupported.json()).code).toBe('SEEK_UNSUPPORTED'); live.supportsSeek = true;
    for (let i = 0; i < 2; i++) ws.send(JSON.stringify({ type: 'playback', eventId: 'ended', playbackId: command.payload.playbackId, state: 'ended' }));
    await waitUntil(async () => (await backend.context.system.snapshot()).queue.find(x => x.id === item.id)?.status === 'completed');
    const snapshot = await backend.context.system.snapshot(); expect(snapshot.zones[0]?.currentItemId).toBeNull(); expect(snapshot.agents[0]).not.toHaveProperty('tokenHash'); expect(snapshot.audit.filter(a => a.action === 'playback.completed')).toHaveLength(1);
  }, 20000);
  it('NapCat 忽略未绑定群，绑定群的重复卡片只入队一次', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/onebot', { headers: { Authorization: 'Bearer test-onebot-token' } }); peers.push(ws);
    ws.on('message', raw => { const action = JSON.parse(raw.toString()); if (action.action === 'get_login_info' || action.action === 'get_group_list') ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: action.action === 'get_login_info' ? { user_id: 555, nickname: '测试 NapCat' } : [{ group_id: 666, group_name: '点歌群' }] })); });
    await once(ws, 'open');
    await waitUntil(async () => (await backend.context.system.snapshot()).bots[0]?.groups.length === 1);
    const card = { post_type: 'message', message_type: 'group', self_id: 555, group_id: 666, user_id: 777, message_id: 999, sender: { nickname: '点歌人' }, message: [{ type: 'music', data: { type: '163', id: 456, title: '来自群聊的歌' } }] };
    ws.send(JSON.stringify(card)); await new Promise(r => setTimeout(r, 50)); expect((await backend.context.system.snapshot()).queue.some(x => x.track.externalId === '456')).toBe(false);
    await request('/bindings', 'POST', { botId: '555', groupId: '666', zoneId: 'zone_default' }); ws.send(JSON.stringify(card)); ws.send(JSON.stringify(card));
    await waitUntil(async () => (await backend.context.system.snapshot()).queue.some(x => x.track.externalId === '456'));
    expect((await backend.context.system.snapshot()).queue.filter(x => x.requestKey === 'onebot:555:666:999')).toHaveLength(1);
  });
});
async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 3000) { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('等待状态变化超时'); await new Promise(r => setTimeout(r, 20)); } }
