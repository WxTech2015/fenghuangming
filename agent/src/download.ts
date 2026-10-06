import type { FileHandle } from 'node:fs/promises';
export interface TransferProgress { bytes: number; total: number; speedBytesPerSecond: number; connections: number }
export async function downloadCachedAudio(url: URL, token: string, file: FileHandle, total: number, outer: AbortSignal, progress: (value: TransferProgress) => void) {
  if (!Number.isSafeInteger(total) || total < 1 || total > 200 * 1024 * 1024) throw new Error('音频大小无效或超过上限');
  const signal = AbortSignal.any([outer, AbortSignal.timeout(180000)]);
  const started = Date.now(); let bytes = 0; let lastReport = 0; let connections = total >= 2 * 1024 * 1024 ? 4 : 1;
  const report = (force = false) => { if (!force && Date.now() - lastReport < 250) return; lastReport = Date.now(); progress({ bytes, total, connections, speedBytesPerSecond: Math.round(bytes * 1000 / Math.max(1, Date.now() - started)) }); };
  const write = async (data: Uint8Array, position: number) => { let offset = 0; while (offset < data.length) { const written = await file.write(data, offset, data.length - offset, position + offset); if (!written.bytesWritten) throw new Error('音频缓存写入失败'); offset += written.bytesWritten; } bytes += data.length; report(); };
  const request = async (headers: Record<string, string>, requestSignal = signal) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity', ...headers }, signal: requestSignal, redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error(`音频下载失败 HTTP ${response.status}`); }
    return response;
  };
  report(true);
  if (connections > 1) {
    const abort = new AbortController(); const rangeSignal = AbortSignal.any([signal, abort.signal]);
    const size = Math.ceil(total / connections);
    const jobs = Array.from({ length: connections }, async (_, n) => {
      const start = n * size; const end = Math.min(total - 1, start + size - 1);
      const response = await request({ Range: `bytes=${start}-${end}` }, rangeSignal);
      try {
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${total}` || response.headers.get('content-encoding')) throw new Error('后端未返回正确的分段音频');
        let received = 0;
        for await (const chunk of response.body!) { if (received + chunk.length > end - start + 1) throw new Error('分段超过预期大小'); await write(chunk, start + received); received += chunk.length; }
        if (received !== end - start + 1) throw new Error('音频分段不完整');
      } finally { await response.body?.cancel().catch(() => {}); }
    });
    try { await Promise.all(jobs); report(true); return; }
    catch (error) { abort.abort(); await Promise.allSettled(jobs); signal.throwIfAborted(); console.error(new Date().toISOString(), '分段下载回退单连接:', error instanceof Error ? error.message : error); await file.truncate(0); bytes = 0; connections = 1; report(true); }
  }
  const response = await request({});
  try {
    if (response.status !== 200) throw new Error('完整音频响应无效');
    for await (const chunk of response.body!) { if (bytes + chunk.length > total) throw new Error('音频超过预期大小'); await write(chunk, bytes); }
    if (bytes !== total) throw new Error('音频下载不完整'); report(true);
  } finally { await response.body?.cancel().catch(() => {}); }
}
