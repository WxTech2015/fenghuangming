import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../src/config';
import { Worker } from '../src/worker';
import type { Mpv } from '../src/mpv';

class FakePlayer extends EventEmitter {
  start = vi.fn(async () => {});
  command = vi.fn(async (_command: unknown[]): Promise<unknown> => {});
  close = vi.fn(() => {});
}
async function fixture(firstFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-recovery-'));
  const config = parseConfig({ serverUrl: 'http://example.com', token: 'fixture-token-'.repeat(4), mpvPath: 'mpv.exe', dataDir: directory }, join(directory, 'config.json'));
  const messages: any[] = []; const peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket); let input = ''; socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    socket.on('data', chunk => { input += chunk; let pos; while ((pos = input.indexOf('\n')) >= 0) { messages.push(JSON.parse(input.slice(0, pos))); input = input.slice(pos + 1); } });
  });
  server.listen(config.pipe); await once(server, 'listening');
  const players: FakePlayer[] = [];
  const worker = new Worker(config, { restartDelayMs: 20, createPlayer: () => {
    const player = new FakePlayer(); if (firstFailure && !players.length) player.start.mockRejectedValueOnce(new Error('start failed'));
    players.push(player); return player as unknown as Mpv;
  } });
  await worker.start();
  const close = async () => {
    await worker.close(); for (const peer of peers) peer.destroy(); await new Promise<void>(ok => server.close(() => ok()));
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-recovery-'))) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  };
  return { worker, players, messages, close, directory, send: (value: Record<string, unknown>) => { for (const peer of peers) peer.write(JSON.stringify({ ...value, secret: config.ipcSecret }) + '\n'); } };
}
it('mpv 退出后报告失败并恢复就绪，关闭时取消重启，不重播旧歌曲', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true));
    f.worker.state.playbackId = 'play_lost'; f.worker.state.started = true;
    f.players[0]!.emit('unavailable', 'mpv exit code=1'); f.players[0]!.emit('unavailable', 'duplicate');
    expect(f.worker.state.ready).toBe(false);
    await vi.waitFor(() => expect(f.players).toHaveLength(2));
    await vi.waitFor(() => expect(f.worker.state.ready).toBe(true));
    await vi.waitFor(() => expect(f.messages.filter(x => x.type === 'playback' && x.state === 'failed')).toHaveLength(1));
    expect(f.worker.state.playbackId).toBeNull(); expect(f.players[1]!.command).not.toHaveBeenCalled();
    f.players[1]!.emit('unavailable', 'next exit'); await f.worker.close();
    await new Promise(ok => setTimeout(ok, 50)); expect(f.players).toHaveLength(2);
  } finally { await f.close(); }
});
it('首次启动失败时保持服务连接，稍后自动重试 mpv', async () => {
  const f = await fixture(true);
  try {
    expect(f.worker.state.ready).toBe(false);
    await vi.waitFor(() => expect(f.worker.state.ready).toBe(true)); expect(f.players).toHaveLength(2);
    expect(f.players[0]!.close).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it('紧急制动绕过过期租约，立即停止，恢复 mpv 后保持锁定直到手动解除', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true)); f.worker.state.playbackId = 'brake_fixture';
    f.send({ type: 'emergency-stop', blocked: true, requestId: 'brake' });
    await vi.waitFor(() => expect(f.messages.some(x => x.type === 'result' && x.requestId === 'brake' && x.ok)).toBe(true));
    expect(f.players[0]!.command).toHaveBeenCalledWith(['stop']); expect(f.worker.state.ready).toBe(false); expect(f.worker.state.playbackId).toBeNull();
    f.players[0]!.emit('unavailable', 'crashed while braked'); await vi.waitFor(() => expect(f.players).toHaveLength(2));
    expect(f.worker.state.ready).toBe(false);
    f.send({ type: 'emergency-stop', blocked: false, requestId: 'release' }); await vi.waitFor(() => expect(f.worker.state.ready).toBe(true));
    expect(f.worker.state.playbackId).toBeNull();
  } finally { await f.close(); }
});
it('播放指令等待期间制动再解除，不允许旧 start 继续加载音频', async () => {
  const f = await fixture(); let release!: () => void; const pending = new Promise<void>(ok => { release = ok; });
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true));
    const cache = join(f.directory, 'cache'); await mkdir(cache); const filename = join(cache, 'fixture.audio'); const data = Buffer.alloc(4096); await writeFile(filename, data);
    f.players[0]!.command.mockImplementation(async command => { if (command[0] === 'set_property' && command[1] === 'volume') await pending; });
    f.send({ type: 'lease', epoch: 1, leaseMs: 60000 }); f.send({ action: 'start', epoch: 1, filename, sha256: createHash('sha256').update(data).digest('hex'), playbackId: 'racing-start', volume: 0, requestId: 'start-race' });
    await vi.waitFor(() => expect(f.players[0]!.command).toHaveBeenCalledWith(['set_property', 'volume', 0]));
    f.send({ type: 'emergency-stop', blocked: true, requestId: 'block-race' }); f.send({ type: 'emergency-stop', blocked: false, requestId: 'release-race' });
    await vi.waitFor(() => expect(f.messages.some(x => x.type === 'result' && x.requestId === 'release-race' && x.ok)).toBe(true)); release();
    await vi.waitFor(() => expect(f.messages.some(x => x.type === 'result' && x.requestId === 'start-race' && !x.ok)).toBe(true));
    expect(f.players[0]!.command.mock.calls.some(args => args[0][0] === 'loadfile')).toBe(false); expect(f.worker.state.playbackId).toBeNull();
  } finally { release(); await f.close(); }
});
it('本机按整数秒精确跳转，保持暂停，拒绝其他任务与制动时的跳转', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true));
    Object.assign(f.worker.state, { playbackId: 'seek-song', started: true, seekable: true, durationSeconds: 60.4, paused: true });
    f.send({ type: 'lease', epoch: 1, leaseMs: 60000 });
    const send = (id: string, position: number, playbackId = 'seek-song') => f.send({ action: 'seek', epoch: 1, requestId: id, playbackId, position });
    send('seek-valid', 17); await vi.waitFor(() => expect(f.messages.some(x => x.requestId === 'seek-valid' && x.ok)).toBe(true));
    expect(f.players[0]!.command).toHaveBeenCalledWith(['seek', 17, 'absolute+exact']); expect(f.worker.state.paused).toBe(true);
    send('seek-end', 80); await vi.waitFor(() => expect(f.messages.some(x => x.requestId === 'seek-end' && x.ok)).toBe(true)); expect(f.players[0]!.command).toHaveBeenCalledWith(['seek', 59, 'absolute+exact']);
    for (const [id, position, playbackId] of [['fraction', 17.5, 'seek-song'], ['negative', -1, 'seek-song'], ['stale', 17, 'old-song']] as const) {
      send(id, position, playbackId); await vi.waitFor(() => expect(f.messages.some(x => x.requestId === id && !x.ok)).toBe(true));
    }
    f.send({ type: 'emergency-stop', blocked: true, requestId: 'brake' }); send('seek-braked', 18);
    await vi.waitFor(() => expect(f.messages.some(x => x.requestId === 'seek-braked' && !x.ok)).toBe(true)); expect(f.players[0]!.command.mock.calls.filter(x => x[0][0] === 'seek')).toHaveLength(2);
  } finally { await f.close(); }
});
it('输出异常后恢复缓存中的当前任务和位置，不重复上报开始；连续崩溃只失败一次', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true));
    f.send({ type: 'lease', epoch: 1, leaseMs: 60000 }); await new Promise(ok => setTimeout(ok, 20));
    Object.assign(f.worker.state, { playbackId: 'active-song', filename: join(f.directory, 'cache', 'validated.audio'), started: true, position: 23, paused: true });
    f.players[0]!.emit('unavailable', 'output device changed');
    expect(f.worker.state.recovering).toBe(true); expect(f.worker.state.playbackId).toBe('active-song');
    await vi.waitFor(() => expect(f.players).toHaveLength(2));
    await vi.waitFor(() => expect(f.players[1]!.command.mock.calls.some(x => x[0][0] === 'loadfile')).toBe(true));
    f.players[1]!.emit('event', { event: 'file-loaded' });
    await vi.waitFor(() => expect(f.worker.state.ready).toBe(true));
    expect(f.players[1]!.command).toHaveBeenCalledWith(['seek', 23, 'absolute+exact']); expect(f.players[1]!.command).toHaveBeenCalledWith(['set_property', 'pause', true]); expect(f.worker.state.playbackId).toBe('active-song'); expect(f.messages.filter(x => x.type === 'playback')).toHaveLength(0);
    f.players[1]!.emit('unavailable', 'repeated crash'); await vi.waitFor(() => expect(f.messages.filter(x => x.type === 'playback' && x.state === 'failed')).toHaveLength(1)); expect(f.worker.state.playbackId).toBeNull();
  } finally { await f.close(); }
});
it('恢复歌曲加载期间制动再解除，不恢复旧任务和声音', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true)); f.send({ type: 'lease', epoch: 1, leaseMs: 60000 }); await new Promise(ok => setTimeout(ok, 20));
    Object.assign(f.worker.state, { playbackId: 'restore-race', filename: join(f.directory, 'cache', 'validated.audio'), started: true, position: 10, paused: false });
    f.players[0]!.emit('unavailable', 'lost output'); await vi.waitFor(() => expect(f.players).toHaveLength(2)); await vi.waitFor(() => expect(f.players[1]!.command.mock.calls.some(x => x[0][0] === 'loadfile')).toBe(true));
    f.send({ type: 'emergency-stop', blocked: true, requestId: 'brake-restore' }); f.send({ type: 'emergency-stop', blocked: false, requestId: 'release-restore' });
    await vi.waitFor(() => expect(f.messages.some(x => x.requestId === 'release-restore' && x.ok)).toBe(true)); f.players[1]!.emit('event', { event: 'file-loaded' });
    await vi.waitFor(() => expect(f.worker.state.recovering).toBe(false)); expect(f.worker.state.playbackId).toBeNull(); expect(f.players[1]!.command.mock.calls.some(x => x[0][0] === 'seek')).toBe(false); expect(f.players[1]!.command).not.toHaveBeenCalledWith(['set_property', 'pause', false]);
  } finally { await f.close(); }
});
it.each(['stop', 'lease'])('恢复加载期间 %s 取消当前任务，不恢复旧歌曲', async cancellation => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.messages.some(x => x.state?.ready)).toBe(true)); f.send({ type: 'lease', epoch: 1, leaseMs: cancellation === 'lease' ? 300 : 60000 }); await new Promise(ok => setTimeout(ok, 20));
    Object.assign(f.worker.state, { playbackId: 'cancel-restore', filename: join(f.directory, 'cache', 'validated.audio'), started: true, position: 10, paused: false });
    f.players[0]!.emit('unavailable', 'lost output'); await vi.waitFor(() => expect(f.players).toHaveLength(2)); await vi.waitFor(() => expect(f.players[1]!.command.mock.calls.some(x => x[0][0] === 'loadfile')).toBe(true));
    if (cancellation === 'stop') { f.send({ action: 'stop', epoch: 1, playbackId: 'cancel-restore', requestId: 'stop-restore' }); await vi.waitFor(() => expect(f.messages.some(x => x.requestId === 'stop-restore' && x.ok)).toBe(true)); }
    else await new Promise(ok => setTimeout(ok, 350));
    f.players[1]!.emit('event', { event: 'file-loaded' }); await vi.waitFor(() => expect(f.worker.state.recovering).toBe(false));
    expect(f.worker.state.playbackId).toBeNull(); expect(f.players[1]!.command.mock.calls.some(x => x[0][0] === 'seek')).toBe(false); expect(f.players[1]!.command).not.toHaveBeenCalledWith(['set_property', 'pause', false]);
  } finally { await f.close(); }
});
