import { createHash, randomUUID } from 'node:crypto';
import type { Blacklist, QueueItem, Settings, Zone } from '../contracts';
import type { UnitOfWork } from './store';
import { AppError } from './errors';
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const dateInShanghai = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export const pending = (item: QueueItem) => ['review', 'queued', 'preparing', 'dispatching', 'playing'].includes(item.status);
export const trackKey = (track: QueueItem['track']) => `${track.platform}:${track.externalId || 'link_' + createHash('sha256').update(track.shareUrl + track.title + track.artists.join('/')).digest('hex')}`;
export function checkBlacklist(rules: Blacklist[], input: Pick<QueueItem, 'zoneId' | 'groupId' | 'userId' | 'track'>) {
  const rule = rules.find(r => (r.scope === 'global' || r.scope === 'zone' && r.scopeId === input.zoneId || r.scope === 'group' && r.scopeId === input.groupId) && (r.kind === 'user' ? r.value === input.userId : r.value === trackKey(input.track)));
  if (rule) throw new AppError('BLACKLISTED', rule.reason || '已被禁用', 403);
}
export function chooseNext(items: QueueItem[], zone: Zone) {
  const normal = items.filter(x => x.zoneId === zone.id && x.status === 'queued' && x.priority === 0).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const priority = items.filter(x => x.zoneId === zone.id && x.status === 'queued' && x.priority > 0).sort((a, b) => (a.promotedAt ?? a.createdAt).localeCompare(b.promotedAt ?? b.createdAt));
  return (zone.priorityStreak >= 2 ? normal[0] ?? priority[0] : priority[0] ?? normal[0]) ?? null;
}
export async function audit(tx: UnitOfWork, action: string, targetId: string, detail: string) { await tx.put('audit', { id: id('audit'), action, targetId, detail: detail.slice(0, 2000), createdAt: now() }); }
export async function settings(tx: UnitOfWork): Promise<Settings> { const row = await tx.get('setting', 'settings'); if (!row) throw new AppError('NOT_INITIALIZED', '服务尚未初始化', 503); return row.value; }
