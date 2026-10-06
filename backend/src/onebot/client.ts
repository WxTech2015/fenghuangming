import { WebSocket } from 'ws';
import type { NapCatBot } from '../contracts';
import { id, now } from '../core/domain';
import { diagnostics } from '../core/diagnostics';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const qqId = (value: unknown) => /^(?:[1-9]\d{0,19})$/.test(String(value)) ? String(value) : '';

/** OneBot actions and their echo responses share the same reverse WebSocket. */
export class OneBotClient {
  info?: NapCatBot;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; action: string }>();
  private refreshing?: Promise<void>;
  constructor(readonly socket: WebSocket, readonly onInfo: (info: NapCatBot) => void, readonly onEvent: (event: RecordValue) => void, readonly onClose: () => void) {
    socket.on('error', error => diagnostics.warn('onebot.socket.error', 'NapCat WebSocket 连接错误', { error }));
    socket.on('message', raw => {
      let event: RecordValue;
      try { event = object(JSON.parse(raw.toString())); } catch { return; }
      const pending = typeof event.echo === 'string' ? this.pending.get(event.echo) : undefined;
      if (pending) {
        this.pending.delete(event.echo as string); clearTimeout(pending.timer);
        if (event.status === 'ok' && event.retcode === 0) pending.resolve(event.data);
        else { diagnostics.warn('onebot.api.failed', 'NapCat 接口调用失败', { action: pending.action, status: event.status, retcode: event.retcode, message: event.message ?? event.wording }); pending.reject(new Error(`NapCat ${pending.action} 接口调用失败（retcode ${event.retcode}）：${diagnostics.summary(event.message ?? event.wording ?? '无错误说明')}`)); }
        return;
      }
      if (event.post_type) this.onEvent(event);
    });
    socket.on('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('NapCat 已断开')); }
      this.pending.clear();
      if (this.info) { this.info = { ...this.info, connected: false }; this.onInfo(this.info); }
      this.onClose();
    });
  }
  request(action: string, params: RecordValue = {}): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NapCat 未连接'));
    const echo = id('onebot');
    diagnostics.debug('onebot.api.request', '调用 NapCat 接口', { action, echo });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); diagnostics.warn('onebot.api.timeout', 'NapCat 接口响应超时', { action, echo }); reject(new Error(`NapCat ${action} 响应超时`)); }, 5000);
      timer.unref(); this.pending.set(echo, { resolve, reject, timer, action });
      this.socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('NapCat 请求发送失败')); }
      });
    });
  }
  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.loadIdentity().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async loadIdentity() {
    const login = object(await this.request('get_login_info'));
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('NapCat 已断开');
    const botId = qqId(login.user_id); if (!botId) throw new Error('NapCat 未返回有效的登录 QQ 号');
    if (this.info && this.info.id !== botId) this.onInfo({ ...this.info, connected: false });
    this.info = { id: botId, nickname: typeof login.nickname === 'string' ? login.nickname.slice(0, 100) : botId, connected: true, groups: this.info?.id === botId ? this.info.groups : [], lastSyncedAt: this.info?.id === botId ? this.info.lastSyncedAt : null, syncError: null };
    diagnostics.info('onebot.identity.ready', '已读取 NapCat 实际登录账号', { botId, nickname: this.info.nickname });
    this.onInfo(this.info);
    try {
      const data = await this.request('get_group_list'); if (!Array.isArray(data)) throw new Error('NapCat 群列表格式不正确');
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('NapCat 已断开');
      const groups = data.map(value => { const group = object(value); return { id: qqId(group.group_id), name: typeof group.group_name === 'string' ? group.group_name.slice(0, 100) : String(group.group_id) }; }).filter(group => group.id);
      this.info = { ...this.info, groups: [...new Map(groups.map(group => [group.id, group])).values()], lastSyncedAt: now(), syncError: null };
      diagnostics.info('onebot.groups.ready', 'NapCat 群列表已同步', { botId, groupCount: this.info.groups.length });
      this.onInfo(this.info);
    } catch (error) {
      this.info = { ...this.info, syncError: error instanceof Error ? error.message : '无法同步群列表' }; this.onInfo(this.info); throw error;
    }
  }
  async isGroupAdmin(groupId: string, userId: string) {
    const member = object(await this.request('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: true }));
    return qqId(member.group_id) === groupId && qqId(member.user_id) === userId && ['owner', 'admin'].includes(String(member.role));
  }
  reply(groupId: string, text: string) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: Number(groupId), message: [{ type: 'text', data: { text: text.slice(0, 3500) } }] }, echo: id('reply') }));
  }
}
