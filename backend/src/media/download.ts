import type { FileHandle } from 'node:fs/promises';
import { AppError } from '../core/errors';
import { diagnostics } from '../core/diagnostics';
import type { ResolvedSource } from '../music/providers';
import { openAudioUrl, type AudioResponse } from '../music/network';

export class AudioWriteError extends Error { constructor(readonly cause: unknown) { super('写入音频缓存文件失败'); } }
export async function downloadAudio(source: ResolvedSource, file: FileHandle, maxBytes: number, connections: number, outer?: AbortSignal) {
  const started = Date.now(); const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  let bytes = 0; let lastLog = 0;
  const progress = () => {
    if (Date.now() - lastLog < 2000) return; lastLog = Date.now();
    diagnostics.debug('media.download.progress', '音频下载进度', { bytes, durationMs: Date.now() - started, speedBytesPerSecond: Math.round(bytes * 1000 / Math.max(1, Date.now() - started)) });
  };
  const write = async (buffer: Buffer, position: number) => {
    try { let offset = 0; while (offset < buffer.length) { const result = await file.write(buffer, offset, buffer.length - offset, position + offset); if (!result.bytesWritten) throw new Error('缓存写入未取得进展'); offset += result.bytesWritten; } }
    catch (error) { throw new AudioWriteError(error); }
    bytes += buffer.length; progress();
  };
  const checkResponse = async (response: AudioResponse) => {
    const type = String(response.headers['content-type'] ?? '');
    if (/json|html|xml/i.test(type)) {
      let detail = '';
      if (/json/i.test(type)) {
        const chunks: Buffer[] = []; let size = 0;
        try { for await (const chunk of response) { const part = Buffer.from(chunk).subarray(0, 4096 - size); chunks.push(part); size += part.length; if (size >= 4096) break; } const body = JSON.parse(Buffer.concat(chunks).toString()); detail = diagnostics.summary({ message: body.error ?? body.message ?? body.msg ?? '接口未返回音频', code: body.code }); } catch {}
      }
      response.destroy(); diagnostics.warn('media.response.not_audio', '上游返回了错误信息或网页', { engine: source.source, contentType: type, status: response.statusCode, detail }); throw new AppError('AUDIO_RESPONSE_ERROR', `${source.source} 未返回音频（${type}）${detail ? '：' + detail : ''}`);
    }
    if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw new AppError('AUDIO_TOO_LARGE', '音频文件超过大小限制'); }
  };
  const request = (url: string, headers: Record<string, string>, requestSignal = signal) => openAudioUrl(url, source.trustedOrigin, 0, { 'Accept-Encoding': 'identity', ...headers }, 120000, { signal: requestSignal, allowPartial: true });
  const eligible = connections > 1 && source.parallel !== false && source.source !== 'gomusicdl';
  let response = await request(source.url, { ...source.headers, ...(eligible ? { Range: 'bytes=0-0' } : {}) });
  await checkResponse(response);
  const connectionMs = Date.now() - started;
  const match = /^bytes 0-0\/(\d+)$/.exec(String(response.headers['content-range'] ?? ''));
  const total = match ? Number(match[1]) : 0;
  if (total > maxBytes) { response.destroy(); throw new AppError('AUDIO_TOO_LARGE', '音频文件超过大小限制'); }
  const etag = String(response.headers.etag ?? ''); const modified = String(response.headers['last-modified'] ?? '');
  const validator = etag.startsWith('"') ? etag : modified && Number.isFinite(Date.parse(modified)) ? modified : '';
  const ranged = eligible && response.statusCode === 206 && Number.isSafeInteger(total) && total >= 2 * 1024 * 1024 && !!validator && !response.headers['content-encoding'];
  if (ranged) {
    const url = response.sourceUrl; const headers = response.sourceHeaders;
    response.destroy();
    const abort = new AbortController(); const rangeSignal = AbortSignal.any([signal, abort.signal]);
    const count = Math.min(8, connections, Math.floor(total / (512 * 1024)));
    const size = Math.ceil(total / count);
    diagnostics.info('media.download.parallel', '使用分段并行下载音频', { connections: count, totalBytes: total, connectionMs });
    const jobs = Array.from({ length: count }, async (_, n) => {
      const start = n * size; const end = Math.min(total - 1, start + size - 1);
      const part = await request(url, { ...headers, Range: `bytes=${start}-${end}`, 'If-Range': validator }, rangeSignal);
      try {
        await checkResponse(part);
        if (part.statusCode !== 206 || part.headers['content-range'] !== `bytes ${start}-${end}/${total}` || part.headers['content-encoding'] || (etag.startsWith('"') ? part.headers.etag !== etag : part.headers['last-modified'] !== modified)) throw new AppError('AUDIO_RANGE_ERROR', '上游分段响应或文件版本发生变化');
        let received = 0;
        for await (const chunk of part) { const buffer = Buffer.from(chunk); if (received + buffer.length > end - start + 1) throw new AppError('AUDIO_RANGE_ERROR', '分段长度超过预期'); await write(buffer, start + received); received += buffer.length; }
        if (received !== end - start + 1) throw new AppError('AUDIO_RANGE_ERROR', '分段下载不完整');
      } finally { part.destroy(); }
    });
    try {
      await Promise.all(jobs);
      return { bytes, connections: count, connectionMs, durationMs: Date.now() - started, speedBytesPerSecond: Math.round(bytes * 1000 / Math.max(1, Date.now() - started)) };
    } catch (error) {
      abort.abort(); await Promise.allSettled(jobs); signal.throwIfAborted(); if (error instanceof AudioWriteError) throw error;
      diagnostics.warn('media.download.parallel_fallback', '分段下载失败，重新使用单连接下载同一音源', { error });
      try { await file.truncate(0); } catch (error) { throw new AudioWriteError(error); }
      bytes = 0; response = await request(source.url, source.headers ?? {}); await checkResponse(response);
    }
  } else if (response.statusCode === 206) {
    diagnostics.debug('media.download.single', '此音源使用单连接完整下载', { reason: !validator ? 'no_validator' : total < 2 * 1024 * 1024 ? 'small_file' : 'invalid_range' });
    response.destroy(); response = await request(source.url, source.headers ?? {}); await checkResponse(response);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new AppError('AUDIO_RANGE_ERROR', '完整下载未返回完整文件'); }
  const expected = Number(response.headers['content-length']) || null;
  try {
    for await (const chunk of response) { const buffer = Buffer.from(chunk); if (bytes + buffer.length > maxBytes) throw new AppError('AUDIO_TOO_LARGE', '音频文件超过大小限制'); await write(buffer, bytes); }
    if (expected !== null && bytes !== expected) throw new AppError('AUDIO_INCOMPLETE', '音频下载长度与声明不符');
  } finally { response.destroy(); }
  return { bytes, connections: 1, connectionMs, durationMs: Date.now() - started, speedBytesPerSecond: Math.round(bytes * 1000 / Math.max(1, Date.now() - started)) };
}
