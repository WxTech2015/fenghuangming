import { EnqueueSchema, type QueueItem } from '../contracts';
import { Store, type UnitOfWork } from '../core/store';
import { audit, checkBlacklist, dateInShanghai, id, now, pending, settings } from '../core/domain';
import { AppError } from '../core/errors';
import { diagnosticTrace, diagnostics, traceFor } from '../core/diagnostics';
import { Events } from '../core/events';
import { ModerationService } from '../policies/moderation';
import type { TrackMetadata } from '../music/metadata';

export async function refundQuota(tx: UnitOfWork, item: QueueItem) {
  const consumed = (await tx.all('quotaEvent')).find(x => x.itemId === item.id && x.operation === 'consume');
  if (!consumed || await tx.get('quotaEvent', `refund_${item.id}`)) return;
  const quota = await tx.get('quota', consumed.quotaId);
  if (quota) await tx.put('quota', { ...quota, used: Math.max(0, quota.used - 1) });
  await tx.put('quotaEvent', { id: `refund_${item.id}`, quotaId: consumed.quotaId, itemId: item.id, operation: 'refund', createdAt: now() });
}
export class QueueService {
  constructor(readonly store: Store, readonly events: Events, readonly moderation: ModerationService, readonly metadata?: TrackMetadata) {}
  async enqueue(input: unknown) {
    const data = EnqueueSchema.parse(input);
    return diagnostics.scope({ requestTraceId: diagnosticTrace(), traceId: traceFor(data.requestKey), zoneId: data.zoneId, userId: data.userId, platform: data.track.platform, externalId: data.track.externalId }, async () => {
      diagnostics.info('queue.enqueue.start', '接收点歌请求', { title: data.track.title });
      try { return await this.enqueueData(data); }
      catch (error) { diagnostics.warn('queue.enqueue.failed', '点歌请求未入队', { error }); throw error; }
    });
  }
  private async enqueueData(data: ReturnType<typeof EnqueueSchema.parse>) {
    const initial = await this.store.transaction(async tx => {
      const previous = (await tx.all('queueItem')).find(x => x.requestKey === data.requestKey);
      if (!previous) checkBlacklist(await tx.all('blacklist'), data);
      return { previous, config: await settings(tx) };
    });
    if (initial.previous) { diagnostics.debug('queue.enqueue.duplicate', '复用已处理的点歌请求', { itemId: initial.previous.id }); return initial.previous; }
    diagnostics.debug('metadata.enrich.start', '补全歌曲资料', { lyricsNeeded: initial.config.ai.enabled });
    if (this.metadata) data.track = await this.metadata.enrich(data.track, initial.config.ai.enabled);
    diagnostics.debug('metadata.enrich.complete', '歌曲资料补全完成', { title: data.track.title, artists: data.track.artists, durationSeconds: data.track.durationSeconds, lyricsPresent: !!data.track.lyrics });
    const verdict = await this.moderation.evaluate(data.track, initial.config.ai);
    diagnostics.info('moderation.verdict', '歌曲规则审核完成', { enabled: initial.config.ai.enabled, decision: verdict.decision, reason: verdict.reason });
    if (verdict.decision === 'deny') throw new AppError('AI_REJECTED', verdict.reason, 403);
    const result = await this.store.transaction(async tx => {
      const items = await tx.all('queueItem');
      const previous = items.find(x => x.requestKey === data.requestKey);
      if (previous) return previous;
      const zone = await tx.get('zone', data.zoneId);
      if (!zone?.enabled) throw new AppError('ZONE_UNAVAILABLE', '播放区已停用或不存在');
      const config = await settings(tx);
      checkBlacklist(await tx.all('blacklist'), data);
      if (data.track.durationSeconds > config.maxDurationSeconds) throw new AppError('TOO_LONG', '歌曲超过时长限制');
      if (items.filter(x => x.zoneId === data.zoneId && pending(x)).length >= config.maxQueueSize) throw new AppError('QUEUE_FULL', '队列已满');
      if (items.filter(x => x.userId === data.userId && pending(x)).length >= config.maxPendingPerUser) throw new AppError('USER_QUEUE_FULL', '你的待播歌曲已达到上限');
      const item: QueueItem = { ...data, id: id('item'), engine: config.audioEngine, status: verdict.decision === 'review' ? 'review' : 'queued', priority: 0, promotedAt: null, createdAt: now(), playbackId: null, assetId: null, error: null, reviewReason: verdict.reason || null };
      await tx.put('queueItem', item); await audit(tx, 'queue.enqueue', item.id, `${data.userId}: ${data.track.title} / ${item.engine}`); return item;
    }); diagnostics.info('queue.enqueued', '歌曲已入队', { itemId: result.id, status: result.status, engine: result.engine }); this.events.changed('queue'); return result;
  }
  async promote(itemId: string, userId?: string) {
    const result = await this.store.transaction(async tx => {
      const item = await tx.get('queueItem', itemId);
      if (!item) throw new AppError('NOT_FOUND', '歌曲不存在', 404);
      if (userId && item.userId !== userId) throw new AppError('FORBIDDEN', '只能插队自己的歌曲', 403);
      if (item.priority > 0) return item;
      if (item.status !== 'queued') throw new AppError('NOT_QUEUED', '只有待播歌曲可以插队');
      checkBlacklist(await tx.all('blacklist'), item);
      const config = await settings(tx);
      const date = dateInShanghai(); const quotaId = `${item.userId}:${date}`;
      const quota = await tx.get('quota', quotaId) ?? { id: quotaId, userId: item.userId, date, used: 0 };
      if (quota.used >= config.dailyJumpLimit) throw new AppError('QUOTA_EXCEEDED', config.dailyJumpLimit === 0 ? '当前已禁用插队' : '今天的插队次数已用完');
      await tx.put('quota', { ...quota, used: quota.used + 1 });
      await tx.put('quotaEvent', { id: `consume_${item.id}`, quotaId, itemId, operation: 'consume', createdAt: now() });
      const next = { ...item, priority: 1, promotedAt: now() }; await tx.put('queueItem', next);
      await audit(tx, 'queue.promote', item.id, `${item.userId} / ${date}`); return next;
    }); this.events.changed('queue'); return result;
  }
  async review(itemId: string, approve: boolean) {
    const result = await this.store.transaction(async tx => {
      const item = await tx.get('queueItem', itemId);
      if (!item || item.status !== 'review') throw new AppError('NOT_REVIEW', '歌曲不在待审核状态');
      if (approve) checkBlacklist(await tx.all('blacklist'), item);
      const next = { ...item, status: approve ? 'queued' as const : 'cancelled' as const };
      await tx.put('queueItem', next); await audit(tx, 'queue.review', itemId, approve ? '通过' : '拒绝'); return next;
    }); this.events.changed('queue'); return result;
  }
  async cancel(itemId: string, userId?: string) {
    const result = await this.store.transaction(async tx => {
      const item = await tx.get('queueItem', itemId);
      if (!item) throw new AppError('NOT_FOUND', '歌曲不存在', 404);
      if (userId && item.userId !== userId) throw new AppError('FORBIDDEN', '只能取消自己的歌曲', 403);
      if (!['queued', 'review'].includes(item.status)) throw new AppError('NOT_CANCELLABLE', '当前歌曲请使用跳过按钮');
      const next = { ...item, status: 'cancelled' as const }; await tx.put('queueItem', next);
      await audit(tx, 'queue.cancel', itemId, userId ? `${userId} 取消自己的点歌` : '管理员移除'); return next;
    }); this.events.changed('queue'); return result;
  }
  async enqueuePlaylist(playlistId: string, requester?: { zoneId: string; botId: string; groupId: string; userId: string; userName: string; requestKey: string }) {
    const playlist = await this.store.transaction(tx => tx.get('playlist', playlistId));
    if (!playlist) throw new AppError('NOT_FOUND', '歌单不存在', 404);
    if (requester && playlist.zoneId !== requester.zoneId) throw new AppError('FORBIDDEN', '只能播放本群播放区的歌单', 403);
    const batch = requester?.requestKey ?? id('batch'); const results: { title: string; itemId?: string; error?: string }[] = [];
    for (let i = 0; i < playlist.tracks.length; i++) {
      const track = playlist.tracks[i]!;
      try { const item = await this.enqueue({ zoneId: playlist.zoneId, userId: 'admin', userName: '管理员歌单', ...requester, track, requestKey: `${batch}:${i}` }); results.push({ title: track.title, itemId: item.id }); }
      catch (error) { results.push({ title: track.title, error: error instanceof Error ? error.message : '入队失败' }); }
    }
    return results;
  }
}
