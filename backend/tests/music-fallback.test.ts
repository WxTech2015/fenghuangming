import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SettingsSchema, TrackSchema, type QueueItem, type Track } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { MediaService } from '../src/media/cache';
import { MusicService, sameRecording, type AudioProvider, type ResolvedSource } from '../src/music/providers';
import { AdapterRuntime } from '../src/music/adapter-runtime';
import { parseMusicCard } from '../src/onebot/cards';

function wav(seconds = 6) {
  const bytes = seconds * 8000 * 2; const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(bytes + 36, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
describe('原链接下载后才回退，禁止静默换歌', () => {
  let directory = ''; let server: Server; let base = ''; let store: FileStore; let system: SystemService;
  const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '晴天', artists: ['周杰伦'], durationSeconds: 6, shareUrl: 'https://music.163.com/song?id=123' });
  const item: QueueItem = { id: 'test_item', engine: 'gomusicdl', track, zoneId: 'zone_default', userId: '100', userName: '点歌人', groupId: '200', botId: '300', requestKey: 'test', status: 'preparing', priority: 0, promotedAt: null, createdAt: new Date().toISOString(), playbackId: null, assetId: null, error: null, reviewReason: null };
  const paths: string[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qqmusic-fallback-')); paths.length = 0;
    store = await new FileStore().init(); system = new SystemService(store, new Events()); await system.init();
    server = createServer((req, res) => { paths.push(req.url!); if (req.url === '/404') { res.writeHead(404); res.end(); } else if (req.url === '/invalid') res.end('<html>登录</html>'); else res.end(wav(req.url === '/full' ? 60 : 6)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(done => server.close(() => done())); await store.close(); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-fallback-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); });
  const source = (path: string): ResolvedSource => ({ url: base + path, trustedOrigin: base, source: 'direct' });
  function media(original: () => AsyncIterable<ResolvedSource>, providers: AudioProvider[]) { return new MediaService(store, new MusicService(providers, { original, canonical: async t => t }), join(directory, 'media'), 'secret'); }
  it('原链接成功时，不调用任意后端或搜索；缓存保留取源方式', async () => {
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(), search: vi.fn() };
    const m = media(async function* () { yield source('/audio'); }, [provider]);
    const asset = await m.prepare(item); expect(provider.resolve).not.toHaveBeenCalled(); expect(provider.search).not.toHaveBeenCalled(); expect(paths).toEqual(['/audio']); expect(asset.source).toMatchObject({ engine: 'direct', match: 'id', externalId: '123' });
    await m.prepare(item); expect(paths).toEqual(['/audio']);
  });
  it.each(['/404', '/invalid'])('原链接 %s 失败才按原 ID 调用后端，清理失败文件', async path => {
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async (candidate: Track) => { expect(candidate.externalId).toBe('123'); return source('/audio'); }) };
    const asset = await media(async function* () { yield source(path); }, [provider]).prepare(item);
    expect(provider.resolve).toHaveBeenCalledTimes(1); expect(paths).toEqual([path, '/audio']); expect(asset.source?.engine).toBe('gomusicdl'); expect((await readdir(join(directory, 'media'))).some(x => x.endsWith('.tmp'))).toBe(false);
  });
  it('试听片段被拒绝，继续取原曲完整音频；失败不会调用名称搜索', async () => {
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async () => source('/full')), search: vi.fn() };
    const asset = await media(async function* () { yield source('/preview'); }, [provider]).prepare({ ...item, track: { ...track, durationSeconds: 60 } });
    expect(asset.durationSeconds).toBe(60); expect(paths).toEqual(['/preview', '/full']); expect(provider.search).not.toHaveBeenCalled();
  });
  it('首选和备用按保存顺序尝试，已成功时不执行后续源', async () => {
    const calls: string[] = [];
    const providers: AudioProvider[] = ['gomusicdl', 'meting', 'neteaseapi', 'musicdl'].map(name => ({ name: name as AudioProvider['name'], resolve: async () => { calls.push(name); return source(name === 'meting' ? '/audio' : '/invalid'); } }));
    const asset = await media(async function* () { throw new Error('链接解析失败'); }, providers).prepare(item);
    expect(calls).toEqual(['gomusicdl', 'meting']); expect(asset.source?.match).toBe('id');
  });
  it('可选搜索只接受同歌手、同版本同曲，并再次检查搜索 ID 的黑名单', async () => {
    await system.saveSettings({ searchFallback: true, fallbackEngines: [] });
    const candidate = { ...track, externalId: '456' }; await system.blacklist({ kind: 'track', value: 'netease:456', reason: '此版本禁用' });
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async (t: Track) => { if (t.externalId === '123') throw new Error('无音频'); return source('/audio'); }), search: vi.fn(async () => [{ ...candidate, title: '晴天 (Live)' }, { ...candidate, artists: ['其他歌手'] }, candidate]) };
    await expect(media(async function* () {}, [provider]).prepare(item)).rejects.toThrow('此版本禁用');
    expect(provider.resolve.mock.calls.map(x => x[0].externalId)).toEqual(['123', '456']); expect(paths).toHaveLength(0);
  });
  it('缓存命中也会重新检查实际 ID 的黑名单', async () => {
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async () => source('/audio')) };
    const m = new MediaService(store, new MusicService([provider], { original: async function* () { yield { ...source('/audio'), track: { ...track, externalId: '456' } }; }, canonical: async t => t }), join(directory, 'media'), 'secret');
    await m.prepare(item); await system.blacklist({ kind: 'track', value: 'netease:456', reason: '后来禁用' });
    await expect(m.prepare(item)).rejects.toThrow('后来禁用'); expect(paths).toEqual(['/audio']);
  });
  it('音频已校验但数据库保存失败时，保留原因并停止，不重复下载或调用备用音源', async () => {
    const databaseError = new Error('Unknown argument source'); const transaction = store.transaction.bind(store);
    vi.spyOn(store, 'transaction').mockImplementation(fn => transaction(tx => fn({ ...tx, put: async (table, value) => { if (table === 'mediaAsset') throw databaseError; await tx.put(table, value); } })));
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async () => source('/audio')) };
    const m = media(async function* () { yield source('/audio'); yield source('/second'); }, [provider]);
    await expect(m.prepare(item)).rejects.toMatchObject({ code: 'MEDIA_CACHE_ERROR', cause: databaseError });
    expect(paths).toEqual(['/audio']); expect(provider.resolve).not.toHaveBeenCalled();
    expect((await readdir(join(directory, 'media'))).some(path => path.endsWith('.tmp'))).toBe(false);
  });
  it('缓存命中时更新数据库失败，不吞掉错误重新下载', async () => {
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async () => source('/audio')) }; const m = media(async function* () { yield source('/audio'); }, [provider]);
    await m.prepare(item); const transaction = store.transaction.bind(store);
    vi.spyOn(store, 'transaction').mockImplementation(fn => transaction(tx => fn({ ...tx, put: async (table, value) => { if (table === 'mediaAsset') throw new Error('database disconnected'); await tx.put(table, value); } })));
    await expect(m.prepare(item)).rejects.toMatchObject({ code: 'MEDIA_CACHE_ERROR' }); expect(paths).toEqual(['/audio']); expect(provider.resolve).not.toHaveBeenCalled();
  });
  it('本地缓存目录无法写入时，报告缓存错误，不切换音源', async () => {
    const blockedPath = join(directory, 'blocked'); await writeFile(blockedPath, 'not a directory');
    const provider = { name: 'gomusicdl' as const, resolve: vi.fn(async () => source('/audio')) };
    const m = new MediaService(store, new MusicService([provider], { original: async function* () { yield source('/audio'); }, canonical: async track => track }), blockedPath, 'test');
    await expect(m.prepare(item)).rejects.toMatchObject({ code: 'MEDIA_CACHE_ERROR' }); expect(paths).toEqual([]); expect(provider.resolve).not.toHaveBeenCalled();
  });
});

describe('歌曲身份和卡片原地址', () => {
  const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '晴天', artists: ['周杰伦'], durationSeconds: 270 });
  it('搜索不允许同名不同歌手、Live、其他平台、未知或明显不同的时长', () => {
    expect(sameRecording(track, { ...track, externalId: '456' })).toBe(true);
    for (const mismatch of [{ artists: ['翻唱歌手'] }, { title: '晴天 (Live)' }, { platform: 'qq' }, { durationSeconds: 0 }, { durationSeconds: 180 }]) expect(sameRecording(track, { ...track, ...mismatch } as Track)).toBe(false);
  });
  it('保留卡片原音频地址，只接受同平台的地址；未识别 ID 时保留链接和曲目信息', async () => {
    const make = (audio: string, url = 'https://music.163.com/song?id=123') => [{ type: 'json', data: { data: JSON.stringify({ meta: { music: { title: '晴天', desc: '周杰伦', jumpUrl: url, musicUrl: audio } } }) } }];
    expect(await parseMusicCard(make('https://m1.music.126.net/song.mp3'), false)).toMatchObject({ externalId: '123', originalAudioUrl: 'https://m1.music.126.net/song.mp3' });
    expect(await parseMusicCard(make('http://127.0.0.1/internal'), false)).not.toHaveProperty('originalAudioUrl');
    expect(await parseMusicCard(make('', 'https://163cn.tv/abcd'), false)).toMatchObject({ externalId: '', title: '晴天', artists: ['周杰伦'], shareUrl: 'https://163cn.tv/abcd' });
    expect(SettingsSchema.parse({}).searchFallback).toBe(false);
  });
  it('升级时保留已选择的新音源与顺序', async () => {
    const store = await new FileStore().init(); const system = new SystemService(store, new Events());
    await system.init(); await system.saveSettings({ audioEngine: 'musicdl', fallbackEngines: ['neteaseapi', 'meting'] }); await system.init();
    expect((await system.snapshot()).settings).toMatchObject({ audioEngine: 'musicdl', fallbackEngines: ['neteaseapi', 'meting'] }); await store.close();
  });
});

describe('内置取源进程隔离', () => {
  it('并发共享启动；超时终止进程，下次调用重启；切换后关闭并释放等待者', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqmusic-adapter-'));
    const workerPath = join(directory, 'worker.cjs');
    await writeFile(workerPath, "const {parentPort}=require('node:worker_threads'); parentPort.postMessage({type:'ready'}); parentPort.on('message',m=>{if(m.track.externalId==='hang')return;parentPort.postMessage({type:'result',id:m.id,result:{url:'https://example.com/'+m.track.externalId}});});");
    const runtime = new AdapterRuntime({ engine: 'meting', dataDir: directory, workerPath, requestTimeoutMs: 200, changed: () => {} });
    const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '测试' });
    try {
      await Promise.all([runtime.configure(true), runtime.configure(true)]); expect(runtime.status.phase).toBe('ready');
      expect(await runtime.call('resolve', track)).toEqual({ url: 'https://example.com/123' });
      await expect(runtime.call('resolve', { ...track, externalId: 'hang' })).rejects.toThrow('超时'); expect(runtime.status.phase).toBe('failed');
      await expect(runtime.call('resolve', track)).resolves.toEqual({ url: 'https://example.com/123' });
      const pending = runtime.call('resolve', { ...track, externalId: 'hang' }); const assertion = expect(pending).rejects.toThrow('连接已关闭');
      await new Promise(ok => setTimeout(ok, 30)); await runtime.configure(false); await assertion; expect(runtime.status.phase).toBe('stopped');
    } finally { await runtime.close(); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-adapter-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
  });
});
