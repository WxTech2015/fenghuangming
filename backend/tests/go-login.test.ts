import { describe, expect, it, vi } from 'vitest';
import { syncManagedMusicLogin } from '../src/music/go-login';

describe('托管音源平台登录态', () => {
  const signal = () => new AbortController().signal;
  it('不配置时不修改已有平台账号', async () => {
    const fetcher = vi.fn(); await syncManagedMusicLogin('http://127.0.0.1:1234/music', signal(), {}, fetcher); expect(fetcher).not.toHaveBeenCalled();
  });
  it('只发送已配置的平台，禁止重定向到其他服务', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'ok' }));
    await syncManagedMusicLogin('http://127.0.0.1:1234/music', signal(), { NETEASE_COOKIE: 'test-login', QQ_MUSIC_COOKIE: '  ' }, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1234/music/cookies');
    const options = fetcher.mock.calls[0]![1]!; expect(JSON.parse(options.body as string)).toEqual({ netease: 'test-login' }); expect(options.redirect).toBe('error');
  });
  it('不能把环境凭证同步给外部部署，HTTP 失败明确报告', async () => {
    const fetcher = vi.fn(async () => new Response('error', { status: 403 }));
    await expect(syncManagedMusicLogin('https://external.example/music', signal(), { QQ_MUSIC_COOKIE: 'test-login' }, fetcher)).rejects.toThrow('本地音源'); expect(fetcher).not.toHaveBeenCalled();
    await expect(syncManagedMusicLogin('http://127.0.0.1:1234/music', signal(), { QQ_MUSIC_COOKIE: 'test-login' }, fetcher)).rejects.toThrow('HTTP 403');
  });
});
