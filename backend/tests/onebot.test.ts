import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from '../node_modules/ws';
import { TrackSchema } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { createApplication } from '../src/app';
import { itemCode } from '../src/onebot/commands';

describe('NapCat 登录账号和 QQ 群功能', () => {
  let backend: Awaited<ReturnType<typeof createApplication>>; let base = ''; let directory = ''; let bot: WebSocket;
  let role: 'member' | 'admin' | 'owner' = 'member'; let failRole = false; let serial = 100; let loginId = 555; let groupList = [{ group_id: 666, group_name: '办公室点歌群' }];
  const replies: { group: number; text: string }[] = []; const actions: string[] = [];
  const snapshot = () => backend.context.system.snapshot();
  const track = (id: string, title = `歌曲 ${id}`) => TrackSchema.parse({ platform: 'netease', externalId: id, title });
  beforeEach(async () => {
    role = 'member'; failRole = false; serial = 100; loginId = 555; replies.length = 0; actions.length = 0; groupList = [{ group_id: 666, group_name: '办公室点歌群' }];
    directory = await mkdtemp(join(tmpdir(), 'qqmusic-onebot-'));
    backend = await createApplication({ store: await new FileStore().init(), dataDir: directory, auth: { username: 'admin', password: 'test-password', secret: 'b'.repeat(40), secure: false }, botToken: 'napcat-token', logger: false, metadata: null, manageMusic: false });
    await backend.app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${(backend.app.getHttpServer().address() as AddressInfo).port}`;
    bot = new WebSocket(base.replace('http:', 'ws:') + '/ws/onebot', { headers: { Authorization: 'Bearer napcat-token' } });
    bot.on('message', raw => {
      const request = JSON.parse(raw.toString()); actions.push(request.action);
      if (request.action === 'send_group_msg') { replies.push({ group: request.params.group_id, text: request.params.message[0].data.text }); return; }
      let data: unknown;
      if (request.action === 'get_login_info') data = { user_id: loginId, nickname: '实际登录账号' };
      if (request.action === 'get_group_list') data = groupList;
      if (request.action === 'get_group_member_info') data = { group_id: request.params.group_id, user_id: request.params.user_id, role };
      if (data !== undefined) bot.send(JSON.stringify({ status: failRole && request.action === 'get_group_member_info' ? 'failed' : 'ok', retcode: failRole && request.action === 'get_group_member_info' ? 500 : 0, echo: request.echo, data }));
    });
    await once(bot, 'open'); await waitUntil(async () => (await snapshot()).bots[0]?.groups.length === 1);
  });
  afterEach(async () => {
    bot?.terminate(); await backend?.close();
    if (!directory.startsWith(join(tmpdir(), 'qqmusic-onebot-'))) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  });
  const bind = () => backend.context.system.bind({ groupId: '666', zoneId: 'zone_default' });
  function event(text: unknown, userId = 777, overrides: Record<string, unknown> = {}) {
    return { post_type: 'message', message_type: 'group', self_id: 555, group_id: 666, user_id: userId, message_id: serial++, sender: { nickname: '群点歌人', role: 'admin' }, message: typeof text === 'string' ? [{ type: 'text', data: { text } }] : text, ...overrides };
  }
  async function send(text: unknown, userId = 777, overrides: Record<string, unknown> = {}) { const before = replies.length; bot.send(JSON.stringify(event(text, userId, overrides))); await waitUntil(() => replies.length > before); return replies.at(-1)!.text; }
  const card = (id: number, title = `歌曲 ${id}`) => [{ type: 'music', data: { type: '163', id, title } }];

  it('从接口读取实际账号和群，自动选单一账号，拒绝伪造绑定', async () => {
    expect(actions.slice(0, 2)).toEqual(['get_login_info', 'get_group_list']);
    expect((await snapshot()).bots[0]).toMatchObject({ id: '555', nickname: '实际登录账号', connected: true, groups: [{ id: '666', name: '办公室点歌群' }] });
    expect((await bind()).botId).toBe('555');
    await expect(backend.context.system.bind({ botId: '999', groupId: '666', zoneId: 'zone_default' })).rejects.toThrow('先连接 NapCat');
    await expect(backend.context.system.bind({ groupId: '999', zoneId: 'zone_default' })).rejects.toThrow('群列表');
    groupList.push({ group_id: 888, group_name: '新加的群' }); await backend.context.gateway.refreshBots();
    expect((await snapshot()).bots[0]?.groups).toHaveLength(2);
    bot.close(); await once(bot, 'close'); await waitUntil(async () => !(await snapshot()).botConnected);
    expect((await snapshot()).bots[0]?.connected).toBe(false);
    await expect(backend.context.system.bind({ groupId: '888', zoneId: 'zone_default' })).rejects.toThrow('先连接 NapCat');
    await expect(backend.context.system.bind({ botId: '555', groupId: '666', zoneId: 'zone_default', enabled: false })).resolves.toMatchObject({ enabled: false });
  });
  it('#menu 菜单支持字符串、别名和 @；未绑定群、自发消息及伪造 self_id 不响应', async () => {
    await bind();
    const menu = await send('#menu', 777, { message: '#menu' });
    for (const command of ['#点歌', '#队列', '#我的', '#插队', '#取消', '#歌单', '#音量']) expect(menu).toContain(command);
    expect(menu).toContain('默认播放区'); expect(menu).toContain('每日插队 3 次');
    expect(await send([{ type: 'at', data: { qq: '555' } }, { type: 'text', data: { text: '#菜单' } }])).toContain('点歌菜单');
    const before = replies.length;
    bot.send(JSON.stringify(event('#menu', 777, { group_id: 999 })));
    bot.send(JSON.stringify(event('#menu', 555)));
    bot.send(JSON.stringify(event(card(901), 777, { self_id: 999 })));
    await new Promise(resolve => setTimeout(resolve, 60)); expect(replies).toHaveLength(before); expect((await snapshot()).queue).toHaveLength(0);
    const duplicate = event('#帮助'); bot.send(JSON.stringify(duplicate)); bot.send(JSON.stringify(duplicate));
    await waitUntil(() => replies.length > before); await new Promise(resolve => setTimeout(resolve, 30)); expect(replies).toHaveLength(before + 1);
  });
  it('群内点歌、队列、本人额度、插队和取消沿用队列权限与限额', async () => {
    await bind(); await backend.context.system.saveSettings({ dailyJumpLimit: 1 });
    expect(await send('#正在播放')).toContain('当前没有播放');
    expect(await send(card(123))).toContain('已加入队列');
    expect(await send('#点歌 https://music.163.com/song?id=456')).toContain('已加入队列');
    const items = (await snapshot()).queue; const first = items.find(item => item.track.externalId === '123')!; const second = items.find(item => item.track.externalId === '456')!;
    const listing = await send('#队列'); expect(listing).toContain(`[${itemCode(first)}]`); expect(listing).toContain('待播 2 首');
    expect(await send(`#插队 ${itemCode(first)}`)).toContain('已插队');
    expect(await send(`#插队 ${itemCode(first)}`)).toContain('已插队'); expect((await snapshot()).quotas[0]?.used).toBe(1);
    expect(await send('#我的')).toContain('今日插队：1/1');
    expect(await send(`#插队 ${itemCode(second)}`)).toContain('次数已用完');
    expect(await send(`#取消 ${itemCode(first)}`, 888)).toContain('只能操作自己的');
    expect(await send(`#插队 ${itemCode(second)}`, 888)).toContain('只能操作自己的');
    expect(await send('#取消')).toContain('已取消'); expect((await snapshot()).queue.find(item => item.id === second.id)?.status).toBe('cancelled');
    expect(await send(`/插队 ${itemCode(first)}`)).toContain('已插队');
  });
  it('歌单归属实际点歌人，不能绕过黑名单、个人上限或播放区范围', async () => {
    await bind(); await backend.context.system.saveSettings({ maxPendingPerUser: 1 });
    await backend.context.system.playlist({ name: '午后', zoneId: 'zone_default', tracks: [track('11'), track('12'), track('13')] });
    await backend.context.system.blacklist({ kind: 'track', value: 'netease:12', reason: '禁播测试' });
    expect(await send('#歌单')).toContain('1. 午后（3 首）');
    expect(await send('#歌单 1')).toContain('1 首已提交，2 首未入队');
    expect((await snapshot()).queue).toHaveLength(1); expect((await snapshot()).queue[0]).toMatchObject({ userId: '777', userName: '群点歌人', botId: '555', groupId: '666' });
    expect(await send('#歌单 午后')).toContain('0 首已提交，3 首未入队');
    const other = await backend.context.system.saveZone({ name: '其他播放区' }); await backend.context.system.playlist({ name: '他处', zoneId: other.id, tracks: [track('88')] });
    expect(await send('#歌单 他处')).toContain('找不到本播放区歌单');
    await backend.context.system.blacklist({ kind: 'user', value: '888', reason: '此人禁用' });
    expect(await send('#歌单 1', 888)).toContain('此人禁用'); expect((await snapshot()).queue).toHaveLength(1);
  });
  it('管理指令实时向 NapCat 验权，不相信 sender.role；接口失败不执行', async () => {
    await bind();
    expect(await send('#音量 75')).toContain('仅限群主或群管理员'); expect((await snapshot()).zones[0]?.volume).toBe(50);
    role = 'admin'; expect(await send('#音量 75')).toContain('音量：75%'); expect((await snapshot()).zones[0]?.volume).toBe(75);
    failRole = true; expect(await send('#音量 30')).toContain('接口调用失败'); expect((await snapshot()).zones[0]?.volume).toBe(75);
    failRole = false; role = 'owner'; expect(await send('#音量 101')).toContain('用法'); expect(await send('#切歌')).toContain('当前没有播放');
    expect(actions.filter(action => action === 'get_group_member_info')).toHaveLength(5);
  });
  it('待审核结果会在群里明确回复，用户可以取消自己的待审核歌曲', async () => {
    await bind(); await backend.context.system.saveSettings({ ai: { enabled: true, unknownAction: 'review' } });
    expect(await send(card(91))).toContain('等待管理员审核');
    expect(await send('#我的')).toContain('待审核');
    expect(await send('#取消')).toContain('已取消'); expect((await snapshot()).queue[0]?.status).toBe('cancelled');
  });
  it('NapCat 切换登录账号后以新账号为准，旧 self_id 不能借用新连接', async () => {
    await bind(); loginId = 999; await backend.context.gateway.refreshBots();
    expect((await snapshot()).bots.find(bot => bot.id === '555')?.connected).toBe(false);
    expect((await snapshot()).bots.find(bot => bot.id === '999')?.connected).toBe(true);
    expect((await backend.context.system.bind({ groupId: '666', zoneId: 'zone_default' })).botId).toBe('999');
    bot.send(JSON.stringify(event(card(123))));
    expect(await send('#menu', 777, { self_id: 999 })).toContain('点歌菜单');
    expect((await snapshot()).queue).toHaveLength(0);
  });
  it('同一账号重新连接会替换旧连接，新的群菜单仍可使用', async () => {
    await bind(); const original = bot; const closed = once(original, 'close');
    const replacement = new WebSocket(base.replace('http:', 'ws:') + '/ws/onebot', { headers: { Authorization: 'Bearer napcat-token' } }); bot = replacement;
    replacement.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.action === 'send_group_msg') { replies.push({ group: request.params.group_id, text: request.params.message[0].data.text }); return; }
      const data = request.action === 'get_login_info' ? { user_id: 555, nickname: '重连账号' } : request.action === 'get_group_list' ? groupList : undefined;
      if (data !== undefined) replacement.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }));
    });
    await once(replacement, 'open'); await closed;
    await waitUntil(async () => (await snapshot()).bots[0]?.nickname === '重连账号' && backend.context.gateway.bots.size === 1);
    expect((await snapshot()).botConnected).toBe(true); expect(await send('#menu')).toContain('点歌菜单');
  });
});
async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 3000) { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('等待 NapCat 状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }
