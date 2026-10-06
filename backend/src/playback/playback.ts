import type { AgentMessage, Command, CommandPayload, QueueItem } from '../contracts';
import { Store, type UnitOfWork } from '../core/store';
import { audit, checkBlacklist, chooseNext, id, now } from '../core/domain';
import { Events } from '../core/events';
import { AppError } from '../core/errors';
import { MediaService } from '../media/cache';
import { MediaPreloader } from '../media/preload';
import { refundQuota } from '../queues/queue';
import { diagnostics, traceFor } from '../core/diagnostics';

export class PlaybackService {
  private readonly running = new Set<string>();
  readonly preloader: MediaPreloader;
  constructor(readonly store: Store, readonly events: Events, readonly media: MediaService, readonly online: (agentId: string) => boolean) { this.preloader = new MediaPreloader(store, media, events); }
  async tick() {
    const zones = await this.store.transaction(tx => tx.all('zone'));
    const advancing = Promise.allSettled(zones.filter(zone => !this.running.has(zone.id)).map(async zone => {
      this.running.add(zone.id);
      try { await this.advance(zone.id); } catch (error) { diagnostics.error('queue.scheduler.failed', '播放区调度失败', { zoneId: zone.id, error }); } finally { this.running.delete(zone.id); }
    }));
    void this.preloader.tick().catch(error => diagnostics.warn('media.preload.scheduler_failed', '预热调度失败', { error }));
    await advancing;
  }
  private async advance(zoneId: string) {
    const claim = await this.store.transaction(async tx => {
      const zone = await tx.get('zone', zoneId);
      if (!zone?.enabled || zone.currentItemId) return null;
      const agent = (await tx.all('agent')).find(a => a.zoneId === zone.id);
      if (!agent?.ready || !this.online(agent.id)) return null;
      const next = chooseNext(await tx.all('queueItem'), zone); if (!next) return null;
      try { checkBlacklist(await tx.all('blacklist'), next); }
      catch (error) { await tx.put('queueItem', { ...next, status: 'failed', error: (error as Error).message }); await refundQuota(tx, next); this.events.changed('queue'); return null; }
      const item: QueueItem = { ...next, status: 'preparing', playbackId: id('play') };
      await tx.put('queueItem', item); await tx.put('zone', { ...zone, currentItemId: item.id, revision: zone.revision + 1 }); return { item, agent, volume: zone.volume };
    });
    if (!claim) return;
    return diagnostics.scope({ traceId: traceFor(claim.item.requestKey), itemId: claim.item.id, playbackId: claim.item.playbackId, zoneId, agentId: claim.agent.id }, async () => {
    diagnostics.info('playback.prepare.start', '歌曲进入音源准备阶段');
    this.events.changed('queue');
    try {
      const asset = await this.media.prepare(claim.item);
      await this.store.transaction(async tx => {
        const item = await tx.get('queueItem', claim.item.id); const zone = await tx.get('zone', zoneId); const agent = await tx.get('agent', claim.agent.id);
        if (!item || item.status !== 'preparing' || zone?.currentItemId !== item.id) return;
        checkBlacklist(await tx.all('blacklist'), item);
        if (!agent?.ready || !this.online(agent.id) || !zone.enabled) { await tx.put('queueItem', { ...item, status: 'queued', playbackId: null }); await tx.put('zone', { ...zone, currentItemId: null }); return; }
        await tx.put('queueItem', { ...item, track: { ...item.track, durationSeconds: asset.durationSeconds || item.track.durationSeconds }, status: 'dispatching', assetId: asset.id });
        await this.command(tx, agent.id, zoneId, agent.epoch, item.id, { action: 'start', playbackId: item.playbackId!, queueItemId: item.id, assetId: asset.id, ticket: this.media.ticket(agent.id, asset.id, item.playbackId!), sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime, volume: zone.volume, title: item.track.title, artists: item.track.artists, durationSeconds: asset.durationSeconds });
      });
    } catch (error) { diagnostics.error('playback.prepare.failed', '准备音源失败', { error }); await this.fail(claim.item.id, diagnostics.summary(error)); }
    this.events.changed('queue');
    });
  }
  async recover() {
    await this.store.transaction(async tx => {
      for (const zone of await tx.all('zone')) {
        if (!zone.currentItemId) continue;
        const item = await tx.get('queueItem', zone.currentItemId);
        if (!item || item.status === 'preparing') {
          if (item) await tx.put('queueItem', { ...item, status: 'queued', playbackId: null });
          await tx.put('zone', { ...zone, currentItemId: null });
        }
      }
    });
  }
  async command(tx: UnitOfWork, agentId: string, zoneId: string, epoch: number, itemId: string | null, payload: CommandPayload) {
    const command: Command = { id: id('cmd'), agentId, zoneId, epoch, itemId, payload, state: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + (payload.action === 'seek' ? 10000 : 180000)).toISOString() };
    await tx.put('command', command);
    const item = itemId ? await tx.get('queueItem', itemId) : null;
    diagnostics.info('agent.command.created', '创建待派发的设备指令', { traceId: item ? traceFor(item.requestKey) : undefined, itemId, commandId: command.id, agentId, zoneId, epoch, action: payload.action }); return command;
  }
  async control(zoneId: string, action: 'skip' | 'pause' | 'resume' | 'volume' | 'seek', volume?: number, expectedPlaybackId?: string) {
    await this.store.transaction(async tx => {
      const zone = await tx.get('zone', zoneId); if (!zone) throw new AppError('NOT_FOUND', '播放区不存在', 404);
      const agent = (await tx.all('agent')).find(a => a.zoneId === zoneId);
      if (action === 'volume') {
        if (!Number.isInteger(volume) || volume! < 0 || volume! > 100) throw new AppError('BAD_VOLUME', '音量应在 0–100 之间');
        await tx.put('zone', { ...zone, volume: volume! });
        if (agent && this.online(agent.id)) await this.command(tx, agent.id, zoneId, agent.epoch, null, { action: 'volume', volume: volume! });
      } else {
        const item = zone.currentItemId ? await tx.get('queueItem', zone.currentItemId) : null;
        if (!item?.playbackId) throw new AppError('NO_PLAYBACK', '当前没有播放中的歌曲');
        if (action === 'skip' && item.status === 'preparing') { await tx.put('queueItem', { ...item, status: 'skipped' }); await tx.put('zone', { ...zone, currentItemId: null }); }
        else {
          if (!agent || !this.online(agent.id)) throw new AppError('DEVICE_OFFLINE', '设备离线，等待重新连接后再控制');
          if (action === 'seek') {
            const live = this.events.agentPlayback.get(agent.id);
            if (!expectedPlaybackId || expectedPlaybackId !== item.playbackId || live?.playbackId !== item.playbackId) throw new AppError('PLAYBACK_CHANGED', '歌曲已切换，请刷新播放进度');
            if (!live.supportsSeek) throw new AppError('SEEK_UNSUPPORTED', '请升级 Agent 至 0.1.4 或更高版本');
            if (item.status !== 'playing' || !agent.ready || !live.seekable || !live.durationSeconds) throw new AppError('SEEK_NOT_READY', '当前歌曲尚不可调整进度');
            if (!Number.isInteger(volume) || volume! < 0 || volume! > Math.min(86400, Math.floor(live.durationSeconds) - 1)) throw new AppError('BAD_SEEK', '请填写歌曲时长以内的整数秒');
          }
          if (action === 'skip') {
            await tx.put('queueItem', { ...item, status: 'skipped' });
            for (const command of await tx.all('command')) if (command.itemId === item.id && command.payload.action === 'start') await tx.put('command', { ...command, state: 'done' });
          }
          await this.command(tx, agent.id, zoneId, agent.epoch, item.id, action === 'skip' ? { action: 'stop', playbackId: item.playbackId } : action === 'seek' ? { action, playbackId: item.playbackId, position: volume! } : { action, playbackId: item.playbackId });
        }
      }
      await audit(tx, `playback.${action}`, zoneId, volume?.toString() ?? '管理员操作');
    }); this.events.changed('playback'); return { ok: true };
  }
  async hello(agentId: string, message: Extract<AgentMessage, { type: 'hello' }>, expectedEpoch?: number) {
    diagnostics.info('agent.hello', 'Agent 报告播放器状态', { agentId, ready: message.ready, version: message.version, playbackId: message.playbackId, position: message.position });
    await this.store.transaction(async tx => {
      const agent = await tx.get('agent', agentId); if (!agent || expectedEpoch !== undefined && agent.epoch !== expectedEpoch) return;
      await tx.put('agent', { ...agent, ready: message.ready, position: message.position, lastSeen: now() });
      this.events.agentPlayback.set(agentId, { version: message.version, supportsSeek: message.capabilities?.includes('seek') === true, playbackId: message.playbackId, seekable: message.seekable ?? false, durationSeconds: message.durationSeconds ?? 0 });
      const zone = await tx.get('zone', agent.zoneId); const item = zone?.currentItemId ? await tx.get('queueItem', zone.currentItemId) : null;
      const commands = (await tx.all('command')).filter(c => c.agentId === agent.id && ['pending', 'acked'].includes(c.state));
      for (const command of commands) await tx.put('command', { ...command, state: 'done' });
      if (message.playbackId && message.playbackId === item?.playbackId) {
        if (item.status === 'skipped') await this.command(tx, agent.id, agent.zoneId, agent.epoch, item.id, { action: 'stop', playbackId: message.playbackId });
        else if (item.status === 'dispatching' && message.started !== false) await this.started(tx, item);
      } else if (message.playbackId) {
        // Keep the zone fenced until the agent reports that the unknown player
        // stopped; no new start command is issued during reconciliation.
        await tx.put('agent', { ...agent, ready: false, position: message.position, lastSeen: now() });
        if (item && zone) {
          await tx.put('queueItem', { ...item, status: 'failed', error: '设备当前播放与队列记录不一致' });
          if (item.status !== 'playing') await refundQuota(tx, item);
          await tx.put('zone', { ...zone, currentItemId: null });
        }
        await this.command(tx, agent.id, agent.zoneId, agent.epoch, null, { action: 'stop', playbackId: message.playbackId });
      } else if (item && zone) {
        if (item.status === 'dispatching') await tx.put('queueItem', { ...item, status: 'queued', playbackId: null });
        else { await tx.put('queueItem', { ...item, status: item.status === 'skipped' ? 'skipped' : 'failed', error: '设备重连时当前播放已结束或丢失' }); if (item.status !== 'playing') await refundQuota(tx, item); }
        await tx.put('zone', { ...zone, currentItemId: null });
      }
    }); this.events.changed('agent');
  }
  async message(agentId: string, message: Exclude<AgentMessage, { type: 'hello' }>, expectedEpoch?: number) {
    let rejectedItem: string | null = null;
    await this.store.transaction(async tx => {
      const agent = await tx.get('agent', agentId); if (!agent || expectedEpoch !== undefined && agent.epoch !== expectedEpoch) return;
      if (message.type === 'heartbeat') {
        const zone = await tx.get('zone', agent.zoneId);
        const item = zone?.currentItemId ? await tx.get('queueItem', zone.currentItemId) : null;
        const unexpected = !!message.playbackId && message.playbackId !== item?.playbackId;
        if (agent.ready !== (message.ready && !unexpected)) diagnostics.info('agent.readiness.changed', '设备就绪状态变化', { agentId, ready: message.ready && !unexpected, unexpectedPlayback: unexpected });
        this.events.agentPlayback.set(agentId, { ...this.events.agentPlayback.get(agentId), playbackId: message.playbackId, seekable: message.seekable ?? false, durationSeconds: message.durationSeconds ?? 0 });
        await tx.put('agent', { ...agent, ready: message.ready && !unexpected, lastSeen: now(), position: message.position, paused: message.paused }); return;
      }
      if (message.type === 'ack') {
        const command = await tx.get('command', message.commandId);
        if (!command || command.agentId !== agentId || command.epoch !== agent.epoch || command.state !== 'pending') return;
        await tx.put('command', { ...command, state: message.status === 'rejected' ? 'rejected' : 'acked' });
        const item = command.itemId ? await tx.get('queueItem', command.itemId) : null;
        diagnostics.info('agent.command.ack', 'Agent 确认或拒绝设备指令', { traceId: item ? traceFor(item.requestKey) : undefined, itemId: command.itemId, agentId, commandId: command.id, action: command.payload.action, status: message.status, error: message.error });
        if (message.status === 'rejected' && command.payload.action === 'start') rejectedItem = command.itemId;
        return;
      }
      const zone = await tx.get('zone', agent.zoneId);
      const item = zone?.currentItemId ? await tx.get('queueItem', zone.currentItemId) : null;
      if (!zone || !item || item.playbackId !== message.playbackId) {
        if (message.state !== 'started') for (const command of await tx.all('command')) if (command.agentId === agentId && command.payload.action === 'stop' && command.payload.playbackId === message.playbackId) await tx.put('command', { ...command, state: 'done' });
        return;
      }
      if (message.state === 'started') { if (item.status === 'dispatching') await this.started(tx, item); return; }
      diagnostics.info('agent.playback.event', 'Agent 报告播放结果', { traceId: traceFor(item.requestKey), itemId: item.id, agentId, playbackId: message.playbackId, state: message.state, error: message.error });
      const status = item.status === 'skipped' ? 'skipped' : message.state === 'ended' ? 'completed' : message.state === 'stopped' ? 'skipped' : 'failed';
      await tx.put('queueItem', { ...item, status, error: message.error ?? null });
      if (status === 'failed' && item.status !== 'playing') await refundQuota(tx, item);
      await tx.put('zone', { ...zone, currentItemId: null, revision: zone.revision + 1 });
      for (const command of await tx.all('command')) if (command.itemId === item.id) await tx.put('command', { ...command, state: 'done' });
      await audit(tx, `playback.${status}`, item.id, message.error ?? item.track.title);
    });
    if (rejectedItem) await this.fail(rejectedItem, (message as { error?: string }).error ?? '设备拒绝播放');
    this.events.changed(message.type === 'heartbeat' ? 'heartbeat' : 'playback');
  }
  private async started(tx: UnitOfWork, item: QueueItem) {
    diagnostics.info('playback.started', 'Agent 确认实际开始播放', { traceId: traceFor(item.requestKey), itemId: item.id, playbackId: item.playbackId });
    await tx.put('queueItem', { ...item, status: 'playing' });
    const zone = await tx.get('zone', item.zoneId);
    if (zone) await tx.put('zone', { ...zone, priorityStreak: item.priority > 0 ? zone.priorityStreak + 1 : 0 });
    await audit(tx, 'playback.started', item.id, item.track.title);
  }
  async fail(itemId: string, error: string) {
    await this.store.transaction(async tx => {
      const item = await tx.get('queueItem', itemId); if (!item || !['preparing', 'dispatching'].includes(item.status)) return;
      error = diagnostics.summary(error);
      diagnostics.error('playback.failed', '歌曲播放任务失败', { traceId: traceFor(item.requestKey), itemId, error });
      await tx.put('queueItem', { ...item, status: 'failed', error: error.slice(0, 500) }); await refundQuota(tx, item);
      const zone = await tx.get('zone', item.zoneId); if (zone?.currentItemId === itemId) await tx.put('zone', { ...zone, currentItemId: null });
      await audit(tx, 'playback.failed', itemId, error);
    }); this.events.changed('queue');
  }
}
