import type { AudioEngine, Settings, Track } from '../contracts';
import { AppError } from '../core/errors';
import { canonicalTrack, originalSources } from './direct';
import { diagnostics } from '../core/diagnostics';

export interface ResolvedSource { url: string; trustedOrigin?: string; source: string; headers?: Record<string, string>; track?: Track; match?: 'original' | 'id' | 'search'; parallel?: boolean }
export interface AudioProvider { readonly name: AudioEngine; resolve(track: Track, settings: Settings): Promise<ResolvedSource>; search?(track: Track, settings: Settings): Promise<Track[]> }
export type ManagedEndpoint = (config: Settings['gomusicdl']) => Promise<string>;

export class GoMusicDlProvider implements AudioProvider {
  readonly name = 'gomusicdl' as const;
  constructor(private readonly managedEndpoint?: ManagedEndpoint) {}
  async resolve(track: Track, settings: Settings): Promise<ResolvedSource> {
    if (!track.externalId) throw new AppError('SOURCE_UNSUPPORTED', 'go-music-dl 需要原歌曲 ID');
    if (track.platform === 'bodian') throw new AppError('SOURCE_UNSUPPORTED', 'go-music-dl 暂不支持波点，请分享网易云、QQ、酷狗、酷我或咪咕的同曲卡片');
    const config = settings.gomusicdl;
    const address = config.mode === 'external' ? config.baseUrl : await this.managedEndpoint?.(config);
    if (!address) throw new AppError('ENGINE_UNAVAILABLE', '自动音源服务尚未启动，请在音源设置中重试');
    const base = new URL(address.replace(/\/$/, '') + '/');
    const url = new URL('download', base);
    url.search = new URLSearchParams({ id: track.externalId, source: track.platform, name: track.title, artist: track.artists.join('/'), album: track.album, cover: track.coverUrl, stream: '1' }).toString();
    // go-music-dl streams audio and handles the platform's request headers.
    return { url: url.href, trustedOrigin: base.origin, source: 'gomusicdl', parallel: false };
  }
}
export class MusicService {
  private readonly providers: Map<AudioEngine, AudioProvider>;
  constructor(providers: AudioProvider[] = [new GoMusicDlProvider()], private readonly options: { original?: (track: Track) => AsyncIterable<ResolvedSource>; canonical?: (track: Track) => Promise<Track> } = {}) { this.providers = new Map(providers.map(p => [p.name, p])); }
  async resolve(engine: AudioEngine, track: Track, settings: Settings) {
    const provider = this.providers.get(engine);
    if (!provider) throw new AppError('ENGINE_UNAVAILABLE', '音源引擎未安装');
    return provider.resolve(track, settings);
  }
  // Yield lazily: the downloader requests the next source only after the
  // previous source fails download/audio validation. A working link never
  // invokes a backup engine or a search.
  async *sources(engine: AudioEngine, original: Track, settings: Settings): AsyncGenerator<ResolvedSource> {
    const errors: string[] = [];
    diagnostics.info('music.resolve.start', '开始按原歌曲取源', { engine, platform: original.platform, externalId: original.externalId, title: original.title, artists: original.artists, fallbackEngines: settings.fallbackEngines, searchFallback: settings.searchFallback });
    try { diagnostics.debug('music.original.start', '解析原分享歌曲'); yield* (this.options.original ?? originalSources)(original); }
    catch (error) { diagnostics.warn('music.original.failed', '原链接解析失败，将尝试备用音源', { error }); errors.push(`原链接：${diagnostics.summary(error)}`); }
    let track = original;
    try { track = await (this.options.canonical ?? canonicalTrack)(original); }
    catch (error) { diagnostics.warn('music.canonical.failed', '原平台 ID 转换失败', { error }); errors.push(`原平台 ID 转换：${diagnostics.summary(error)}`); }
    const order = [...new Set([engine, ...settings.fallbackEngines])];
    for (const name of order) {
      const provider = this.providers.get(name);
      if (!provider || !track.externalId) { diagnostics.warn('music.provider.skipped', '跳过不能按歌曲 ID 取源的音源', { engine: name, reason: !provider ? 'provider_missing' : 'track_id_missing' }); continue; }
      const started = Date.now();
      diagnostics.info('music.provider.start', '调用音源解析原歌曲', { engine: name, platform: track.platform, externalId: track.externalId });
      try { const source = await provider.resolve(track, settings); diagnostics.info('music.provider.resolved', '音源已返回下载地址', { engine: name, url: source.url, durationMs: Date.now() - started }); yield { ...source, source: name, track, match: 'id' }; }
      catch (error) { diagnostics.warn('music.provider.failed', '音源取源失败', { engine: name, durationMs: Date.now() - started, error }); errors.push(`${name}：${diagnostics.summary(error)}`); }
    }
    if (settings.searchFallback && original.artists.some(a => a.trim())) {
      for (const name of order) {
        const provider = this.providers.get(name); if (!provider?.search) continue;
        try {
          diagnostics.info('music.search.start', '开始搜索同曲', { engine: name });
          const found = await provider.search(original, settings); const candidates = found.filter(candidate => sameRecording(original, candidate)).slice(0, 3);
          diagnostics.info('music.search.matched', '同曲身份匹配完成', { engine: name, found: found.length, matched: candidates.length });
          for (const candidate of candidates) {
            try { yield { ...await provider.resolve(candidate, settings), source: name, track: candidate, match: 'search' }; }
            catch (error) { diagnostics.warn('music.search.resolve_failed', '搜索候选取源失败', { engine: name, externalId: candidate.externalId, error }); errors.push(`${name}：同曲取源 ${diagnostics.summary(error)}`); }
          }
        } catch (error) { diagnostics.warn('music.search.failed', '同曲搜索失败', { engine: name, error }); errors.push(`${name}：同曲搜索 ${diagnostics.summary(error)}`); }
      }
    }
    diagnostics.error('music.resolve.exhausted', '所有取源路径均已失败', { failures: errors });
    throw new AppError('AUDIO_SOURCES_FAILED', errors.length ? errors.slice(0, 6).join('；') : '所有音源均不可用；未找到能确认身份的完整音频');
  }
}

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s·・]/g, '').trim();
export function sameRecording(original: Track, candidate: Track) {
  if (original.platform !== candidate.platform || !candidate.externalId || normalized(original.title) !== normalized(candidate.title)) return false;
  const artists = (track: Track) => [...new Set(track.artists.map(normalized).filter(Boolean))].sort().join('|');
  if (!artists(original) || artists(original) !== artists(candidate)) return false;
  if (original.durationSeconds > 0 && (!candidate.durationSeconds || Math.abs(original.durationSeconds - candidate.durationSeconds) > Math.max(5, original.durationSeconds * 0.03))) return false;
  return true;
}
