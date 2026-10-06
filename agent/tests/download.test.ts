import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { downloadCachedAudio } from '../src/download';
it.each([true, false])('Agent 分段下载、旧后端回退，合并后字节完全一致（Range=%s）', async supportsRange => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-agent-range-')); const data = Buffer.alloc(3 * 1024 * 1024 + 91); for (let n = 0; n < data.length; n++) data[n] = n % 241;
  let count = 0; const token = 'test-token';
  const server = createServer((req, res) => { count++; expect(req.headers.authorization).toBe(`Bearer ${token}`); const range = req.headers.range; if (range && supportsRange) { const match = /bytes=(\d+)-(\d+)/.exec(range)!; const start = Number(match[1]); const end = Number(match[2]); res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}` }); res.end(data.subarray(start, end + 1)); } else res.end(data); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const file = await open(join(directory, 'audio'), 'wx');
  try { await downloadCachedAudio(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), token, file, data.length, new AbortController().signal, () => {}); await file.close(); expect((await readFile(join(directory, 'audio'))).equals(data)).toBe(true); expect(count).toBe(supportsRange ? 4 : 5); }
  finally { await file.close().catch(() => {}); await new Promise<void>(ok => server.close(() => ok())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-agent-range-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
});
it('取消下载会终止全部分段，且不回退重新下载', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-agent-range-')); const total = 3 * 1024 * 1024; const abort = new AbortController(); let count = 0;
  const server = createServer((req, res) => { count++; const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range!)!; res.writeHead(206, { 'Content-Range': `bytes ${match[1]}-${match[2]}/${total}` }); res.write(Buffer.alloc(1024)); if (count === 4) setTimeout(() => abort.abort(), 10); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const file = await open(join(directory, 'audio'), 'wx');
  try { await expect(downloadCachedAudio(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), 'test-token', file, total, abort.signal, () => {})).rejects.toThrow(); expect(count).toBe(4); }
  finally { await file.close(); await new Promise<void>(ok => server.close(() => ok())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-agent-range-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
});
