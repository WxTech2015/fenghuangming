import { performance } from 'node:perf_hooks';
import { PYPI_MIRRORS, type PypiDownloadState, type PypiMirrorResult, type Settings } from '../contracts';
import { diagnostics } from '../core/diagnostics';

export const PYPI_OFFICIAL = 'https://pypi.org/simple/';
export { PYPI_MIRRORS };
const SAMPLE_BYTES = 64 * 1024;
const CACHE_MS = 30 * 60 * 1000;
const FAILED_CACHE_MS = 60 * 1000;
const WHEEL = 'musicdl-2.14.0-py3-none-any.whl';
const EXTRA_HOSTS = ['files.pythonhosted.org', 'mirrors6.tuna.tsinghua.edu.cn', 's3.jcloud.sjtu.edu.cn'];
export interface PypiDownloaderOptions {
  mirrors?: readonly { mirror: string; label: string }[];
  fetch?: typeof fetch; now?: () => number; probeTimeoutMs?: number; concurrency?: number;
  changed?: (state: PypiDownloadState) => void;
}
export class PypiDownloader {
  private config: Settings['pypiDownload'] = { mode: 'auto', mirror: '' };
  private readonly mirrors; private readonly fetcher; private readonly now;
  private readonly abort = new AbortController();
  private pending?: Promise<PypiMirrorResult[]>;
  private cache?: { at: number; results: PypiMirrorResult[] };
  private state: PypiDownloadState;
  constructor(private readonly options: PypiDownloaderOptions = {}) {
    this.mirrors = options.mirrors ?? PYPI_MIRRORS;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args)); this.now = options.now ?? Date.now;
    this.state = { phase: 'idle', selected: null, checkedAt: null, error: null, nodes: this.emptyNodes() };
  }
  private emptyNodes(): PypiMirrorResult[] { return this.mirrors.map(node => ({ ...node, available: null, latencyMs: null, speedBytesPerSecond: null, error: null })); }
  configure(config: Settings['pypiDownload']) {
    if (config.mode === 'mirror' && !this.mirrors.some(node => node.mirror === config.mirror)) throw new Error('请选择内置 PyPI 镜像');
    this.config = { ...config };
  }
  snapshot(): PypiDownloadState { return structuredClone(this.state); }
  private publish(update: Partial<PypiDownloadState>) { Object.assign(this.state, update); this.options.changed?.(this.snapshot()); }
  private trusted(url: URL) {
    const hosts = [...this.mirrors.map(node => new URL(node.mirror).hostname), ...PYPI_MIRRORS.map(node => new URL(node.mirror).hostname), ...EXTRA_HOSTS];
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (hosts.includes(url.hostname) || url.hostname.endsWith('.mirrors.ustc.edu.cn') || url.hostname.endsWith('.s3.jcloud.sjtu.edu.cn'));
  }
  private async request(url: URL, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!this.trusted(url)) throw new Error('镜像返回了非预期的下载域名');
      const response = await this.fetcher(url, { signal, headers, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.url && !this.trusted(new URL(response.url))) { await response.body?.cancel().catch(() => {}); throw new Error('镜像返回了非预期的下载域名'); }
        return response;
      }
      const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('镜像重定向缺少地址');
      url = new URL(location, url);
    }
    throw new Error('镜像重定向次数过多');
  }
  private wheelUrl(text: string, base: string | URL): URL {
    let links: string[];
    if (text.trimStart().startsWith('{')) {
      const json = JSON.parse(text) as { files?: { filename?: string; url?: string }[] };
      links = (json.files ?? []).filter(file => file.filename === WHEEL && typeof file.url === 'string').map(file => file.url!);
    } else links = [...text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]!.replace(/&amp;/g, '&'));
    for (const link of links) {
      const candidate = new URL(link, base);
      if (decodeURIComponent(candidate.pathname.split('/').at(-1)!) === WHEEL) { candidate.hash = ''; return candidate; }
    }
    throw new Error('镜像尚未同步 musicdl 2.14.0');
  }
  private async probe(node: typeof this.mirrors[number], outer: AbortSignal): Promise<PypiMirrorResult> {
    const result: PypiMirrorResult = { ...node, available: false, latencyMs: null, speedBytesPerSecond: null, error: null, indexReachable: false, stage: 'index' };
    const timeoutMs = this.options.probeTimeoutMs ?? 15000; const start = performance.now();
    let signal = AbortSignal.any([outer, this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const indexUrl = new URL('musicdl/', node.mirror);
      const index = await this.request(indexUrl, signal, { Accept: 'application/vnd.pypi.simple.v1+json, text/html;q=0.9' });
      reader = index.body?.getReader();
      if (!index.ok || !reader) throw new Error(`HTTP ${index.status}`);
      result.indexReachable = true; result.latencyMs = Math.round(performance.now() - start);
      const chunks: Buffer[] = []; let total = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 1024 * 1024) throw new Error('PyPI 索引响应过大'); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel().catch(() => {}); reader = undefined; }
      const wheel = this.wheelUrl(Buffer.concat(chunks).toString('utf8'), index.url || indexUrl);
      if (!this.trusted(wheel)) throw new Error('镜像返回了非预期的下载域名');
      result.stage = 'download';
      signal = AbortSignal.any([outer, this.abort.signal, AbortSignal.timeout(timeoutMs)]);
      const response = await this.request(wheel, signal, { Range: `bytes=0-${SAMPLE_BYTES - 1}` });
      reader = response.body?.getReader();
      if (!response.ok || !reader) throw new Error(`HTTP ${response.status}`);
      if (response.status === 206 && !/^bytes 0-\d+\/\d+$/.test(response.headers.get('content-range') ?? '')) throw new Error('镜像返回了错误的下载范围');
      if (/text\/|json|xml/i.test(response.headers.get('content-type') ?? '')) throw new Error('镜像返回网页而非 Python 包');
      const bytes: Buffer[] = []; let size = 0; let latency = 0;
      while (size < SAMPLE_BYTES) {
        const { done, value } = await reader.read(); if (done) break;
        if (!size) latency = performance.now() - start;
        const part = value.subarray(0, SAMPLE_BYTES - size); bytes.push(Buffer.from(part)); size += part.length;
      }
      const prefix = Buffer.concat(bytes);
      if (size < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 3 || prefix[3] !== 4) throw new Error('镜像返回了无效的 wheel 文件');
      Object.assign(result, { available: true, stage: 'complete', latencyMs: Math.round(latency), speedBytesPerSecond: Math.round(size * 1000 / Math.max(1, performance.now() - start)) });
    } catch (error) {
      outer.throwIfAborted(); this.abort.signal.throwIfAborted();
      const stage = result.stage === 'download' ? '文件下载' : '索引请求';
      result.error = `${stage}：${signal.aborted ? `超时（${timeoutMs / 1000} 秒）` : diagnostics.summary(error)}`;
    } finally { await reader?.cancel().catch(() => {}); }
    diagnostics.debug('pypi.node.tested', 'PyPI 镜像测速结果', { ...result }); return result;
  }
  async test(force = false, signal: AbortSignal = this.abort.signal): Promise<PypiMirrorResult[]> {
    signal.throwIfAborted(); this.abort.signal.throwIfAborted();
    const ttl = this.cache?.results.some(node => node.available) ? CACHE_MS : FAILED_CACHE_MS;
    if (!force && this.cache && this.now() - this.cache.at < ttl) return structuredClone(this.cache.results);
    if (this.pending) return this.pending;
    const task = (async () => {
      this.publish({ phase: 'testing', error: null, nodes: this.emptyNodes() });
      const results: PypiMirrorResult[] = []; let next = 0;
      const workers = Math.max(1, Math.min(8, this.options.concurrency ?? 4, this.mirrors.length));
      await Promise.all(Array.from({ length: workers }, async () => {
        while (next < this.mirrors.length) {
          signal.throwIfAborted(); this.abort.signal.throwIfAborted();
          const node = this.mirrors[next++]!; const result = await this.probe(node, signal); results.push(result);
          this.publish({ nodes: this.state.nodes.map(current => current.mirror === node.mirror ? result : current) });
        }
      }));
      results.sort((a, b) => Number(!!b.available) - Number(!!a.available) || (b.speedBytesPerSecond ?? 0) - (a.speedBytesPerSecond ?? 0) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
      this.cache = { at: this.now(), results }; const available = results.some(node => node.available);
      this.publish({ phase: available ? 'idle' : 'failed', nodes: results, checkedAt: new Date(this.now()).toISOString(), selected: results.find(node => node.available)?.mirror ?? null, error: available ? null : '所有入口测速均失败，请查看各节点失败阶段；无法据此判定镜像站全部失效' });
      return structuredClone(results);
    })(); this.pending = task;
    try { return await task; } catch (error) { this.publish({ phase: 'failed', error: diagnostics.summary(error) }); throw error; } finally { this.pending = undefined; }
  }
  async install(work: (index: string, signal: AbortSignal) => Promise<void>, outer: AbortSignal) {
    const signal = AbortSignal.any([outer, this.abort.signal, AbortSignal.timeout(900000)]); const config = { ...this.config };
    try {
      const results = config.mode === 'official' ? [] : await this.test(false, signal);
      // A failed sample is advisory: pip may still install from a reachable index.
      const candidates = config.mode === 'official' ? [PYPI_OFFICIAL] : [...new Set([...(config.mode === 'mirror' ? [config.mirror] : []), ...results.filter(node => node.available).map(node => node.mirror), ...results.filter(node => !node.available && node.indexReachable && node.stage === 'download').map(node => node.mirror), PYPI_OFFICIAL])];
      const errors: string[] = [];
      for (const index of candidates) {
        signal.throwIfAborted(); this.publish({ phase: 'installing', selected: index, error: null }); diagnostics.info('pypi.install.start', '使用选定 PyPI 镜像安装 musicdl', { index });
        try { await work(index, signal); this.publish({ phase: 'ready', error: null }); return; }
        catch (error) {
          signal.throwIfAborted(); const reason = diagnostics.summary(error); errors.push(`${index}：${reason}`);
          diagnostics.warn('pypi.install.failed', 'PyPI 安装失败，将尝试下一镜像', { index, error });
          this.publish({ nodes: this.state.nodes.map(node => node.mirror === index ? { ...node, available: false, error: reason } : node) });
          if (this.cache) this.cache.results = this.cache.results.map(node => node.mirror === index ? { ...node, available: false, error: reason } : node);
        }
      }
      throw new Error(`musicdl 依赖安装失败：${errors.join('；')}`);
    } catch (error) { this.publish({ phase: 'failed', error: diagnostics.summary(error) }); throw error; }
  }
  close() { this.abort.abort(); }
}
