import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EngineSchema, type MediaAsset, type QueueItem } from '../contracts';
import { Store } from '../core/store';
import { audit, checkBlacklist, now, pending, settings, trackKey } from '../core/domain';
import { AppError } from '../core/errors';
import { MusicService, type ResolvedSource } from '../music/providers';
import { downloadAudio, AudioWriteError } from './download';
import { diagnostics, traceFor } from '../core/diagnostics';

class MediaCacheError extends AppError {
  constructor(message: string, readonly cause: unknown) { super('MEDIA_CACHE_ERROR', `${message}：${diagnostics.summary(cause)}`, 500); }
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new AppError('INVALID_RANGE', '无效音频范围', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || end < 0) throw new AppError('INVALID_RANGE', '无效音频范围', 416);
  return { start, end, partial: true };
}
export class MediaService {
  private readonly jobs = new Map<string, Promise<MediaAsset>>();
  private readonly abort = new AbortController();
  constructor(readonly store: Store, readonly music: MusicService, readonly directory: string, readonly secret: string) {}
  async prepare(item: QueueItem) {
    return diagnostics.scope({ traceId: item.id.startsWith('diagnostic_') ? item.requestKey : traceFor(item.requestKey), itemId: item.id, zoneId: item.zoneId, engine: item.engine }, () => this.prepareItem(item));
  }
  private async prepareItem(item: QueueItem) {
    this.abort.signal.throwIfAborted();
    diagnostics.info('media.prepare.start', '准备歌曲音频', { platform: item.track.platform, externalId: item.track.externalId, title: item.track.title });
    await this.checkAllowed(item);
    const key = createHash('sha256').update(`${item.engine}:${trackKey(item.track)}`).digest('hex');
    const running = this.jobs.get(key); if (running) { diagnostics.debug('media.prepare.shared', '等待同曲下载任务'); const asset = await running; await this.checkAllowed(item, asset.source); return asset; }
    const job = this.download(item, key); this.jobs.set(key, job);
    try { const asset = await job; await this.checkAllowed(item, asset.source); return asset; } finally { this.jobs.delete(key); }
  }
  private async download(item: QueueItem, key: string): Promise<MediaAsset> {
    const config = await this.store.transaction(tx => settings(tx));
    const cached = await this.store.transaction(async tx => (await tx.all('mediaAsset')).find(x => x.trackKey === key));
    if (cached && (cached.source?.match !== 'search' || config.searchFallback)) {
      try {
        const info = await stat(this.path(cached));
        if (info.size === cached.bytes) { await this.checkAllowed(item, cached.source); const next = { ...cached, lastAccessedAt: now() }; await this.cacheOperation('更新缓存记录失败', () => this.store.transaction(tx => tx.put('mediaAsset', next))); diagnostics.info('media.cache.hit', '复用已校验音频缓存', { assetId: cached.id, source: cached.source, bytes: cached.bytes }); return next; }
        diagnostics.warn('media.cache.invalid', '缓存大小变化，将重新取源', { expectedBytes: cached.bytes, actualBytes: info.size });
      } catch (error) { if (error instanceof MediaCacheError || error instanceof AppError && error.code === 'BLACKLISTED') throw error; diagnostics.debug('media.cache.missing', '缓存文件不可用，将重新取源', { error }); }
    }
    const failures: string[] = [];
    try {
      for await (const source of this.music.sources(item.engine, item.track, config)) {
        this.abort.signal.throwIfAborted();
        const candidate = source.track ?? item.track;
        await this.checkAllowed(item, { platform: candidate.platform, externalId: candidate.externalId });
        try { return await this.downloadSource(item, key, config, source); }
        catch (error) { this.abort.signal.throwIfAborted(); if (error instanceof MediaCacheError) throw error; diagnostics.warn('media.source.failed', '音源下载或完整音频校验失败，将尝试下一音源', { engine: source.source, match: source.match, error }); failures.push(`${source.source}：${diagnostics.summary(error)}`); }
      }
    } catch (error) { if (error instanceof MediaCacheError || error instanceof AppError && error.code === 'BLACKLISTED') throw error; diagnostics.warn('media.resolve.failed', '取源路径已失败', { error }); failures.push(diagnostics.summary(error)); }
    diagnostics.error('media.prepare.failed', '没有取得可播放的完整音频', { failures });
    throw new AppError('AUDIO_SOURCES_FAILED', failures.slice(0, 8).join('；') || '暂无可播放的完整音频');
  }
  private async checkAllowed(item: QueueItem, source?: Pick<NonNullable<MediaAsset['source']>, 'platform' | 'externalId'>) {
    await this.store.transaction(async tx => { const rules = await tx.all('blacklist'); checkBlacklist(rules, item); if (source) checkBlacklist(rules, { ...item, track: { ...item.track, platform: source.platform, externalId: source.externalId } }); });
  }
  private async cacheOperation<T>(message: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { diagnostics.error('media.cache.failed', message, { directory: this.directory, error }); throw new MediaCacheError(message, error); }
  }
  private async downloadSource(item: QueueItem, key: string, config: Awaited<ReturnType<typeof settings>>, source: ResolvedSource): Promise<MediaAsset> {
    const started = Date.now();
    diagnostics.info('media.download.start', '开始下载候选音频', { engine: source.source, match: source.match, url: source.url });
    const maxBytes = Math.min(200 * 1024 * 1024, config.cacheMaxMb * 1024 * 1024);
    const filename = `${key}.audio`; const temp = join(this.directory, `${key}.${Date.now()}.tmp`);
    let file: Awaited<ReturnType<typeof open>>;
    try { await mkdir(this.directory, { recursive: true }); file = await open(temp, 'wx'); }
    catch (error) { diagnostics.error('media.cache.write_failed', '无法创建音频缓存文件', { directory: this.directory, error }); throw new MediaCacheError('无法创建音频缓存文件', error); }
    try {
      const transfer = await downloadAudio(source, file, maxBytes, config.downloads.connections, this.abort.signal);
      const bytes = transfer.bytes;
      await this.cacheOperation('关闭音频缓存文件失败', () => file.close());
      const hash = createHash('sha256'); for await (const chunk of createReadStream(temp)) hash.update(chunk);
      diagnostics.info('media.download.complete', '候选音频下载完成，开始检查格式和时长', { engine: source.source, ...transfer });
      const validationStarted = Date.now();
      // Node 24 supports synchronous ESM loading from this CommonJS build.
      const metadataModule = require('music-metadata') as typeof import('music-metadata');
      const metadata = await metadataModule.parseFile(temp, { duration: true });
      const duration = metadata.format.duration ?? 0;
      diagnostics.debug('media.validation.metadata', '读取实际音频信息', { codec: metadata.format.codec, container: metadata.format.container, bitrate: metadata.format.bitrate, sampleRate: metadata.format.sampleRate, bitsPerSample: metadata.format.bitsPerSample, channels: metadata.format.numberOfChannels, durationSeconds: duration, expectedDurationSeconds: item.track.durationSeconds, bytes });
      if (!metadata.format.codec || bytes < 1024 || duration < 5) throw new AppError('INVALID_AUDIO', '下载结果不是有效音频');
      if (duration > config.maxDurationSeconds) throw new AppError('TOO_LONG', '实际音频超过时长限制');
      const expectedDuration = Math.max(item.track.durationSeconds, source.track?.durationSeconds ?? 0);
      if (expectedDuration > 40 && duration < expectedDuration * 0.8) throw new AppError('AUDIO_PREVIEW', '匹配到的音源疑似试听片段');
      if (source.match === 'search' && expectedDuration > 0 && Math.abs(duration - expectedDuration) > Math.max(5, expectedDuration * 0.03)) throw new AppError('AUDIO_MISMATCH', '搜索音频的实际时长与原歌曲不一致');
      const mime = metadata.format.container === 'FLAC' ? 'audio/flac' : metadata.format.container?.includes('MPEG') ? 'audio/mpeg' : 'application/octet-stream';
      await this.cacheOperation('保存音频缓存文件失败', () => rename(temp, join(this.directory, filename)));
      const asset: MediaAsset = { id: `media_${key.slice(0, 32)}`, trackKey: key, filename, mime, bytes, sha256: hash.digest('hex'), durationSeconds: duration, createdAt: now(), lastAccessedAt: now() };
      const candidate = source.track ?? item.track;
      if (source.source === 'direct' || EngineSchema.safeParse(source.source).success) asset.source = { engine: source.source as NonNullable<MediaAsset['source']>['engine'], match: source.match ?? 'id', platform: candidate.platform, externalId: candidate.externalId };
      await this.cacheOperation('保存音频缓存到数据库失败', () => this.store.transaction(async tx => { await tx.put('mediaAsset', asset); await audit(tx, 'audio.source', item.id, `${source.source} / ${source.match ?? 'id'} / ${candidate.platform}:${candidate.externalId}`); }));
      await this.cacheOperation('清理过期音频缓存失败', () => this.evict(config.cacheMaxMb * 1024 * 1024, asset.id));
      diagnostics.info('media.validation.ok', '完整音频校验通过并写入缓存', { assetId: asset.id, source: asset.source, durationSeconds: duration, bytes, durationMs: Date.now() - started, validationMs: Date.now() - validationStarted }); return asset;
    } catch (error) { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); if (error instanceof AudioWriteError) throw new MediaCacheError(error.message, error.cause); throw error; }
  }
  path(asset: MediaAsset) {
    if (basename(asset.filename) !== asset.filename || !/^[a-f0-9]{64}\.audio$/.test(asset.filename)) throw new AppError('INVALID_ASSET', '缓存文件路径不正确');
    return join(this.directory, asset.filename);
  }
  stream(asset: MediaAsset, start: number, end: number) { return createReadStream(this.path(asset), { start, end }); }
  async close() { this.abort.abort(); await Promise.allSettled(this.jobs.values()); }
  ticket(agentId: string, assetId: string, playbackId: string) {
    const payload = Buffer.from(JSON.stringify({ agentId, assetId, playbackId, expires: Date.now() + 10 * 60 * 1000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
  }
  verifyTicket(ticket: string, agentId: string, assetId: string) {
    const [payload, signature] = ticket.split('.');
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', this.secret).update(payload).digest(); const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try { const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>; return parsed.agentId === agentId && parsed.assetId === assetId && typeof parsed.expires === 'number' && parsed.expires > Date.now(); } catch { return false; }
  }
  private async evict(limit: number, protectedId: string) {
    const candidates = await this.store.transaction(async tx => {
      const items = await tx.all('queueItem');
      const used = new Set(items.filter(pending).map(x => x.assetId));
      const preparing = new Set(items.filter(x => ['preparing', 'dispatching', 'playing'].includes(x.status)).map(x => createHash('sha256').update(`${x.engine}:${trackKey(x.track)}`).digest('hex')));
      const assets = (await tx.all('mediaAsset')).sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
      let total = assets.reduce((sum, a) => sum + a.bytes, 0); const removed: MediaAsset[] = [];
      for (const asset of assets) if (total > limit && asset.id !== protectedId && !used.has(asset.id) && !preparing.has(asset.trackKey) && !this.jobs.has(asset.trackKey)) { await tx.remove('mediaAsset', asset.id); removed.push(asset); total -= asset.bytes; }
      return removed;
    });
    for (const asset of candidates) await unlink(this.path(asset)).catch(() => {});
  }
}
