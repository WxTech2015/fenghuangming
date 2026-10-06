import type { MediaAsset, QueueItem } from '../contracts';
import { Store } from '../core/store';
import { chooseNext, settings } from '../core/domain';
import { Events } from '../core/events';
import { diagnostics, traceFor } from '../core/diagnostics';
import type { MediaService } from './cache';

export interface PreloadState { itemId: string; phase: 'warming' | 'ready' | 'failed'; error: string | null; checkedAt: number }
export class MediaPreloader {
  private closed = false; private checking = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly states = new Map<string, PreloadState>();
  constructor(readonly store: Store, readonly media: Pick<MediaService, 'prepare'>, readonly events: Events) {}
  snapshot() { return [...this.states.values()].map(state => ({ ...state })); }
  async tick() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      const plan = await this.store.transaction(async tx => {
        const config = (await settings(tx)).downloads;
        const items = await tx.all('queueItem');
        const windows = (await tx.all('zone')).filter(zone => zone.enabled).map(zone => {
          const selected: QueueItem[] = []; let remaining = [...items];
          const current = items.find(item => item.id === zone.currentItemId);
          let virtual = { ...zone, priorityStreak: current && current.status !== 'playing' ? current.priority > 0 ? zone.priorityStreak + 1 : 0 : zone.priorityStreak };
          for (let n = 0; n < config.preloadCount; n++) {
            const item = chooseNext(remaining, virtual); if (!item) break; selected.push(item);
            remaining = remaining.filter(value => value.id !== item.id); virtual = { ...virtual, priorityStreak: item.priority > 0 ? virtual.priorityStreak + 1 : 0 };
          }
          return selected;
        });
        const candidates = Array.from({ length: config.preloadCount }, (_, n) => windows.flatMap(window => window[n] ? [window[n]!] : [])).flat();
        return { config, candidates, live: new Set(items.filter(item => ['queued', 'preparing', 'dispatching', 'playing'].includes(item.status)).map(item => item.id)) };
      });
      for (const id of this.states.keys()) if (!plan.live.has(id) && !this.running.has(id)) this.states.delete(id);
      for (const item of plan.candidates) {
        if (this.running.size >= plan.config.preloadConcurrency || this.closed) break;
        const previous = this.states.get(item.id);
        if (item.assetId || this.running.has(item.id) || previous?.phase === 'ready' || previous?.phase === 'failed' && Date.now() - previous.checkedAt < 60000) continue;
        this.states.set(item.id, { itemId: item.id, phase: 'warming', error: null, checkedAt: Date.now() }); this.events.changed('preload');
        const job = this.warm(item).finally(() => this.running.delete(item.id)); this.running.set(item.id, job);
      }
    } finally { this.checking = false; }
  }
  private async warm(item: QueueItem) {
    return diagnostics.scope({ traceId: traceFor(item.requestKey), itemId: item.id, zoneId: item.zoneId, preload: true }, async () => {
      const start = Date.now(); diagnostics.info('media.preload.start', '提前准备待播歌曲');
      try {
        const asset: MediaAsset = await this.media.prepare(item);
        if (this.closed) return;
        await this.store.transaction(async tx => { const latest = await tx.get('queueItem', item.id); if (latest?.status === 'queued') await tx.put('queueItem', { ...latest, assetId: asset.id }); });
        this.states.set(item.id, { itemId: item.id, phase: 'ready', error: null, checkedAt: Date.now() });
        diagnostics.info('media.preload.ready', '待播歌曲已预热', { bytes: asset.bytes, durationMs: Date.now() - start });
      } catch (error) {
        this.states.set(item.id, { itemId: item.id, phase: 'failed', error: diagnostics.summary(error), checkedAt: Date.now() });
        diagnostics.warn('media.preload.failed', '预热未成功，实际轮到播放时仍会重试', { error, durationMs: Date.now() - start });
      } finally { if (!this.closed) this.events.changed('preload'); }
    });
  }
  async close() { this.closed = true; await Promise.allSettled(this.running.values()); }
}
