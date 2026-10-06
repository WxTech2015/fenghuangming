import type { MusicRuntimeStatus, Settings, Track } from '../contracts';
import { AppError } from '../core/errors';
import { diagnostics } from '../core/diagnostics';
import { platformJson } from './direct';
import type { AudioProvider, ResolvedSource } from './providers';

export const GD_STUDIO_API = 'https://music-api.gdstudio.xyz/api.php';
const WINDOW_MS = 5 * 60 * 1000;
const platformSources: Partial<Record<Track['platform'], string>> = { netease: 'netease', qq: 'tencent', kuwo: 'kuwo' };
interface GDStudioOptions { request?: (url: string) => Promise<unknown>; now?: () => number; maxRequests?: number; changed?: (status: MusicRuntimeStatus) => void }

export class GDStudioProvider implements AudioProvider {
  readonly name = 'gdstudio' as const;
  status: MusicRuntimeStatus = { mode: 'external', phase: 'stopped', installed: true, version: '', baseUrl: GD_STUDIO_API, error: null };
  private enabled = false;
  private closed = false;
  private readonly requests: number[] = [];
  constructor(private readonly options: GDStudioOptions = {}) { this.options.changed?.({ ...this.status }); }
  private publish(phase: MusicRuntimeStatus['phase'], error: string | null = null) {
    if (this.closed && phase !== 'stopped') return;
    this.status = { ...this.status, phase, error };
    this.options.changed?.({ ...this.status });
  }
  configure(enabled: boolean) {
    if (this.closed || this.enabled === enabled) return;
    this.enabled = enabled; this.publish(enabled ? 'external' : 'stopped');
  }
  restart() { if (!this.closed) this.publish(this.enabled ? 'external' : 'stopped'); }
  private reserve() {
    const now = (this.options.now ?? Date.now)();
    while (this.requests.length && this.requests[0]! <= now - WINDOW_MS) this.requests.shift();
    if (this.requests.length >= (this.options.maxRequests ?? 50)) {
      const seconds = Math.max(1, Math.ceil((this.requests[0]! + WINDOW_MS - now) / 1000));
      throw new AppError('SOURCE_RATE_LIMIT', `GD Studio 请求频率已达上限，请在 ${seconds} 秒后重试，或使用其他音源`, 429);
    }
    this.requests.push(now);
  }
  async resolve(track: Track, settings: Settings): Promise<ResolvedSource> {
    if (this.closed) throw new AppError('ENGINE_UNAVAILABLE', 'GD Studio 音源已关闭');
    const source = platformSources[track.platform];
    if (!source) throw new AppError('SOURCE_UNSUPPORTED', `GD Studio 未接入 ${track.platform}，将继续尝试其他音源`);
    if (!track.externalId || track.platform === 'qq' && /^\d+$/.test(track.externalId)) throw new AppError('SOURCE_UNSUPPORTED', 'GD Studio 需要原歌曲 ID，QQ 音乐需要 songmid');
    const url = new URL(GD_STUDIO_API);
    url.search = new URLSearchParams({ types: 'url', source, id: track.externalId, br: settings.gdstudio.quality }).toString();
    const started = Date.now();
    try {
      this.reserve();
      diagnostics.info('gdstudio.resolve.start', 'GD 音乐台按原歌曲 ID 取源', { platform: track.platform, externalId: track.externalId, quality: settings.gdstudio.quality });
      // Public API receives only the source/ID/quality, never platform cookies.
      const result = await (this.options.request ?? platformJson)(url.href);
      if (this.closed) throw new AppError('ENGINE_UNAVAILABLE', 'GD Studio 音源已关闭');
      const body = result as { url?: unknown; br?: unknown; size?: unknown; id?: unknown; source?: unknown; error?: unknown; message?: unknown } | null;
      if (!body || Array.isArray(body) || typeof body.url !== 'string' || !body.url) throw new AppError('SOURCE_UNAVAILABLE', `GD Studio 未返回原歌曲音频${typeof body?.error === 'string' || typeof body?.message === 'string' ? `：${diagnostics.summary(body.error ?? body.message)}` : ''}`);
      if (body.id !== undefined && String(body.id) !== track.externalId || body.source !== undefined && body.source !== source) throw new AppError('SOURCE_MISMATCH', 'GD Studio 返回的歌曲或平台与原分享不一致');
      const audio = new URL(body.url);
      if (!['http:', 'https:'].includes(audio.protocol) || audio.username || audio.password) throw new AppError('BAD_AUDIO_URL', 'GD Studio 返回的音频地址格式不正确');
      diagnostics.info('gdstudio.resolve.complete', 'GD 音乐台已返回音频地址', { platform: track.platform, externalId: track.externalId, requestedQuality: settings.gdstudio.quality, reportedBitrate: body.br, reportedSizeKb: body.size, url: audio.href, durationMs: Date.now() - started });
      if (this.enabled) this.publish('external');
      const referer = track.platform === 'netease' ? 'https://music.163.com/' : track.platform === 'qq' ? 'https://y.qq.com/' : 'https://www.kuwo.cn/';
      return { url: audio.href, source: this.name, headers: { Referer: referer } };
    } catch (error) {
      const detail = diagnostics.summary(error);
      if (this.enabled) this.publish('failed', detail);
      diagnostics.warn('gdstudio.resolve.failed', 'GD 音乐台取源失败，将继续尝试其他音源', { platform: track.platform, externalId: track.externalId, durationMs: Date.now() - started, error });
      throw error;
    }
  }
  close() { this.closed = true; this.enabled = false; this.publish('stopped'); }
}
