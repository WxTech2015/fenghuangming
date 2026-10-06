import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../src/app';
import { FileStore } from '../src/core/store';
import { MusicService } from '../src/music/providers';
import { DiagnosticLogger, traceFor } from '../src/core/diagnostics';

function wave() {
  const buffer = Buffer.alloc(44 + 16000 * 6 * 2); buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40); return buffer;
}
describe('管理员诊断接口', () => {
  let backend: Awaited<ReturnType<typeof createApplication>>; let directory = ''; let base = ''; let cookie = ''; let audioBase = ''; let failAll = false;
  const audio = createServer((request, response) => {
    if (request.url === '/error' || failAll) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 'UPSTREAM_DENIED', message: 'platform returned 403: vkey=private-signature' })); }
    else { response.setHeader('Content-Type', 'audio/wav'); response.end(wave()); }
  });
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fenghuangming-debug-api-')); audio.listen(0, '127.0.0.1'); await once(audio, 'listening'); audioBase = `http://127.0.0.1:${(audio.address() as AddressInfo).port}`;
    const music = new MusicService([
      { name: 'gomusicdl', resolve: async () => ({ source: 'gomusicdl', url: audioBase + '/error', trustedOrigin: audioBase }) },
      { name: 'meting', resolve: async () => ({ source: 'meting', url: audioBase + '/audio', trustedOrigin: audioBase }) },
    ], { original: async function* () { throw Object.assign(new Error('platform DNS failed'), { code: 'ENOTFOUND' }); }, canonical: async track => track });
    backend = await createApplication({ store: await new FileStore().init(), dataDir: directory, auth: { username: 'admin', password: 'test-password', secret: 's'.repeat(40), secure: false }, botToken: 'test-token', music, logger: false, metadata: null, diagnostics: new DiagnosticLogger({ mode: 'debug', console: false, directory: join(directory, 'logs') }) });
    await backend.context.system.saveSettings({ fallbackEngines: ['meting'] }); await backend.app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${(backend.app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => { await backend?.close(); await new Promise<void>(done => audio.close(() => done())); if (!resolve(directory).startsWith(resolve(tmpdir(), 'fenghuangming-debug-api-'))) throw new Error('Unexpected path'); await rm(directory, { recursive: true, force: true }); });
  it('匿名用户不能读日志、导出或执行解析；错误回复携带追踪 ID', async () => {
    for (const path of ['/diagnostics/logs', '/diagnostics/export']) expect((await fetch(base + path)).status).toBe(401);
    const denied = await post('/diagnostics/resolve', { shareUrl: 'https://music.163.com/song?id=1' }); expect(denied.status).toBe(401); expect((await denied.json()).traceId).toBeTruthy();
    const login = await post('/login', { username: 'admin', password: 'test-password' }); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  it('不需要 Agent，真实测试下载和校验；所有回退和底层错误共享同一 ID', async () => {
    const response = await post('/diagnostics/resolve', { shareUrl: 'https://music.163.com/song?id=1' }); const result = await response.json();
    expect(result).toMatchObject({ ok: true, durationSeconds: 6, source: { engine: 'meting' } });
    const logs = await (await fetch(base + `/diagnostics/logs?traceId=${result.traceId}`, { headers: { Cookie: cookie } })).json();
    const events = logs.entries.map((entry: any) => entry.event); expect(events).toContain('music.original.failed'); expect(events).toContain('media.response.not_audio'); expect(events).toContain('media.validation.ok'); expect(events).toContain('diagnostic.resolve.ok');
    expect(logs.entries.every((entry: any) => entry.traceId === result.traceId)).toBe(true); expect(JSON.stringify(logs)).toContain('ENOTFOUND'); expect(JSON.stringify(logs)).not.toContain('private-signature');
    const snapshot = await backend.context.system.snapshot(); expect(snapshot.queue).toHaveLength(0); expect(snapshot.agents).toHaveLength(0);
  });
  it('取源全部失败时返回具体原因和追踪 ID，不把 JSON 错误响应误认作音频', async () => {
    failAll = true; const result = await (await post('/diagnostics/resolve', { shareUrl: 'https://music.163.com/song?id=2' })).json();
    expect(result).toMatchObject({ ok: false, code: 'AUDIO_SOURCES_FAILED' }); expect(result.message).toContain('403'); expect(result.message).not.toContain('private-signature');
    const logs = await (await fetch(base + `/diagnostics/logs?traceId=${result.traceId}&level=warn`, { headers: { Cookie: cookie } })).json(); expect(logs.entries.length).toBeGreaterThan(0); expect(logs.entries.every((entry: any) => entry.level === 'warn')).toBe(true);
    failAll = false;
  });
  it('已入队歌曲可按稳定 ID 查看日志，导出只返回脱敏 JSONL', async () => {
    const item = await (await post('/queue', { zoneId: 'zone_default', userId: 'test', track: { platform: 'netease', externalId: '3', title: '测试' }, requestKey: 'test-debug-item' })).json();
    const logs = await (await fetch(base + `/diagnostics/queue/${item.id}`, { headers: { Cookie: cookie } })).json(); expect(logs.traceId).toBe(traceFor('test-debug-item')); expect(logs.entries.some((entry: any) => entry.event === 'queue.enqueued')).toBe(true);
    const exported = await fetch(base + '/diagnostics/export', { headers: { Cookie: cookie } }); expect(exported.headers.get('content-disposition')).toContain('fenghuangming-debug.jsonl'); const text = await exported.text(); expect(text).not.toContain('private-signature'); expect(text).not.toContain('test-password'); expect(text.trim().split('\n').every(line => JSON.parse(line).event)).toBe(true);
  });
});
it('生产环境不显示追踪头或追踪 ID，仍能按歌曲读取日志', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fenghuangming-production-api-'));
  const app = await createApplication({ store: await new FileStore().init(), dataDir: directory, auth: { username: 'admin', password: 'test-password', secret: 's'.repeat(40), secure: false }, botToken: '', music: new MusicService([]), logger: false, metadata: null, diagnostics: new DiagnosticLogger({ mode: 'production', console: false, directory: join(directory, 'logs') }) });
  try {
    await app.app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${(app.app.getHttpServer().address() as AddressInfo).port}/api/v1`;
    const denied = await fetch(base + '/diagnostics/logs'); expect(denied.status).toBe(401); expect(denied.headers.has('x-trace-id')).toBe(false); expect(await denied.json()).not.toHaveProperty('traceId');
    const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const item = await (await fetch(base + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ zoneId: 'zone_default', userId: 'test', track: { platform: 'netease', externalId: '3', title: '测试' }, requestKey: 'production-item' }) })).json();
    const logs = await (await fetch(base + `/diagnostics/queue/${item.id}`, { headers: { Cookie: cookie } })).json(); expect(logs).toMatchObject({ mode: 'production', traceEnabled: false, includeStack: false }); expect(logs).not.toHaveProperty('traceId'); expect(logs.entries.some((entry: any) => entry.event === 'queue.enqueued')).toBe(true);
    expect(logs.entries.every((entry: any) => entry.traceId === null && entry.fields.itemId === item.id)).toBe(true);
    const filtered = await (await fetch(base + `/diagnostics/logs?itemId=${item.id}`, { headers: { Cookie: cookie } })).json(); expect(filtered.entries).toEqual(logs.entries);
  } finally { await app.close(); if (!resolve(directory).startsWith(resolve(tmpdir(), 'fenghuangming-production-api-'))) throw new Error('Unexpected path'); await rm(directory, { recursive: true, force: true }); }
});
