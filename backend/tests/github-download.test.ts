import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GithubDownloader, mirrorUrl } from '../src/music/github-download';
import { SettingsSchema } from '../src/contracts';

const url = 'https://github.com/owner/tool/releases/download/v1/tool.zip';
const archive = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(65532, 7)]);
const hash = createHash('sha256').update(archive).digest('hex');
const signal = () => new AbortController().signal;
const response = (body: Uint8Array = archive) => new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } });
const probe = (options?: RequestInit) => !!(options?.headers as Record<string, string>)?.Range;
const deferredFetch = (work: (url: string, options?: RequestInit) => Promise<Response>) => vi.fn((input: string | URL | Request, options?: RequestInit) => work(String(input), options)) as unknown as typeof fetch;

describe('GitHub 加速下载', () => {
  it('旧配置默认自动选择，拒绝带凭证的节点；正确拼接原始完整链接', () => {
    expect(SettingsSchema.parse({}).githubDownload).toEqual({ mode: 'auto', mirror: '' });
    expect(SettingsSchema.safeParse({ githubDownload: { mode: 'mirror', mirror: 'https://user:password@mirror.example/' } }).success).toBe(false);
    expect(mirrorUrl(url, 'https://mirror.example/')).toBe(`https://mirror.example/${url}`);
  });
  it('构造和保存配置不测速；同次测速共享任务，30 分钟过期后重测', async () => {
    let clock = 1000;
    const fetcher = deferredFetch(async () => response());
    const downloads = new GithubDownloader({ mirrors: ['https://a.example/'], fetch: fetcher, now: () => clock });
    downloads.configure({ mode: 'auto', mirror: '' }); expect(fetcher).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([downloads.test(url), downloads.test(url)]);
    expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(2);
    await downloads.test(url); expect(fetcher).toHaveBeenCalledTimes(2);
    clock += 30 * 60 * 1000; await downloads.test(url); expect(fetcher).toHaveBeenCalledTimes(4);
    await downloads.test(url, true); expect(fetcher).toHaveBeenCalledTimes(6);
    downloads.close();
  });
  it('测首字节延迟和抽样速度，最快可用节点优先；拒绝伪装成文件的 HTML', async () => {
    const fetcher = deferredFetch(async target => {
      if (target.startsWith('https://bad.example')) return new Response('<html>login</html>', { headers: { 'Content-Type': 'application/octet-stream' } });
      await new Promise(resolve => setTimeout(resolve, target.startsWith('https://fast.example') ? 10 : 50)); return response();
    });
    const downloads = new GithubDownloader({ mirrors: ['https://bad.example/', 'https://fast.example/'], fetch: fetcher });
    const nodes = await downloads.test(url);
    expect(nodes[0]).toMatchObject({ mirror: 'https://fast.example/', available: true });
    expect(nodes[0]!.latencyMs).toBeGreaterThanOrEqual(5); expect(nodes[0]!.speedBytesPerSecond).toBeGreaterThan(0);
    expect(nodes.find(node => node.mirror.includes('bad'))).toMatchObject({ available: false, error: '节点返回了无效的安装包' });
    expect(await downloads.download(url, hash, signal())).toEqual(archive);
    expect(String(vi.mocked(fetcher).mock.calls.at(-1)![0])).toBe(`https://fast.example/${url}`);
    downloads.close();
  });
  it('优先节点包被篡改时切换直连，校验成功前不返回任何安装包', async () => {
    const calls: string[] = [];
    const fetcher = deferredFetch(async (target, options) => {
      if (!probe(options)) calls.push(target);
      return response(!probe(options) && target.startsWith('https://bad.example/') ? Buffer.from('tampered') : archive);
    });
    const downloads = new GithubDownloader({ mirrors: [], fetch: fetcher });
    downloads.configure({ mode: 'mirror', mirror: 'https://bad.example/' });
    expect(await downloads.download(url, hash, signal())).toEqual(archive);
    expect(calls).toEqual([`https://bad.example/${url}`, url]); expect(downloads.snapshot()).toMatchObject({ selected: '', phase: 'ready' });
    downloads.close();
  });
  it('节点下载 HTTP 失败后尝试其他已测速节点，失效节点不复用', async () => {
    const calls: string[] = [];
    const fetcher = deferredFetch(async (target, options) => {
      if (!probe(options)) { calls.push(target); if (target.startsWith('https://a.example/')) return new Response('error', { status: 502 }); }
      return response();
    });
    const downloads = new GithubDownloader({ mirrors: ['https://a.example/'], fetch: fetcher });
    downloads.configure({ mode: 'mirror', mirror: 'https://a.example/' });
    await downloads.download(url, hash, signal()); expect(calls).toEqual([`https://a.example/${url}`, url]);
    expect(downloads.snapshot().nodes.find(node => node.mirror.includes('a.example'))).toMatchObject({ available: false, error: 'HTTP 502' });
    downloads.configure({ mode: 'auto', mirror: '' }); calls.length = 0;
    await downloads.download(url, hash, signal()); expect(calls).toEqual([url]); downloads.close();
  });
  it('直连模式不请求镜像、不测速，完整响应也必须通过固定 SHA-256', async () => {
    const fetcher = deferredFetch(async () => response());
    const downloads = new GithubDownloader({ fetch: fetcher }); downloads.configure({ mode: 'direct', mirror: '' });
    await expect(downloads.download(url, '0'.repeat(64), signal())).rejects.toThrow('SHA-256');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe(url);
    expect(probe(vi.mocked(fetcher).mock.calls[0]![1])).toBe(false); expect(downloads.snapshot().phase).toBe('failed'); downloads.close();
  });
  it('所有测速失败时仍尝试官方直连；取消安装后不再请求其他节点', async () => {
    const controller = new AbortController();
    const fetcher = deferredFetch(async (_target, options) => {
      if (probe(options)) return new Response('error', { status: 503 });
      controller.abort(); throw new DOMException('cancelled', 'AbortError');
    });
    const downloads = new GithubDownloader({ mirrors: ['https://a.example/'], fetch: fetcher });
    await expect(downloads.download(url, hash, controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3); expect(vi.mocked(fetcher).mock.calls[2]![0]).toBe(url); downloads.close();
  });
  it('拒绝超大安装包、非完整响应，以及无效的分段响应', async () => {
    const fetcher = deferredFetch(async () => new Response(archive, { headers: { 'Content-Length': String(65 * 1024 * 1024) } }));
    const downloads = new GithubDownloader({ mirrors: [], fetch: fetcher }); downloads.configure({ mode: 'direct', mirror: '' });
    await expect(downloads.download(url, hash, signal())).rejects.toThrow('安装包过大');
    vi.mocked(fetcher).mockResolvedValueOnce(new Response(archive, { status: 206 }));
    await expect(downloads.download(url, hash, signal())).rejects.toThrow('完整安装包');
    vi.mocked(fetcher).mockResolvedValueOnce(new Response(archive, { status: 206, headers: { 'Content-Range': 'bytes 128-256/1024' } }));
    expect((await downloads.test(url, true))[0]).toMatchObject({ available: false, error: '节点返回了无效的文件片段' }); downloads.close();
  });
});
