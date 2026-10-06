import { expect, it } from 'vitest';
import { TrackSchema } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { Events } from '../src/core/events';
import { SystemService } from '../src/core/system';
import { QueueService } from '../src/queues/queue';
import { ModerationService } from '../src/policies/moderation';
import { PlaybackService } from '../src/playback/playback';
import { MediaService } from '../src/media/cache';
import { MusicService } from '../src/music/providers';
async function fixture() {
  const store = await new FileStore().init(); const events = new Events(); const system = new SystemService(store, events); await system.init();
  const queue = new QueueService(store, events, new ModerationService());
  const original = await queue.enqueue({ zoneId: 'zone_default', requestKey: 'recovery', userId: '123', track: TrackSchema.parse({ platform: 'qq', externalId: '003abc', title: '测试' }) });
  const promoted = await queue.promote(original.id); const { agent } = await system.registerAgent({ name: '测试', zoneId: 'zone_default' });
  await store.transaction(async tx => { await tx.put('agent', { ...await tx.get('agent', agent.id)!, epoch: 1, ready: true } as any); await tx.put('queueItem', { ...promoted, status: 'dispatching', playbackId: 'play_test' }); const zone = await tx.get('zone', 'zone_default'); await tx.put('zone', { ...zone!, currentItemId: original.id }); });
  return { store, system, agent, item: promoted, playback: new PlaybackService(store, events, new MediaService(store, new MusicService([]), 'unused-test-path', 'test'), () => true) };
}
it('重连保留实际播放，旧连接事件不会结束新连接任务', async () => {
  const { store, system, agent, item, playback } = await fixture();
  const hello = { type: 'hello' as const, v: 1 as const, ready: true, playbackId: 'play_test', version: 'test', bootId: 'test', position: 10 };
  await playback.hello(agent.id, hello, 1); expect((await system.snapshot()).queue[0]?.status).toBe('playing');
  await store.transaction(async tx => { const old = await tx.get('agent', agent.id); await tx.put('agent', { ...old!, epoch: 2 }); });
  await playback.hello(agent.id, hello, 2);
  await playback.message(agent.id, { type: 'playback', eventId: 'old', playbackId: 'play_test', state: 'ended' }, 1);
  expect((await system.snapshot()).queue.find(x => x.id === item.id)?.status).toBe('playing'); expect((await system.snapshot()).zones[0]?.priorityStreak).toBe(1);
  await playback.message(agent.id, { type: 'playback', eventId: 'new', playbackId: 'play_test', state: 'ended' }, 2);
  expect((await system.snapshot()).queue[0]?.status).toBe('completed');
});
it('重连时播放器仍在加载，不提前标记为播放中', async () => {
  const { system, agent, playback } = await fixture();
  await playback.hello(agent.id, { type: 'hello', v: 1, ready: true, playbackId: 'play_test', started: false, version: 'test', bootId: 'test', position: 0 }, 1);
  expect((await system.snapshot()).queue[0]?.status).toBe('dispatching');
  await playback.message(agent.id, { type: 'playback', eventId: 'actual-file-loaded', playbackId: 'play_test', state: 'started' }, 1);
  expect((await system.snapshot()).queue[0]?.status).toBe('playing');
});
it('未知播放先停止，确认空闲前保持不可派发并退款一次', async () => {
  const { store, system, agent, playback } = await fixture();
  await playback.hello(agent.id, { type: 'hello', v: 1, ready: true, playbackId: 'unknown_play', version: 'test', bootId: 'test', position: 10 }, 1);
  expect((await system.snapshot()).agents[0]?.ready).toBe(false); expect((await system.snapshot()).zones[0]?.currentItemId).toBeNull(); expect((await system.snapshot()).quotas[0]?.used).toBe(0);
  await playback.message(agent.id, { type: 'heartbeat', ready: true, playbackId: 'unknown_play', position: 10, paused: false }, 1); expect((await system.snapshot()).agents[0]?.ready).toBe(false);
  await playback.message(agent.id, { type: 'playback', eventId: 'stop', playbackId: 'unknown_play', state: 'stopped' }, 1);
  expect((await store.transaction(tx => tx.all('command')))[0]?.state).toBe('done');
  await playback.message(agent.id, { type: 'heartbeat', ready: true, playbackId: null, position: 0, paused: false }, 1); expect((await system.snapshot()).agents[0]?.ready).toBe(true);
});
