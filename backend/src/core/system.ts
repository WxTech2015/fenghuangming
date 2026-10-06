import { createHash, randomBytes } from 'node:crypto';
import { BindingSchema, BlacklistSchema, EngineSchema, SettingsSchema, TrackSchema, ZoneSchema, type Snapshot } from '../contracts';
import { z } from 'zod';
import { Store } from './store';
import { audit, id, now, settings } from './domain';
import { Events } from './events';
import { AppError } from './errors';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export class SystemService {
  constructor(readonly store: Store, readonly events: Events) {}
  async init() {
    await this.store.transaction(async tx => {
      const old = (await tx.get('setting', 'settings'))?.value;
      // Preserve a deliberately configured external service when upgrading.
      const mode = old?.gomusicdl?.mode ?? ((old?.audioEngine as string) === 'gomusicdl' ? 'external' : 'managed');
      const audioEngine = EngineSchema.safeParse(old?.audioEngine).success ? old!.audioEngine : 'gomusicdl';
      const value = SettingsSchema.parse({ ...old, audioEngine, gomusicdl: { ...old?.gomusicdl, mode } });
      await tx.put('setting', { id: 'settings', value });
      for (const item of await tx.all('queueItem')) if (!EngineSchema.safeParse(item.engine).success) await tx.put('queueItem', { ...item, engine: 'gomusicdl' });
      if (!(await tx.all('zone')).length) await tx.put('zone', { id: 'zone_default', ...ZoneSchema.parse({ name: '默认播放区' }), revision: 0, currentItemId: null, priorityStreak: 0 });
      for (const agent of await tx.all('agent')) await tx.put('agent', { ...agent, ready: false });
    });
  }
  async snapshot(): Promise<Snapshot> {
    return this.store.transaction(async tx => ({
      storageDriver: this.store.driver, settings: await settings(tx), zones: await tx.all('zone'), bindings: await tx.all('binding'),
      agents: (await tx.all('agent')).map(({ tokenHash, ...agent }) => ({ ...agent, ...this.events.agentPlayback.get(agent.id) })),
      queue: (await tx.all('queueItem')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1000),
      blacklists: await tx.all('blacklist'), quotas: await tx.all('quota'), playlists: await tx.all('playlist'),
      audit: (await tx.all('audit')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100), botConnected: this.events.botConnected,
      bots: structuredClone([...this.events.bots.values()]), onebotError: this.events.onebotError, musicRuntime: { ...(this.events.musicRuntimes[(await settings(tx)).audioEngine] ?? this.events.musicRuntime) }, musicRuntimes: structuredClone(this.events.musicRuntimes),
    }));
  }
  async saveSettings(input: unknown) {
    const value = SettingsSchema.parse(input);
    await this.store.transaction(async tx => { await tx.put('setting', { id: 'settings', value }); await audit(tx, 'settings.update', 'settings', `音源 ${value.audioEngine}，每日插队 ${value.dailyJumpLimit}`); });
    this.events.changed('settings'); return value;
  }
  async saveZone(input: unknown, existingId?: string) {
    const parsed = ZoneSchema.parse(input);
    const zone = await this.store.transaction(async tx => {
      const old = existingId ? await tx.get('zone', existingId) : null;
      if (existingId && !old) throw new AppError('NOT_FOUND', '播放区不存在', 404);
      const next = { id: existingId ?? id('zone'), revision: (old?.revision ?? 0) + 1, currentItemId: old?.currentItemId ?? null, priorityStreak: old?.priorityStreak ?? 0, ...parsed };
      await tx.put('zone', next); await audit(tx, 'zone.save', next.id, parsed.name); return next;
    });
    this.events.changed('zone'); return zone;
  }
  async bind(input: unknown) {
    const data = BindingSchema.parse(input);
    const connected = [...this.events.bots.values()].filter(bot => bot.connected);
    const botId = data.botId ?? (connected.length === 1 ? connected[0]!.id : '');
    const bot = this.events.bots.get(botId);
    const result = await this.store.transaction(async tx => {
      if (!await tx.get('zone', data.zoneId)) throw new AppError('NOT_FOUND', '播放区不存在', 404);
      const previous = (await tx.all('binding')).find(x => x.botId === botId && x.groupId === data.groupId);
      // Existing bindings remain manageable when NapCat is temporarily offline.
      if (!previous && !bot?.connected) throw new AppError('BOT_NOT_CONNECTED', '先连接 NapCat，机器人账号会自动读取');
      if (!previous && !bot?.groups.some(group => group.id === data.groupId)) throw new AppError('GROUP_NOT_FOUND', '该群不在 NapCat 当前账号的群列表中，请刷新群列表');
      const value = { id: previous?.id ?? id('binding'), ...data, botId };
      await tx.put('binding', value); await audit(tx, 'binding.save', value.id, `${botId} / ${data.groupId} → ${data.zoneId}`); return value;
    }); this.events.changed('binding'); return result;
  }
  async blacklist(input: unknown) {
    const data = BlacklistSchema.parse(input);
    const value = { id: id('ban'), ...data, createdAt: now() };
    await this.store.transaction(async tx => { await tx.put('blacklist', value); await audit(tx, 'blacklist.add', value.id, `${data.kind} ${data.value}: ${data.reason}`); });
    this.events.changed('blacklist'); return value;
  }
  async playlist(input: unknown, existingId?: string) {
    const data = z.object({ name: z.string().min(1).max(100), zoneId: z.string().min(1).max(100), tracks: z.array(TrackSchema).max(300) }).parse(input);
    const result = await this.store.transaction(async tx => {
      if (!await tx.get('zone', data.zoneId)) throw new AppError('NOT_FOUND', '播放区不存在', 404);
      const previous = existingId ? await tx.get('playlist', existingId) : null;
      if (existingId && !previous) throw new AppError('NOT_FOUND', '歌单不存在', 404);
      const value = { id: existingId ?? id('playlist'), ...data, createdAt: previous?.createdAt ?? now() };
      await tx.put('playlist', value); await audit(tx, 'playlist.save', value.id, `${value.name} / ${value.tracks.length} 首`); return value;
    }); this.events.changed('playlist'); return result;
  }
  async registerAgent(input: unknown) {
    const data = z.object({ name: z.string().min(1).max(80), zoneId: z.string().min(1).max(100) }).parse(input);
    const token = randomBytes(32).toString('base64url');
    const agent = await this.store.transaction(async tx => {
      if (!await tx.get('zone', data.zoneId)) throw new AppError('NOT_FOUND', '播放区不存在', 404);
      if ((await tx.all('agent')).some(a => a.zoneId === data.zoneId)) throw new AppError('DEVICE_EXISTS', '此播放区已有设备，请先移除原设备');
      const value = { id: id('agent'), ...data, tokenHash: hashToken(token), lastSeen: null, ready: false, epoch: 0, position: 0, paused: false };
      await tx.put('agent', value); await audit(tx, 'agent.register', value.id, data.name); return value;
    }); this.events.changed('agent'); const { tokenHash, ...publicAgent } = agent; return { agent: publicAgent, token };
  }
  async remove(table: 'binding' | 'blacklist' | 'playlist' | 'agent', entityId: string) {
    await this.store.transaction(async tx => {
      if (table === 'agent') {
        const agent = await tx.get('agent', entityId);
        if (agent && (await tx.get('zone', agent.zoneId))?.currentItemId) throw new AppError('DEVICE_BUSY', '先停止当前播放，再移除设备');
      }
      await tx.remove(table, entityId); await audit(tx, `${table}.remove`, entityId, '管理员移除');
    }); this.events.changed(table); return { ok: true };
  }
}
