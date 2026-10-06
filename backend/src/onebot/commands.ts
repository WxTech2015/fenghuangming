import type { GroupBinding, QueueItem } from '../contracts';
import { PROJECT_INFO } from '../contracts';
import { Store } from '../core/store';
import { AppError } from '../core/errors';
import { audit, chooseNext, dateInShanghai, pending, settings } from '../core/domain';
import { QueueService } from '../queues/queue';
import { PlaybackService } from '../playback/playback';
import { parseMusicCard } from './cards';

export interface GroupRequest { binding: GroupBinding; userId: string; userName: string; requestKey: string; isAdmin: () => Promise<boolean> }
const line = (value: string, limit = 100) => value.replace(/[\r\n\t]+/g, ' ').slice(0, limit);
export const itemCode = (item: QueueItem) => item.id.slice(-8);
const song = (item: QueueItem) => `${line(item.track.title)}${item.track.artists.length ? ` · ${line(item.track.artists.join('/'))}` : ''}`;
const states: Record<string, string> = { queued: '待播', review: '待审核', preparing: '准备音源', dispatching: '等待播放器', playing: '播放中' };

export const groupMenu = (zoneName: string, limit: number) => [
  `♫ ${PROJECT_INFO.name} · ${line(zoneName)} 点歌菜单`,
  '分享音乐卡片或链接即可点歌',
  '#点歌 <音乐链接>  添加歌曲',
  '#正在播放  查看当前歌曲',
  '#队列  查看待播歌曲',
  '#我的  我的点歌与今日额度',
  '#插队 [编号]  优先播放自己的待播歌曲',
  '#取消 [编号]  取消自己的待播/待审核歌曲',
  '#歌单  查看本播放区歌单',
  '#歌单 <序号或名称>  将歌单加入队列',
  '#menu / #菜单 / #帮助  显示菜单',
  `每日插队 ${limit} 次；不填编号操作自己最近一首。`,
  '群主/管理员：#切歌、#暂停、#继续、#音量 0-100',
  '多群共用播放区时，播放控制会作用于同一台电脑。',
].join('\n');

/** Group commands reuse queue and playback rules; transport only supplies identity and replies. */
export class GroupCommands {
  constructor(readonly store: Store, readonly queue: QueueService, readonly playback: PlaybackService) {}
  async handle(plain: string, request: GroupRequest): Promise<string | null> {
    const match = /^(?:#|＃|\/)(\S+)(?:\s+([\s\S]*))?$/.exec(plain.trim());
    const name = match?.[1]?.toLowerCase() ?? (plain === '插队' ? '插队' : '');
    if (!name) return null;
    const argument = match?.[2]?.trim() ?? '';
    const { binding, userId, userName, requestKey } = request;
    const snapshot = await this.store.transaction(async tx => ({ zone: await tx.get('zone', binding.zoneId), config: await settings(tx), items: await tx.all('queueItem'), agents: await tx.all('agent'), playlists: (await tx.all('playlist')).filter(p => p.zoneId === binding.zoneId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), quota: await tx.get('quota', `${userId}:${dateInShanghai()}`) }));
    const { zone, config } = snapshot; if (!zone) throw new AppError('NOT_FOUND', '本群播放区不存在');
    if (['menu', '菜单', '帮助', 'help'].includes(name)) return groupMenu(zone.name, config.dailyJumpLimit);
    if (['正在播放', '当前', 'now'].includes(name)) {
      const item = snapshot.items.find(item => item.id === zone.currentItemId);
      if (!item) return `♫ ${line(zone.name)}\n当前没有播放歌曲。`;
      const agent = snapshot.agents.find(agent => agent.zoneId === zone.id);
      const seconds = agent?.position ?? 0;
      return `♫ ${line(zone.name)} · ${states[item.status] ?? '等待结束'}${agent?.paused ? '（已暂停）' : ''}\n${song(item)}\n点歌人：${line(item.userName || item.userId)}\n进度 ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')} · 音量 ${zone.volume}%`;
    }
    if (['队列', 'queue'].includes(name)) {
      // Simulate the same fairness rule as the scheduler, so the displayed order is useful.
      const remaining = snapshot.items.filter(item => item.zoneId === zone.id && item.status === 'queued');
      const ordered: QueueItem[] = []; let priorityStreak = zone.priorityStreak;
      const dispatching = snapshot.items.find(item => item.id === zone.currentItemId && item.status === 'dispatching');
      if (dispatching) priorityStreak = dispatching.priority ? priorityStreak + 1 : 0;
      while (remaining.length) { const next = chooseNext(remaining, { ...zone, priorityStreak })!; ordered.push(next); remaining.splice(remaining.indexOf(next), 1); priorityStreak = next.priority ? priorityStreak + 1 : 0; }
      const reviews = snapshot.items.filter(item => item.zoneId === zone.id && item.status === 'review').length;
      return [`♫ ${line(zone.name)} · 待播 ${ordered.length} 首 / 待审核 ${reviews} 首`, ...ordered.slice(0, 15).map((item, i) => `${i + 1}. [${itemCode(item)}] ${song(item)}${item.priority ? ' ★插队' : ''} · ${line(item.userName || item.userId, 40)}`), ordered.length > 15 ? '仅显示前 15 首。' : ordered.length ? '' : '目前没有待播歌曲。', '插队/取消请使用方括号中的任务编号。'].filter(Boolean).join('\n');
    }
    if (['我的', 'my'].includes(name)) {
      const mine = snapshot.items.filter(item => item.zoneId === zone.id && item.userId === userId && pending(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return [`♫ 我的点歌 · ${line(zone.name)}`, `今日插队：${snapshot.quota?.used ?? 0}/${config.dailyJumpLimit}，剩余 ${Math.max(0, config.dailyJumpLimit - (snapshot.quota?.used ?? 0))} 次（上海日期，跨群共享）`, ...mine.slice(0, 15).map(item => `[${itemCode(item)}] ${song(item)} · ${states[item.status] ?? item.status}${item.priority ? ' ★插队' : ''}`), mine.length ? '' : '你还没有待播歌曲。'].filter(Boolean).join('\n');
    }
    if (['插队', '取消'].includes(name)) {
      const candidates = snapshot.items.filter(item => item.zoneId === zone.id && item.botId === binding.botId && item.groupId === binding.groupId && item.userId === userId && (name === '插队' ? item.status === 'queued' && (argument || item.priority === 0) : ['queued', 'review'].includes(item.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const matches = argument ? candidates.filter(item => itemCode(item) === argument || item.id === argument) : candidates.slice(0, 1);
      if (!matches.length) return `没有可${name}的本群点歌；只能操作自己的${name === '插队' ? '待播' : '待播或待审核'}歌曲。发送 #我的 查看编号。`;
      if (matches.length > 1) return '任务编号重复，请使用后台显示的完整任务 ID。';
      const item = matches[0]!;
      if (name === '插队') { await this.queue.promote(item.id, userId); return `已插队：[${itemCode(item)}] ${song(item)}\n将在优先队列播放，不打断当前歌曲。`; }
      await this.queue.cancel(item.id, userId); return `已取消：[${itemCode(item)}] ${song(item)}`;
    }
    if (name === '点歌') {
      const track = await parseMusicCard([{ type: 'text', data: { text: argument } }]);
      if (!track) return '请发送 #点歌 <音乐分享链接>，或直接分享音乐卡片。';
      return this.enqueued(await this.queue.enqueue({ botId: binding.botId, groupId: binding.groupId, zoneId: binding.zoneId, userId, userName, requestKey, track }));
    }
    if (name === '歌单') {
      const playlists = snapshot.playlists;
      if (!argument) return [`♫ ${line(zone.name)} · 歌单`, ...playlists.slice(0, 30).map((p, i) => `${i + 1}. ${line(p.name)}（${p.tracks.length} 首）`), playlists.length ? '发送 #歌单 <序号或完整名称> 入队，歌曲计入你的待播上限。' : '暂无歌单，请管理员在后台创建。', playlists.length > 30 ? '仅显示前 30 个；其他歌单可使用完整名称。' : ''].filter(Boolean).join('\n');
      const exact = playlists.filter(p => p.name === argument);
      if (exact.length > 1) return '存在同名歌单，请使用列表序号。';
      const playlist = exact[0] ?? (/^[1-9]\d*$/.test(argument) ? playlists[Number(argument) - 1] : undefined);
      if (!playlist) return '找不到本播放区歌单，发送 #歌单 查看列表。';
      const results = await this.queue.enqueuePlaylist(playlist.id, { zoneId: binding.zoneId, botId: binding.botId, groupId: binding.groupId, userId, userName, requestKey });
      const failures = results.filter(result => result.error);
      return `歌单「${line(playlist.name)}」：${results.length - failures.length} 首已提交，${failures.length} 首未入队。${failures.length ? `\n${line(failures[0]!.error!, 300)}` : ''}\n发送 #我的 查看待播与审核状态。`;
    }
    const controls: Record<string, 'skip' | 'pause' | 'resume' | 'volume'> = { 切歌: 'skip', 跳过: 'skip', 暂停: 'pause', 继续: 'resume', 音量: 'volume' };
    const action = controls[name];
    if (action) {
      if (!await request.isAdmin()) throw new AppError('FORBIDDEN', '此功能仅限群主或群管理员', 403);
      if (action === 'volume' && !/^(?:100|[1-9]?\d)$/.test(argument)) return '用法：#音量 0-100';
      await this.playback.control(zone.id, action, action === 'volume' ? Number(argument) : undefined);
      await this.store.transaction(tx => audit(tx, `onebot.${action}`, binding.groupId, `${userId} 控制 ${zone.id}`));
      return action === 'volume' ? `已设置 ${line(zone.name)} 音量：${argument}%` : `已发送${name}指令。`;
    }
    return plain.startsWith('#') || plain.startsWith('＃') ? '未识别的点歌指令，发送 #menu 查看功能菜单。' : null;
  }
  enqueued(item: QueueItem) { return item.status === 'review' ? `已收到：[${itemCode(item)}] ${song(item)}\n等待管理员审核；发送 #我的 查看状态。` : `已加入队列：[${itemCode(item)}] ${song(item)}\n发送 #队列 查看排队，#插队 可优先播放。`; }
}
