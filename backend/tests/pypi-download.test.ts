import { describe, expect, it, vi } from 'vitest';
import { PypiDownloader, PYPI_OFFICIAL } from '../src/music/pypi-download';
import { installPythonPackages } from '../src/music/python-install';
import { SettingsSchema } from '../src/contracts';

const wheel = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(65532, 8)]);
const nodes = [{ mirror: 'https://fast.example/simple/', label: 'fast' }, { mirror: 'https://slow.example/simple/', label: 'slow' }];
const signal = () => new AbortController().signal;
const index = (url = '../musicdl-2.14.0-py3-none-any.whl#sha256=test') => new Response(`<a href="${url}">musicdl</a>`);
const fetcher = (work?: (url: string, options?: RequestInit) => Promise<Response>) => vi.fn(async (input: string | URL | Request, options?: RequestInit) => work ? work(String(input), options) : String(input).endsWith('/musicdl/') ? index() : new Response(wheel)) as unknown as typeof fetch;

describe('PyPI 镜像与 musicdl 依赖安装', () => {
  it('旧配置默认自动模式，拒绝非内置或带凭证的镜像', () => {
    expect(SettingsSchema.parse({}).pypiDownload).toEqual({ mode: 'auto', mirror: '' });
    expect(SettingsSchema.safeParse({ pypiDownload: { mode: 'mirror', mirror: 'https://other.example/simple/' } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ pypiDownload: { mode: 'mirror', mirror: 'https://user:secret@pypi.org/simple/' } }).success).toBe(false);
  });
  it('保存不测速，共享并发任务，缓存到期和显式请求才重测', async () => {
    let clock = 1000; const fetch = fetcher(); const dl = new PypiDownloader({ mirrors: nodes, fetch, now: () => clock });
    try {
      dl.configure({ mode: 'auto', mirror: '' }); expect(fetch).not.toHaveBeenCalled();
      const [a, b] = await Promise.all([dl.test(), dl.test()]); expect(a).toEqual(b); expect(fetch).toHaveBeenCalledTimes(4);
      await dl.test(); expect(fetch).toHaveBeenCalledTimes(4);
      clock += 30 * 60 * 1000; await dl.test(); expect(fetch).toHaveBeenCalledTimes(8);
      await dl.test(true); expect(fetch).toHaveBeenCalledTimes(12);
      const call = vi.mocked(fetch).mock.calls.find(([, init]) => (init?.headers as Record<string, string>)?.Range);
      expect((call?.[1]?.headers as Record<string, string>).Range).toBe('bytes=0-65535'); expect(String(call?.[0])).not.toContain('#');
    } finally { dl.close(); }
  });
  it('对固定版本包测速，最快可用节点优先', async () => {
    const fetch = fetcher(async url => { await new Promise(ok => setTimeout(ok, url.includes('fast') ? 5 : 35)); return url.endsWith('/musicdl/') ? index() : new Response(wheel); });
    const dl = new PypiDownloader({ mirrors: nodes, fetch });
    try {
      expect((await dl.test())[0]).toMatchObject({ mirror: nodes[0]!.mirror, available: true });
      expect(dl.snapshot().nodes[0]!.latencyMs).toBeGreaterThan(0); expect(dl.snapshot().nodes[0]!.speedBytesPerSecond).toBeGreaterThan(0);
      const work = vi.fn(async () => {}); await dl.install(work, signal()); expect(work.mock.calls[0]?.[0]).toBe(nodes[0]!.mirror); expect(dl.snapshot().phase).toBe('ready');
    } finally { dl.close(); }
  });
  it.each(['version', 'html', 'domain', 'range'])('拒绝未同步或伪造的镜像响应：%s', async reason => {
    const fetch = fetcher(async url => {
      if (url.endsWith('/musicdl/')) return index(reason === 'version' ? '../musicdl-1.0.0-py3-none-any.whl' : reason === 'domain' ? 'https://unknown.example/musicdl-2.14.0-py3-none-any.whl' : undefined);
      return reason === 'range' ? new Response(wheel, { status: 206, headers: { 'Content-Range': 'bytes 10-20/30' } }) : new Response('<html>login</html>');
    });
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch });
    try { const result = (await dl.test())[0]!; expect(result.available).toBe(false); expect(result.error).toBeTruthy(); expect(dl.snapshot().phase).toBe('failed'); } finally { dl.close(); }
  });
  it('失败后换源，安装命令固定版本，环境只影响当前子进程', async () => {
    const dl = new PypiDownloader({ mirrors: nodes, fetch: fetcher() }); dl.configure({ mode: 'mirror', mirror: nodes[0]!.mirror });
    const env = { PIP_INDEX_URL: 'https://old.example/', UV_EXTRA_INDEX_URL: 'https://extra.example/', PIP_EXTRA_INDEX_URL: 'https://extra.example/', UV_INDEX: 'custom', PATH: 'test-path' };
    const runner = vi.fn(async (_exe: string, _args: string[], _cwd: string, config: NodeJS.ProcessEnv) => { if (config.PIP_INDEX_URL === nodes[0]!.mirror) throw new Error('HTTP 502'); });
    try {
      await installPythonPackages('uv', 'python', 'state', env, signal(), dl, runner);
      expect(runner).toHaveBeenCalledTimes(2); expect(runner.mock.calls[0]![1]).toEqual(['pip', 'install', '--python', 'python', '--default-index', nodes[0]!.mirror, 'musicdl==2.14.0']);
      expect(runner.mock.calls[1]![3]).toMatchObject({ PIP_INDEX_URL: nodes[1]!.mirror, UV_DEFAULT_INDEX: nodes[1]!.mirror, PATH: 'test-path' });
      expect(runner.mock.calls[1]![3]).not.toHaveProperty('UV_EXTRA_INDEX_URL'); expect(runner.mock.calls[1]![3]).not.toHaveProperty('PIP_EXTRA_INDEX_URL'); expect(runner.mock.calls[1]![3]).not.toHaveProperty('UV_INDEX');
      expect(env.PIP_INDEX_URL).toBe('https://old.example/'); expect(dl.snapshot().nodes.find(n => n.mirror === nodes[0]!.mirror)).toMatchObject({ available: false, error: 'HTTP 502' });
    } finally { dl.close(); }
  });
  it('官方模式不测速，不安装任何其他源；所有测速失败仍尝试官方', async () => {
    const fetch = fetcher(async () => new Response('error', { status: 503 })); const dl = new PypiDownloader({ mirrors: nodes, fetch }); const work = vi.fn(async () => {});
    try {
      dl.configure({ mode: 'official', mirror: '' }); await dl.install(work, signal()); expect(fetch).not.toHaveBeenCalled(); expect(work.mock.calls[0]?.[0]).toBe(PYPI_OFFICIAL);
      work.mockClear(); dl.configure({ mode: 'auto', mirror: '' }); await dl.install(work, signal()); expect(fetch).toHaveBeenCalledTimes(2); expect(work.mock.calls[0]?.[0]).toBe(PYPI_OFFICIAL);
    } finally { dl.close(); }
  });
  it('取消安装后不继续换源，并保留具体失败原因', async () => {
    const dl = new PypiDownloader({ mirrors: nodes, fetch: fetcher() }); const controller = new AbortController();
    const work = vi.fn(async () => { controller.abort(new Error('cancelled')); throw new Error('cancelled'); });
    try { await expect(dl.install(work, controller.signal)).rejects.toThrow('cancelled'); expect(work).toHaveBeenCalledTimes(1); expect(dl.snapshot()).toMatchObject({ phase: 'failed', error: 'cancelled' }); } finally { dl.close(); }
  });
  it('支持 PEP 691 JSON 索引和合法跨站重定向', async () => {
    const fetch = fetcher(async url => {
      if (url === 'https://fast.example/simple/musicdl/') return new Response(null, { status: 302, headers: { Location: 'https://mirrors.ustc.edu.cn/pypi/simple/musicdl/' } });
      if (url.endsWith('/musicdl/')) return Response.json({ files: [{ filename: 'musicdl-2.14.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/musicdl-2.14.0-py3-none-any.whl#sha256=test' }] });
      return new Response(wheel);
    });
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch });
    try { expect((await dl.test())[0]).toMatchObject({ available: true, indexReachable: true, stage: 'complete' }); expect(fetch).toHaveBeenCalledTimes(3); } finally { dl.close(); }
  });
  it('重定向到未知域名时在请求之前拒绝', async () => {
    const fetch = fetcher(async () => new Response(null, { status: 302, headers: { Location: 'https://unknown.example/musicdl/' } }));
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch });
    try { expect((await dl.test())[0]!.error).toContain('非预期'); expect(fetch).toHaveBeenCalledTimes(1); } finally { dl.close(); }
  });
  it('索引和下载分别计时，慢索引不会消耗文件下载的时限', async () => {
    const fetch = fetcher(async (url, options) => {
      await new Promise<void>((ok, reject) => {
        const timer = setTimeout(ok, 40);
        options!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(options!.signal!.reason); }, { once: true });
      });
      return url.endsWith('/musicdl/') ? index() : new Response(wheel);
    });
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch, probeTimeoutMs: 65 });
    try { expect((await dl.test())[0]!.available).toBe(true); } finally { dl.close(); }
  });
  it('限制并发请求并在重测时清空旧结果', async () => {
    let active = 0; let peak = 0; let empty = false;
    const mirrors = Array.from({ length: 9 }, (_, n) => ({ mirror: `https://node${n}.example/simple/`, label: String(n) }));
    const fetch = fetcher(async url => { active++; peak = Math.max(peak, active); await new Promise(ok => setTimeout(ok, 5)); active--; return url.endsWith('/musicdl/') ? index() : new Response(wheel); });
    const dl = new PypiDownloader({ mirrors, fetch, concurrency: 3, changed: state => { if (state.phase === 'testing' && state.nodes.every(n => n.available === null)) empty = true; } });
    try { expect(await dl.test()).toHaveLength(9); expect(peak).toBe(3); expect(empty).toBe(true); } finally { dl.close(); }
  });
  it('下载失败保留索引延迟和阶段，仍允许安装器尝试该索引', async () => {
    const fetch = fetcher(async (url, options) => {
      if (url.endsWith('/musicdl/')) return index();
      return new Promise((_ok, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    });
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch, probeTimeoutMs: 15 });
    try {
      expect((await dl.test())[0]).toMatchObject({ available: false, indexReachable: true, stage: 'download', latencyMs: expect.any(Number), error: expect.stringContaining('文件下载：超时') });
      const work = vi.fn(async () => {}); await dl.install(work, signal()); expect(work.mock.calls[0]?.[0]).toBe(nodes[0]!.mirror);
    } finally { dl.close(); }
  });
  it('全部失败的测速缓存只保留一分钟', async () => {
    let clock = 1000; const fetch = fetcher(async () => new Response(null, { status: 503 }));
    const dl = new PypiDownloader({ mirrors: [nodes[0]!], fetch, now: () => clock });
    try { await dl.test(); clock += 59000; await dl.test(); expect(fetch).toHaveBeenCalledTimes(1); clock += 1000; await dl.test(); expect(fetch).toHaveBeenCalledTimes(2); } finally { dl.close(); }
  });
});
