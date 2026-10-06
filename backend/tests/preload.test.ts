import { expect, it, vi } from 'vitest';
import { FileStore } from '../src/core/store';
import { Events } from '../src/core/events';
import { SystemService } from '../src/core/system';
import { SettingsSchema, TrackSchema, type QueueItem, type MediaAsset } from '../src/contracts';
import { MediaPreloader } from '../src/media/preload';
const asset: MediaAsset = { id: 'media_fixture', trackKey: 'fixture', filename: 'fixture', mime: 'audio/mpeg', bytes: 4096, sha256: 'a'.repeat(64), durationSeconds: 60, createdAt: '', lastAccessedAt: '' };
function item(id: string, priority = 0, status: QueueItem['status'] = 'queued'): QueueItem { return { id, engine: 'gdstudio', track: TrackSchema.parse({ platform: 'netease', externalId: id, title: id }), zoneId: 'zone_default', userId: 'fixture', userName: '', groupId: '', botId: '', requestKey: id, status, priority, promotedAt: id, createdAt: id, playbackId: null, assetId: null, error: null, reviewReason: null }; }
it('预热遵守插队公平顺序、并发上限和审核状态，不改变队列播放状态', async () => {
  const store = await new FileStore().init(); const events = new Events(); await new SystemService(store, events).init();
  const release: (() => void)[] = []; const calls: string[] = [];
  const preloader = new MediaPreloader(store, { prepare: async value => { calls.push(value.id); await new Promise<void>(ok => release.push(ok)); return asset; } }, events);
  try {
    await store.transaction(async tx => { const zone = (await tx.get('zone', 'zone_default'))!; await tx.put('zone', { ...zone, priorityStreak: 2 }); for (const value of [item('normal'), item('priority', 1), item('review', 0, 'review')]) await tx.put('queueItem', value); });
    await preloader.tick(); await preloader.tick(); expect(calls).toEqual(['normal', 'priority']); expect(preloader.snapshot().every(value => value.phase === 'warming')).toBe(true);
    release.forEach(ok => ok()); await vi.waitFor(() => expect(preloader.snapshot().every(value => value.phase === 'ready')).toBe(true));
    expect(await store.transaction(tx => tx.get('queueItem', 'normal'))).toMatchObject({ status: 'queued', assetId: asset.id, priority: 0 });
    await preloader.tick(); expect(calls).toHaveLength(2);
  } finally { release.forEach(ok => ok()); await preloader.close(); await store.close(); }
});
it('关闭预热不下载；预热失败保留 queued、冷却一分钟', async () => {
  const store = await new FileStore().init(); const events = new Events(); const system = new SystemService(store, events); await system.init();
  const prepare = vi.fn(async () => { throw new Error('provider failed'); }); const preloader = new MediaPreloader(store, { prepare }, events);
  try {
    await store.transaction(tx => tx.put('queueItem', item('one'))); await system.saveSettings({ downloads: { ...SettingsSchema.parse({}).downloads, preloadCount: 0 } }); await preloader.tick(); expect(prepare).not.toHaveBeenCalled();
    await system.saveSettings({ downloads: { ...SettingsSchema.parse({}).downloads, preloadCount: 3 } }); await preloader.tick(); await vi.waitFor(() => expect(preloader.snapshot()[0]?.phase).toBe('failed'));
    await preloader.tick(); expect(prepare).toHaveBeenCalledOnce(); expect(await store.transaction(tx => tx.get('queueItem', 'one'))).toMatchObject({ status: 'queued', error: null });
  } finally { await preloader.close(); await store.close(); }
});
it('预热期间取消的歌曲不会被写回缓存或恢复排队', async () => {
  const store = await new FileStore().init(); const events = new Events(); await new SystemService(store, events).init();
  let release!: () => void; const ready = new Promise<void>(ok => { release = ok; });
  const preloader = new MediaPreloader(store, { prepare: async () => { await ready; return asset; } }, events);
  try {
    await store.transaction(tx => tx.put('queueItem', item('cancel-me'))); await preloader.tick();
    await store.transaction(async tx => { const current = (await tx.get('queueItem', 'cancel-me'))!; await tx.put('queueItem', { ...current, status: 'cancelled' }); });
    release(); await vi.waitFor(() => expect(preloader.snapshot()[0]?.phase).toBe('ready'));
    expect(await store.transaction(tx => tx.get('queueItem', 'cancel-me'))).toMatchObject({ status: 'cancelled', assetId: null, playbackId: null });
    await preloader.tick(); expect(preloader.snapshot()).toEqual([]);
  } finally { release(); await preloader.close(); await store.close(); }
});
