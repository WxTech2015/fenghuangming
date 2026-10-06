import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SettingsSchema, TrackSchema, type QueueItem } from '../src/contracts';
import { GDStudioProvider, GD_STUDIO_API } from '../src/music/gdstudio';
import { FileStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { MediaService } from '../src/media/cache';
import { MusicManager } from '../src/music/manager';
import { MusicService } from '../src/music/providers';

const settings = SettingsSchema.parse({ audioEngine: 'gdstudio', fallbackEngines: [] });
const track = TrackSchema.parse({ platform: 'netease', externalId: '406173', title: 'Flower Dance', artists: ['DJ OKAWARI'], durationSeconds: 6 });
const audio = { url: 'https://m.music.126.net/track.flac', br: 999, size: 16000 };
describe('GD Studio 在线音源', () => {
  it.each([['netease', '406173', 'netease'], ['qq', '003mid', 'tencent'], ['kuwo', '1234', 'kuwo']] as const)('按 %s 原 ID 取源，不执行名称搜索', async (platform, id, source) => {
    const request = vi.fn(async () => audio); const gd = new GDStudioProvider({ request }); gd.configure(true);
    const result = await gd.resolve({ ...track, platform, externalId: id }, settings);
    const url = new URL(request.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe(GD_STUDIO_API); expect(Object.fromEntries(url.searchParams)).toEqual({ types: 'url', source, id, br: '999' });
    expect(result).toMatchObject({ source: 'gdstudio', url: audio.url }); expect(result.headers).not.toHaveProperty('Cookie'); expect(result).not.toHaveProperty('trustedOrigin'); expect(gd.status.phase).toBe('external'); gd.close();
  });
  it('使用所选音质；不会切换不支持的平台或将 QQ 数字 ID 当作 MID', async () => {
    const request = vi.fn(async () => audio); const gd = new GDStudioProvider({ request });
    await gd.resolve(track, SettingsSchema.parse({ gdstudio: { quality: '320' } })); expect(new URL(request.mock.calls[0]![0]).searchParams.get('br')).toBe('320');
    await expect(gd.resolve({ ...track, platform: 'kugou' }, settings)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
    await expect(gd.resolve({ ...track, platform: 'qq', externalId: '12345' }, settings)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' }); expect(request).toHaveBeenCalledTimes(1); gd.close();
  });
  it.each([{}, { url: '' }, [], { ...audio, id: 'different' }, { ...audio, source: 'tencent' }, { url: 'file:///private' }, { url: 'https://user:password@music.example/file' }])('拒绝空地址、身份不符或无效响应：%j', async body => {
    const gd = new GDStudioProvider({ request: async () => body }); gd.configure(true);
    await expect(gd.resolve(track, settings)).rejects.toThrow(); expect(gd.status.phase).toBe('failed'); expect(gd.status.error).toBeTruthy(); gd.close();
  });
  it('并发请求共用 5 分钟频率窗口，重启状态不会绕过限流', async () => {
    let now = 1000; const request = vi.fn(async () => audio); const gd = new GDStudioProvider({ request, now: () => now, maxRequests: 2 });
    gd.configure(true); const results = await Promise.allSettled([gd.resolve(track, settings), gd.resolve(track, settings), gd.resolve(track, settings)]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(2); expect(request).toHaveBeenCalledTimes(2);
    gd.restart(); await expect(gd.resolve(track, settings)).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMIT' });
    now += 5 * 60 * 1000; await gd.resolve(track, settings); expect(request).toHaveBeenCalledTimes(3); gd.close();
    await expect(gd.resolve(track, settings)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
  it('构造、选择和保存只启用在线音源，不下载或启动 Worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqmusic-gdstudio-'));
    const store = await new FileStore().init(); const system = new SystemService(store, new Events()); const changed = vi.fn();
    const manager = new MusicManager(directory, changed); const goInstall = vi.spyOn(manager.go, 'install'); const pythonInstall = vi.spyOn(manager.adapters.musicdl, 'install');
    try {
      await system.init(); await system.saveSettings(settings); await system.init();
      const saved = (await system.snapshot()).settings; expect(saved.audioEngine).toBe('gdstudio'); expect(saved.gdstudio.quality).toBe('999');
      await manager.configure(saved); expect(manager.gdstudio.status).toMatchObject({ mode: 'external', phase: 'external', installed: true });
      expect(goInstall).not.toHaveBeenCalled(); expect(pythonInstall).not.toHaveBeenCalled(); expect(Object.keys(manager.adapters)).not.toContain('gdstudio'); expect(() => manager.install('gdstudio')).toThrow('保存配置即可启用');
      await manager.configure(SettingsSchema.parse({ fallbackEngines: [] })); expect(manager.gdstudio.status.phase).toBe('stopped');
      await manager.configure(SettingsSchema.parse({ fallbackEngines: ['gdstudio'] })); expect(manager.gdstudio.status.phase).toBe('external');
    } finally { await manager.close(); await store.close(); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-gdstudio-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
  });
  it('原地址失败后使用 GD 地址，保存音源身份并复用实际音频缓存', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqmusic-gdstudio-media-'));
    const bytes = 6 * 8000 * 2; const wave = Buffer.alloc(44 + bytes);
    wave.write('RIFF'); wave.writeUInt32LE(bytes + 36, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(bytes, 40);
    const paths: string[] = []; const server = createServer((req, res) => { paths.push(req.url!); if (req.url === '/original') res.end('<html>login</html>'); else { res.setHeader('Content-Type', 'audio/wav'); res.end(wave); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = vi.fn(async () => ({ ...audio, url: base + '/full' })); const gd = new GDStudioProvider({ request }); const store = await new FileStore().init(); const system = new SystemService(store, new Events());
    try {
      await system.init(); await system.saveSettings(settings);
      // Only this local fixture receives a private-origin exception. The real GD provider does not.
      const music = new MusicService([{ name: 'gdstudio', resolve: async (track, config) => ({ ...await gd.resolve(track, config), trustedOrigin: base }) }], { original: async function* () { yield { url: base + '/original', trustedOrigin: base, source: 'direct' }; }, canonical: async track => track });
      const media = new MediaService(store, music, join(directory, 'media'), 'test');
      const item: QueueItem = { id: 'gd_item', engine: 'gdstudio', track, zoneId: 'zone_default', userId: '123', userName: 'test', groupId: '', botId: '', requestKey: 'gd-source', status: 'preparing', priority: 0, promotedAt: null, createdAt: new Date().toISOString(), playbackId: null, assetId: null, error: null, reviewReason: null };
      const asset = await media.prepare(item); expect(asset.source).toMatchObject({ engine: 'gdstudio', match: 'id', platform: 'netease', externalId: '406173' }); expect(asset.durationSeconds).toBe(6); expect(paths).toEqual(['/original', '/full']);
      expect((await media.prepare(item)).id).toBe(asset.id); expect(request).toHaveBeenCalledTimes(1); expect(paths).toEqual(['/original', '/full']);
    } finally { gd.close(); await store.close(); await new Promise<void>(ok => server.close(() => ok())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-gdstudio-media-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
  });
});
