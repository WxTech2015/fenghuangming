import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { downloadAudio } from '../src/media/download';
const data = Buffer.alloc(3 * 1024 * 1024 + 137); for (let n = 0; n < data.length; n++) data[n] = n % 251;
let directory = ''; let server: Server | undefined;
afterEach(async () => { await new Promise<void>(ok => server ? server.close(() => ok()) : ok()); server = undefined; if (directory) { if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-ranges-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); directory = ''; } });
async function run(mode: 'range' | 'ignore' | 'wrong' | 'changed' | 'stream') {
  directory = await mkdtemp(join(tmpdir(), 'qqmusic-ranges-')); const ranges: string[] = []; let active = 0; let peak = 0;
  server = createServer((req, res) => {
    const range = req.headers.range; ranges.push(range ?? 'full');
    if (!range || mode === 'ignore') { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
    const match = /bytes=(\d+)-(\d+)/.exec(range)!; const start = Number(match[1]); const end = Number(match[2]);
    active++; peak = Math.max(peak, active); res.on('close', () => active--);
    const wrong = mode === 'wrong' && start > 0;
    res.writeHead(206, { 'Content-Range': `bytes ${wrong ? start + 1 : start}-${end}/${data.length}`, 'Content-Length': end - start + 1, ETag: mode === 'changed' && start > 0 ? '"changed"' : '"same"' });
    setTimeout(() => res.end(data.subarray(start, end + 1)), 15);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const filename = join(directory, 'audio'); const file = await open(filename, 'wx');
  try { const result = await downloadAudio({ url: base + '/audio', trustedOrigin: base, source: mode === 'stream' ? 'gomusicdl' : 'direct' }, file, data.length + 1, 4); await file.close(); return { result, bytes: await readFile(filename), ranges, peak }; }
  finally { await file.close().catch(() => {}); }
}
it('分段并行写入正确偏移，最终文件逐字节一致', async () => { const r = await run('range'); expect(r.result.connections).toBe(4); expect(r.peak).toBeGreaterThan(1); expect(r.ranges).toHaveLength(5); expect(r.bytes.equals(data)).toBe(true); });
it.each(['wrong', 'changed'] as const)('范围或版本变化时取消所有分段并重新下载同一 URL：%s', async mode => { const r = await run(mode); expect(r.result.connections).toBe(1); expect(r.ranges).toContain('full'); expect(r.bytes.equals(data)).toBe(true); });
it('不支持 Range 的服务只下载一次完整文件', async () => { const r = await run('ignore'); expect(r.result.connections).toBe(1); expect(r.ranges).toEqual(['bytes=0-0']); expect(r.bytes.equals(data)).toBe(true); });
it('go-music-dl 流式接口不分段重复触发上游下载', async () => { const r = await run('stream'); expect(r.ranges).toEqual(['full']); expect(r.bytes.equals(data)).toBe(true); });
it('取消并行下载会关闭全部分段，且不启动回退下载', async () => {
  directory = await mkdtemp(join(tmpdir(), 'qqmusic-ranges-')); const requests: string[] = []; const abort = new AbortController();
  server = createServer((req, res) => {
    const range = req.headers.range ?? 'full'; requests.push(range);
    const match = /bytes=(\d+)-(\d+)/.exec(range)!; const start = Number(match[1]); const end = Number(match[2]);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, ETag: '"same"' });
    if (range === 'bytes=0-0') res.end(data.subarray(0, 1)); else { res.write(data.subarray(start, start + 1024)); if (requests.length === 5) setTimeout(() => abort.abort(), 10); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const file = await open(join(directory, 'audio'), 'wx');
  try { await expect(downloadAudio({ url: base, trustedOrigin: base, source: 'direct' }, file, data.length + 1, 4, abort.signal)).rejects.toThrow(); expect(requests).toHaveLength(5); expect(requests).not.toContain('full'); }
  finally { await file.close(); }
});
