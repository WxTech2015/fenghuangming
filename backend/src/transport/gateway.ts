import type { Server } from 'node:http';
import { AgentMessageSchema } from '../contracts';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from '../core/store';
import { hashToken } from '../core/system';
import { audit, chooseNext, now } from '../core/domain';
import { Events } from '../core/events';
import { PlaybackService } from '../playback/playback';
import { QueueService } from '../queues/queue';
import { parseMusicCard } from '../onebot/cards';
import { OneBotClient, qqId } from '../onebot/client';
import { GroupCommands } from '../onebot/commands';
import { AppError } from '../core/errors';
import { diagnostics, traceFor } from '../core/diagnostics';

interface Session { socket: WebSocket; epoch: number; hello: boolean; lastSeen: number }
export class Gateway {
  readonly sessions = new Map<string, Session>();
  readonly bots = new Set<WebSocket>();
  private readonly botClients = new Map<WebSocket, OneBotClient>();
  private readonly botById = new Map<string, OneBotClient>();
  private readonly seenMessages = new Map<string, number>();
  private readonly groupCommands: GroupCommands;
  private readonly agents = new WebSocketServer({ noServer: true, maxPayload: 64000 });
  private readonly onebot = new WebSocketServer({ noServer: true, maxPayload: 256000 });
  private timer?: NodeJS.Timeout;
  constructor(readonly store: Store, readonly events: Events, readonly queue: QueueService, readonly playback: PlaybackService, readonly botToken: string) { this.groupCommands = new GroupCommands(store, queue, playback); }
  online(agentId: string) { const session = this.sessions.get(agentId); return !!session?.hello && session.socket.readyState === WebSocket.OPEN && Date.now() - session.lastSeen < 45000; }
  attach(server: Server) {
    server.on('upgrade', (request, socket, head) => {
      void (async () => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        const token = request.headers.authorization?.replace(/^Bearer /i, '') ?? '';
        if (path === '/ws/onebot' && this.botToken && token === this.botToken) {
          this.onebot.handleUpgrade(request, socket, head, ws => this.bot(ws)); return;
        }
        if (path === '/ws/agents' && token) {
          const agent = await this.store.transaction(async tx => {
            const found = (await tx.all('agent')).find(a => a.tokenHash === hashToken(token));
            if (!found) return null;
            const value = { ...found, epoch: found.epoch + 1, ready: false, lastSeen: now() }; await tx.put('agent', value); return value;
          });
          if (agent) { this.agents.handleUpgrade(request, socket, head, ws => this.agent(agent.id, agent.zoneId, agent.epoch, ws)); return; }
        }
        diagnostics.warn('gateway.auth.rejected', 'WebSocket 入口或凭证不匹配', { path, credentialPresent: !!token }); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      })().catch(error => { diagnostics.error('gateway.upgrade.failed', 'WebSocket 握手处理失败', { error }); socket.destroy(); });
    });
    this.timer = setInterval(() => { void this.flush().catch(error => diagnostics.error('gateway.flush.failed', '设备链路错误', { error })); void this.playback.tick().catch(error => diagnostics.error('queue.tick.failed', '队列调度错误', { error })); }, 1000);
    this.timer.unref();
  }
  private agent(agentId: string, zoneId: string, epoch: number, socket: WebSocket) {
    diagnostics.info('agent.connected', 'Agent WebSocket 已连接', { agentId, zoneId, epoch });
    this.sessions.get(agentId)?.socket.close(4001, 'superseded');
    const session: Session = { socket, epoch, hello: false, lastSeen: Date.now() }; this.sessions.set(agentId, session);
    this.events.agentPlayback.delete(agentId);
    let work = Promise.resolve();
    socket.on('error', error => diagnostics.warn('agent.socket.error', 'Agent 连接错误', { agentId, error }));
    socket.on('message', raw => {
      work = work.then(async () => {
        if (this.sessions.get(agentId) !== session) return;
        const parsed = AgentMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) { diagnostics.warn('agent.message.invalid', 'Agent 消息不符合协议', { agentId, error: parsed.error }); socket.close(1008, 'invalid message'); return; }
        session.lastSeen = Date.now(); const message = parsed.data;
        if (message.type === 'hello') { if (session.hello) return; await this.playback.hello(agentId, message, epoch); session.hello = true; socket.send(JSON.stringify({ type: 'welcome', v: 1, agentId, zoneId, epoch, leaseMs: 60000 })); }
        else if (session.hello) { await this.playback.message(agentId, message, epoch); if (message.type === 'playback') socket.send(JSON.stringify({ type: 'event-ack', eventId: message.eventId })); }
      }).catch(error => { diagnostics.warn('agent.message.failed', 'Agent 消息处理失败', { agentId, error }); socket.close(1008, 'invalid message'); });
    });
    socket.on('close', (code, reason) => {
      diagnostics.info('agent.disconnected', 'Agent WebSocket 已断开', { agentId, code, reason: reason.toString() });
      if (this.sessions.get(agentId) !== session) return;
      this.sessions.delete(agentId);
      this.events.agentPlayback.delete(agentId);
      void this.store.transaction(async tx => { const agent = await tx.get('agent', agentId); if (agent?.epoch === epoch) await tx.put('agent', { ...agent, ready: false }); }).then(() => this.events.changed('agent')).catch(error => diagnostics.error('agent.disconnect.persist_failed', '保存设备断开状态失败', { agentId, error }));
    });
  }
  private bot(socket: WebSocket) {
    diagnostics.info('onebot.connected', 'NapCat WebSocket 已连接');
    this.bots.add(socket);
    let work = Promise.resolve();
    const client = new OneBotClient(socket, info => {
      if (info.connected) {
        if (socket.readyState !== WebSocket.OPEN) return;
        const old = this.botById.get(info.id); this.botById.set(info.id, client);
        if (old && old !== client) old.socket.close(4001, 'superseded');
        this.events.bots.set(info.id, info); this.events.onebotError = null;
      } else if (this.botById.get(info.id) === client) { this.botById.delete(info.id); this.events.bots.set(info.id, info); }
      this.events.botConnected = this.botById.size > 0; this.events.changed('onebot');
    }, event => {
      // API responses are handled immediately by OneBotClient, even while a command awaits one.
      work = work.then(async () => { await initialized; await this.botMessage(client, event); }).catch(error => diagnostics.error('onebot.message.failed', '群消息处理失败', { error }));
    }, () => { diagnostics.info('onebot.disconnected', 'NapCat WebSocket 已断开', { botId: client.info?.id }); this.bots.delete(socket); this.botClients.delete(socket); });
    this.botClients.set(socket, client);
    const initialized = client.refresh().catch(error => {
      diagnostics.warn('onebot.identity.failed', '读取 NapCat 登录账号或群列表失败', { error });
      if (socket.readyState === WebSocket.OPEN) { this.events.onebotError = diagnostics.summary(error); this.events.changed('onebot'); }
    });
  }
  async refreshBots() {
    if (!this.botClients.size) throw new AppError('BOT_NOT_CONNECTED', 'NapCat 尚未连接');
    const results = await Promise.allSettled([...this.botClients.values()].map(client => client.refresh()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AppError('BOT_SYNC_FAILED', errors[0]!.reason instanceof Error ? errors[0]!.reason.message : 'NapCat 同步失败');
    return { ok: true };
  }
  private async botMessage(client: OneBotClient, message: Record<string, unknown>) {
    const botId = client.info?.id;
    if (!botId || this.botById.get(botId) !== client || qqId(message.self_id) !== botId) return;
    if (message.post_type === 'notice' && qqId(message.user_id) === botId && ['group_increase', 'group_decrease'].includes(String(message.notice_type))) { await client.refresh(); return; }
    if (message.post_type !== 'message' || message.message_type !== 'group' || String(message.user_id) === botId) return;
    const groupId = qqId(message.group_id); const userId = qqId(message.user_id);
    if (!groupId || !userId || !['string', 'number'].includes(typeof message.message_id)) return;
    const binding = await this.store.transaction(async tx => (await tx.all('binding')).find(b => b.enabled && b.botId === botId && b.groupId === groupId));
    if (!binding) { diagnostics.debug('onebot.group.ignored', '群未绑定播放区，忽略消息', { botId, groupId }); return; }
    const requestKey = `onebot:${botId}:${groupId}:${String(message.message_id)}`;
    if (this.seenMessages.has(requestKey) && Date.now() - this.seenMessages.get(requestKey)! < 1800000) return;
    this.seenMessages.set(requestKey, Date.now());
    if (this.seenMessages.size > 2000) this.seenMessages.delete(this.seenMessages.keys().next().value!);
    const reply = (text: string) => client.reply(groupId, text);
    return diagnostics.scope({ traceId: traceFor(requestKey), botId, groupId, userId, zoneId: binding.zoneId }, async () => {
    try {
      // String text and array segments are both valid OneBot message representations.
      const segments = typeof message.message === 'string' ? [{ type: 'text', data: { text: message.message } }] : message.message;
      const plain = Array.isArray(segments) ? segments.filter(s => s?.type === 'text').map(s => String(s.data?.text ?? '')).join('').trim() : '';
      const sender = message.sender as { card?: string; nickname?: string } | undefined;
      const userName = String(sender?.card || sender?.nickname || userId).slice(0, 100);
      const response = await this.groupCommands.handle(plain, { binding, userId, userName, requestKey, isAdmin: () => client.isGroupAdmin(groupId, userId) });
      if (response !== null) { diagnostics.info('onebot.command.handled', '已处理群内菜单或指令', { command: plain.split(/\s/)[0]?.slice(0, 50) }); reply(response); return; }
      const track = await parseMusicCard(segments); if (!track) return;
      const item = await this.queue.enqueue({ botId, groupId, zoneId: binding.zoneId, userId, userName, track, requestKey });
      reply(this.groupCommands.enqueued(item));
    } catch (error) { diagnostics.warn('onebot.request.rejected', '群点歌或指令未完成', { error }); const text = diagnostics.summary(error); reply(`操作未完成：${text}${diagnostics.current().traceEnabled ? '\n追踪 ID：' + traceFor(requestKey) : ''}`); await this.store.transaction(tx => audit(tx, 'onebot.rejected', groupId, text)); this.events.changed('onebot'); }
    });
  }
  private lastFlush = 0;
  private flushing?: Promise<void>;
  async flush(force = false) {
    // 控制请求需在上一轮完成后重读命令，避免被旧快照和五秒节流漏掉。
    if (this.flushing) { if (force) { await this.flushing; await this.flush(true); } return; }
    if (!force && Date.now() - this.lastFlush < 5000) return;
    this.lastFlush = Date.now();
    const running = this.sendPending(); this.flushing = running;
    try { await running; } finally { if (this.flushing === running) this.flushing = undefined; }
  }
  private async sendPending() {
    const overviewData = await this.store.transaction(async tx => ({ commands: await tx.all('command'), agents: await tx.all('agent'), zones: await tx.all('zone'), items: await tx.all('queueItem') }));
    const commands = overviewData.commands;
    for (const [agentId, session] of this.sessions) {
      if (Date.now() - session.lastSeen > 45000) { session.socket.terminate(); continue; }
      if (!session.hello || session.socket.readyState !== WebSocket.OPEN) continue;
      session.socket.send(JSON.stringify({ type: 'lease', epoch: session.epoch, leaseMs: 60000 }));
      const agent = overviewData.agents.find(value => value.id === agentId);
      const zone = overviewData.zones.find(value => value.id === agent?.zoneId);
      if (zone) {
        const waiting = overviewData.items.filter(item => item.zoneId === zone.id && ['queued', 'review'].includes(item.status));
        const current = overviewData.items.find(item => item.id === zone.currentItemId);
        let virtual = { ...zone, priorityStreak: current && current.status !== 'playing' ? current.priority > 0 ? zone.priorityStreak + 1 : 0 : zone.priorityStreak };
        let remaining = [...waiting]; const ordered: typeof waiting = [];
        for (let n = 0; n < 10; n++) { const next = chooseNext(remaining, virtual); if (!next) break; ordered.push(next); remaining = remaining.filter(item => item.id !== next.id); virtual = { ...virtual, priorityStreak: next.priority > 0 ? virtual.priorityStreak + 1 : 0 }; }
        ordered.push(...waiting.filter(item => item.status === 'review').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 10 - ordered.length));
        session.socket.send(JSON.stringify({ type: 'overview', v: 1, zone: { id: zone.id, name: zone.name, enabled: zone.enabled, volume: zone.volume }, waitingCount: waiting.length, queue: ordered.map(item => ({ id: item.id, title: item.track.title, artists: item.track.artists, status: item.status === 'queued' && item.assetId ? '已预热' : item.status === 'review' ? '待审核' : '待播放' })) }));
      }
      for (const command of commands.filter(c => c.agentId === agentId && c.epoch === session.epoch && c.state === 'pending')) {
        if (Date.parse(command.expiresAt) < Date.now()) {
          await this.store.transaction(tx => tx.put('command', { ...command, state: 'rejected' }));
          if (command.itemId && command.payload.action === 'start') await this.playback.fail(command.itemId, '设备未在时限内接收播放任务');
        } else {
          const item = command.itemId ? await this.store.transaction(tx => tx.get('queueItem', command.itemId!)) : null;
          diagnostics.debug('agent.command.send', '派发或重发设备指令', { traceId: item ? traceFor(item.requestKey) : undefined, commandId: command.id, agentId, itemId: command.itemId, action: command.payload.action, epoch: command.epoch }); session.socket.send(JSON.stringify({ v: 1, kind: 'command', ...command }));
        }
      }
    }
  }
  close() { if (this.timer) clearInterval(this.timer); for (const s of this.sessions.values()) s.socket.terminate(); for (const b of this.bots) b.terminate(); this.agents.close(); this.onebot.close(); }
}
