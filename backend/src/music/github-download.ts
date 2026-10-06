import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { GithubDownloadState, GithubMirrorResult, Settings } from '../contracts';
import { GITHUB_MIRRORS } from './github-mirrors';
import { diagnostics } from '../core/diagnostics';

const SAMPLE_BYTES = 64 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const CACHE_MS = 30 * 60 * 1000;
const label = (mirror: string) => mirror ? new URL(mirror).hostname : 'GitHub 直连';
function message(error: unknown) {
  if (!(error instanceof Error)) return '连接失败';
  if (['TimeoutError', 'AbortError'].includes(error.name)) return '连接或下载超时';
  return error.message === 'fetch failed' ? '无法连接 GitHub 下载节点' : error.message;
}
function archivePrefix(bytes: Uint8Array, url: string) {
  return url.endsWith('.zip') ? bytes[0] === 0x50 && bytes[1] === 0x4b && [3, 5, 7].includes(bytes[2]!) : bytes[0] === 0x1f && bytes[1] === 0x8b;
}
function validateResponse(response: Response) {
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  if (/text\/|json|xml/i.test(response.headers.get('content-type') ?? '')) throw new Error('节点返回了网页，未返回安装包');
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE) throw new Error('安装包过大');
}
export function mirrorUrl(original: string, mirror: string) { return mirror ? `${mirror.replace(/\/$/, '')}/${original}` : original; }
export interface GithubDownloaderOptions {
  mirrors?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  probeTimeoutMs?: number;
  downloadTimeoutMs?: number;
  changed?: (state: GithubDownloadState) => void;
}
export class GithubDownloader {
  private config: Settings['githubDownload'] = { mode: 'auto', mirror: '' };
  private readonly mirrors: readonly string[];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cache = new Map<string, { at: number; results: GithubMirrorResult[] }>();
  private tests = new Map<string, Promise<GithubMirrorResult[]>>();
  private readonly abort = new AbortController();
  private state: GithubDownloadState;
  constructor(private readonly options: GithubDownloaderOptions = {}) {
    this.mirrors = [...new Set([...(options.mirrors ?? GITHUB_MIRRORS), ''])];
    this.fetcher = options.fetch ?? ((...args) => fetch(...args)); this.now = options.now ?? Date.now;
    this.state = { phase: 'idle', selected: null, checkedAt: null, filename: null, error: null, nodes: this.mirrors.map(mirror => this.node(mirror)) };
  }
  private node(mirror: string): GithubMirrorResult { return { mirror, label: label(mirror), available: null, latencyMs: null, speedBytesPerSecond: null, error: null }; }
  configure(config: Settings['githubDownload']) { this.config = { ...config }; }
  snapshot(): GithubDownloadState { return structuredClone(this.state); }
  private publish(update: Partial<GithubDownloadState>) { Object.assign(this.state, update); this.options.changed?.(this.snapshot()); }
  private checkUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || !/^\/[\w.-]+\/[\w.-]+\/releases\/download\//.test(parsed.pathname) || !/\.(zip|tar\.gz)$/.test(parsed.pathname)) throw new Error('仅支持固定版本 GitHub 官方安装包');
  }
  private async probe(url: string, mirror: string, signal: AbortSignal): Promise<GithubMirrorResult> {
    const result = this.node(mirror); const start = performance.now(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(mirrorUrl(url, mirror), { headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}`, 'User-Agent': 'Fenghuangming-mirror-test' }, signal: AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(this.options.probeTimeoutMs ?? 3000)]) });
      reader = response.body?.getReader(); validateResponse(response);
      if (response.status === 206 && !/^bytes 0-\d+\/\d+$/.test(response.headers.get('content-range') ?? '')) throw new Error('节点返回了无效的文件片段');
      const chunks: Buffer[] = []; let size = 0; let latency = 0;
      while (size < SAMPLE_BYTES) {
        const { done, value } = await reader!.read(); if (done) break;
        if (!size) latency = performance.now() - start;
        const part = value.subarray(0, SAMPLE_BYTES - size); chunks.push(Buffer.from(part)); size += part.length;
      }
      if (size < 4 || !archivePrefix(Buffer.concat(chunks), url)) throw new Error('节点返回了无效的安装包');
      result.available = true; result.latencyMs = Math.round(latency); result.speedBytesPerSecond = Math.round(size * 1000 / Math.max(1, performance.now() - start));
    } catch (error) { signal.throwIfAborted(); this.abort.signal.throwIfAborted(); result.available = false; result.error = message(error); }
    finally { await reader?.cancel().catch(() => {}); }
    diagnostics.debug('github.node.tested', 'GitHub 节点测速结果', { ...result, url }); return result;
  }
  async test(url: string, force = false, signal: AbortSignal = this.abort.signal): Promise<GithubMirrorResult[]> {
    this.checkUrl(url); signal.throwIfAborted(); this.abort.signal.throwIfAborted();
    const cached = this.cache.get(url);
    if (!force && cached && this.now() - cached.at < CACHE_MS) return structuredClone(cached.results);
    const pending = this.tests.get(url); if (pending) return pending;
    const task = (async () => {
      this.publish({ phase: 'testing', filename: new URL(url).pathname.split('/').at(-1)!, error: null, nodes: this.mirrors.map(mirror => this.node(mirror)) });
      let cursor = 0;
      const results: GithubMirrorResult[] = [];
      await Promise.all(Array.from({ length: Math.min(8, this.mirrors.length) }, async () => {
        while (cursor < this.mirrors.length) {
          signal.throwIfAborted(); const mirror = this.mirrors[cursor++]!;
          const result = await this.probe(url, mirror, signal); results.push(result);
          this.publish({ nodes: this.state.nodes.map(node => node.mirror === mirror ? result : node) });
        }
      }));
      results.sort((a, b) => Number(!!b.available) - Number(!!a.available) || (b.speedBytesPerSecond ?? 0) - (a.speedBytesPerSecond ?? 0) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
      this.cache.set(url, { at: this.now(), results });
      this.publish({ phase: results.some(x => x.available) ? 'idle' : 'failed', nodes: results, selected: results.find(x => x.available)?.mirror ?? null, checkedAt: new Date(this.now()).toISOString(), error: results.some(x => x.available) ? null : '暂无可用节点，请检查后端网络后重新测速' });
      return structuredClone(results);
    })();
    this.tests.set(url, task);
    try { return await task; }
    catch (error) { this.publish({ phase: 'failed', error: message(error) }); throw error; }
    finally { this.tests.delete(url); }
  }
  async download(url: string, expectedSha256: string, signal: AbortSignal): Promise<Buffer> {
    try { return await this.runDownload(url, expectedSha256, AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(180000)])); }
    catch (error) { this.publish({ phase: 'failed', error: message(error) }); throw error; }
  }
  private async runDownload(url: string, expectedSha256: string, signal: AbortSignal): Promise<Buffer> {
    this.checkUrl(url); const config = { ...this.config }; let candidates: string[];
    if (config.mode === 'direct') candidates = [''];
    else {
      const tested = await this.test(url, false, signal);
      candidates = tested.filter(x => x.available).map(x => x.mirror);
      if (config.mode === 'mirror') candidates.unshift(config.mirror);
      // A timed-out probe must not permanently exclude a working official URL.
      candidates = [...new Set([...candidates, ''])];
    }
    const errors: string[] = [];
    for (const mirror of candidates) {
      signal.throwIfAborted(); this.abort.signal.throwIfAborted();
      this.publish({ phase: 'downloading', selected: mirror, filename: new URL(url).pathname.split('/').at(-1)!, error: null });
      diagnostics.info('github.download.start', '从选定节点下载官方程序', { mirror: label(mirror), url });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await this.fetcher(mirrorUrl(url, mirror), { headers: { 'User-Agent': 'Fenghuangming-runtime' }, signal: AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(this.options.downloadTimeoutMs ?? 60000)]) });
        reader = response.body?.getReader(); validateResponse(response);
        if (response.status !== 200) throw new Error('节点未返回完整安装包');
        const chunks: Buffer[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader!.read(); if (done) break;
          size += value.length; if (size > MAX_ARCHIVE) throw new Error('安装包过大'); chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('安装包 SHA-256 校验失败');
        diagnostics.info('github.download.verified', 'GitHub 安装包校验通过', { mirror: label(mirror), bytes: bytes.length }); this.publish({ phase: 'ready', selected: mirror, error: null }); return bytes;
      } catch (error) {
        signal.throwIfAborted(); this.abort.signal.throwIfAborted(); const reason = message(error); errors.push(`${label(mirror)}：${reason}`);
        diagnostics.warn('github.download.failed', '下载节点失败，将尝试下一节点', { mirror: label(mirror), error });
        const nodes = this.state.nodes.map(node => node.mirror === mirror ? { ...node, available: false, error: reason } : node);
        this.publish({ nodes });
        const cached = this.cache.get(url); if (cached) cached.results = cached.results.map(node => node.mirror === mirror ? { ...node, available: false, error: reason } : node);
      } finally { await reader?.cancel().catch(() => {}); }
    }
    const error = `下载 GitHub 安装包失败：${errors.join('；')}。请重新测速或更换节点`;
    this.publish({ phase: 'failed', error }); throw new Error(error);
  }
  close() { this.abort.abort(); }
}
