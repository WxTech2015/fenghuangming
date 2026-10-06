import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, TrackSchema, type QueueItem, type Zone } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { QueueService, refundQuota } from '../src/queues/queue';
import { ModerationService } from '../src/policies/moderation';
import { checkBlacklist, chooseNext, dateInShanghai } from '../src/core/domain';
import { parseMusicCard, trackFromUrl } from '../src/onebot/cards';
import { GoMusicDlProvider } from '../src/music/providers';
import { isPublicIp } from '../src/music/network';
import { parseRange } from '../src/media/cache';

const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '测试歌曲', artists: ['测试歌手'] });
async function fixture() { const store = await new FileStore().init(); const events = new Events(); const system = new SystemService(store, events); await system.init(); return { store, system, queue: new QueueService(store, events, new ModerationService()) }; }
const input = (key: string, userId = '12345') => ({ zoneId: 'zone_default', requestKey: key, userId, track });
describe('队列和存储', () => {
  it('记录查询不会将对象原型属性当作存在的记录', async () => { const { store } = await fixture(); expect(await store.transaction(tx => tx.get('zone', '__proto__'))).toBeNull(); expect(await store.transaction(tx => tx.get('zone', 'constructor'))).toBeNull(); });
  it('默认自动运行 go-music-dl，保存外部服务模式且请求去重', async () => {
    const { system, queue } = await fixture(); const a = await queue.enqueue(input('a'));
    expect((await system.snapshot()).settings.gomusicdl.mode).toBe('managed');
    await system.saveSettings({ gomusicdl: { mode: 'external', baseUrl: 'http://127.0.0.1:8080/music' } }); const b = await queue.enqueue(input('b'));
    expect(a.engine).toBe('gomusicdl'); expect(b.engine).toBe('gomusicdl'); expect((await system.snapshot()).settings.gomusicdl.mode).toBe('external');
    expect((await queue.enqueue(input('a'))).id).toBe(a.id);
  });
  it('并发插队不能超额，同一任务不会重复扣次数', async () => {
    const { system, queue } = await fixture(); await system.saveSettings({ dailyJumpLimit: 1 });
    const a = await queue.enqueue(input('a')); const b = await queue.enqueue(input('b'));
    const results = await Promise.allSettled([queue.promote(a.id), queue.promote(b.id), queue.promote(a.id)]);
    expect(results.filter(x => x.status === 'rejected')).toHaveLength(1);
    expect((await system.snapshot()).quotas[0]?.used).toBe(1);
  });
  it('额度为零时拒绝插队，并按上海日期计算', async () => {
    const { system, queue } = await fixture(); await system.saveSettings({ dailyJumpLimit: 0 }); const a = await queue.enqueue(input('a'));
    await expect(queue.promote(a.id)).rejects.toThrow('禁用插队'); expect(dateInShanghai(new Date('2026-10-03T16:01:00Z'))).toBe('2026-10-04');
  });
  it('失败退款最多一次，退回原日期的额度', async () => {
    const { system, queue, store } = await fixture(); const a = await queue.enqueue(input('a')); await queue.promote(a.id);
    await store.transaction(tx => refundQuota(tx, a)); await store.transaction(tx => refundQuota(tx, a)); expect((await system.snapshot()).quotas[0]?.used).toBe(0);
  });
  it('作用域黑名单和待审核队列', async () => {
    const { system, queue } = await fixture(); await system.blacklist({ kind: 'track', value: 'netease:123', scope: 'group', scopeId: '777' });
    await expect(queue.enqueue({ ...input('a'), groupId: '777' })).rejects.toThrow('管理员禁用');
    await system.saveSettings({ ai: { enabled: true, unknownAction: 'review' } }); const item = await queue.enqueue({ ...input('b'), groupId: '888' }); expect(item.status).toBe('review');
    await system.blacklist({ kind: 'user', value: '12345' }); await expect(queue.review(item.id, true)).rejects.toThrow('管理员禁用');
  });
  it('连续两首插队之后优先普通歌曲', async () => {
    const { queue, system } = await fixture(); const a = await queue.enqueue(input('normal')); const b = await queue.enqueue(input('priority')); const promoted = await queue.promote(b.id);
    const zone = (await system.snapshot()).zones[0]!; expect(chooseNext([a, promoted], zone)?.id).toBe(b.id); expect(chooseNext([a, promoted], { ...zone, priorityStreak: 2 })?.id).toBe(a.id);
  });
  it('事务失败回滚且文件存储重启后仍保留设置', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqmusic-store-')); const filename = join(directory, 'db.json');
    try { const store = await new FileStore(filename).init(); const system = new SystemService(store, new Events()); await system.init(); await system.saveSettings({ audioEngine: 'gomusicdl' });
      await expect(store.transaction(async tx => { await tx.remove('setting', 'settings'); throw new Error('rollback'); })).rejects.toThrow('rollback');
      const reopened = new SystemService(await new FileStore(filename).init(), new Events()); expect((await reopened.snapshot()).settings.audioEngine).toBe('gomusicdl');
    } finally { if (!directory.startsWith(join(tmpdir(), 'qqmusic-store-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
  });
});
describe('音乐卡片和下载适配', () => {
  it.each([
    ['https://music.163.com/#/song?id=123', 'netease', '123'], ['https://y.qq.com/n/ryqq/songDetail/003abcXYZ', 'qq', '003abcXYZ'],
    ['https://y.qq.com/n/yqq/song/003abc.html', 'qq', '003abc'], ['https://www.kugou.com/song/#hash=ABC123', 'kugou', 'ABC123'],
    ['https://www.kuwo.cn/play_detail/1234', 'kuwo', '1234'], ['https://music.migu.cn/v3/music/song/600ABC', 'migu', '600ABC'],
  ])('识别 %s', (url, platform, externalId) => { expect(trackFromUrl(url)).toMatchObject({ platform, externalId }); });
  it('识别 JSON、XML、音乐段、文本链接，保留平台 ID', async () => {
    const json = [{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.structmsg', meta: { music: { title: '晴天', desc: '周杰伦', jumpUrl: 'https://y.qq.com/n/ryqq/songDetail/003abcXYZ' } } }) } }];
    expect(await parseMusicCard(json, false)).toMatchObject({ title: '晴天', artists: ['周杰伦'], externalId: '003abcXYZ' });
    expect(await parseMusicCard([{ type: 'xml', data: { data: '<msg url="https://music.163.com/song?id=123"><title>测试</title><summary>歌手</summary></msg>' } }], false)).toMatchObject({ title: '测试', externalId: '123' });
    expect(await parseMusicCard([{ type: 'music', data: { type: '163', id: '123', title: '测试' } }], false)).toMatchObject({ platform: 'netease' });
    expect(await parseMusicCard([{ type: 'text', data: { text: 'https://music.163.com/song?id=123' } }], false)).toMatchObject({ externalId: '123' });
  });
  it('拒绝伪造平台域名和 XML 实体', async () => {
    expect(trackFromUrl('https://y.qq.com.evil.test/song/123')).toBeNull(); expect(trackFromUrl('file:///song?id=123')).toBeNull();
    expect(await parseMusicCard([{ type: 'xml', data: { data: '<!DOCTYPE x><msg url="https://music.163.com/song?id=123"/>' } }], false)).toBeNull();
  });
  it('go-music-dl 使用真实下载路由；自动模式调用受管理的地址', async () => {
    const config = SettingsSchema.parse({ gomusicdl: { mode: 'external', baseUrl: 'http://127.0.0.1:8080/music' } });
    const resolved = await new GoMusicDlProvider().resolve(track, config); const url = new URL(resolved.url);
    expect(url.pathname).toBe('/music/download'); expect(url.searchParams.get('stream')).toBe('1'); expect(url.searchParams.get('source')).toBe('netease'); expect(resolved.trustedOrigin).toBe('http://127.0.0.1:8080');
    const managed = new GoMusicDlProvider(async () => 'http://127.0.0.1:45678/music');
    const qq = new URL((await managed.resolve({ ...track, platform: 'qq', externalId: '003abc' }, SettingsSchema.parse({}))).url);
    expect(qq.port).toBe('45678'); expect(qq.searchParams.get('id')).toBe('003abc'); expect(qq.searchParams.get('source')).toBe('qq');
    await expect(new GoMusicDlProvider().resolve(track, SettingsSchema.parse({}))).rejects.toThrow('尚未启动');
  });
  it('阻止私网音源地址并正确处理音频 Range', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '169.254.1.1', 'fc00::1']) expect(isPublicIp(ip)).toBe(false);
    expect(isPublicIp('8.8.8.8')).toBe(true); expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999, partial: true }); expect(parseRange('bytes=-100', 1000).start).toBe(900);
    expect(() => parseRange('bytes=1-2,3-4', 1000)).toThrow(); expect(() => parseRange('bytes=1000-', 1000)).toThrow(); expect(() => parseRange('bytes=-0', 1000)).toThrow();
  });
});
