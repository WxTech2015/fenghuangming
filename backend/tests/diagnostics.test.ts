import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { captureOutput, DiagnosticLogger, diagnostics, traceFor } from '../src/core/diagnostics';
import { AdapterRuntime } from '../src/music/adapter-runtime';

async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'fenghuangming-logs-'));
  try { await work(directory); } finally { if (!resolve(directory).startsWith(resolve(tmpdir(), 'fenghuangming-logs-'))) throw new Error('Unexpected path'); await rm(directory, { recursive: true, force: true }); }
}
describe('诊断日志', () => {
  it('生产模式不输出 debug、嵌套堆栈和追踪；关闭追踪仍可按歌曲查日志', async () => {
    const logger = new DiagnosticLogger({ mode: 'production', console: false });
    logger.run({ traceId: 'hidden-trace', requestTraceId: 'hidden-request-trace', itemId: 'song-one' }, () => {
      logger.write('debug', 'hidden', 'debug');
      logger.write('error', 'visible', 'error', { error: new Error('failed', { cause: new Error('cause') }), output: JSON.stringify({ stack: 'hidden-stack', traceId: 'hidden-nested-trace', reason: 'failed' }) });
    });
    const result = logger.query({ itemId: 'song-one' }); const text = JSON.stringify(result);
    expect(result.entries).toHaveLength(1); expect(result.entries[0]!.traceId).toBeNull(); expect(result).toMatchObject({ mode: 'production', level: 'info', traceEnabled: false, includeStack: false });
    expect(text).not.toContain('hidden-trace'); expect(text).not.toContain('hidden-request-trace'); expect(text).not.toContain('hidden-nested-trace'); expect(text).not.toContain('hidden-stack'); expect(text).not.toContain('"stack"'); expect(text).toContain('cause'); await logger.close();
  });
  it('生产模式读取已有调试日志时过滤级别、追踪和堆栈', async () => temporary(async directory => {
    const debug = new DiagnosticLogger({ mode: 'debug', directory, console: false }); await debug.init();
    debug.write('debug', 'debug.old', 'old'); debug.write('error', 'error.old', 'old', { traceId: 'old-trace', error: new Error('old error') }); await debug.close();
    const production = new DiagnosticLogger({ mode: 'production', directory, console: false }); await production.init();
    const result = production.query(); expect(result.entries.map(entry => entry.event)).toEqual(['error.old']); expect(JSON.stringify(result)).not.toContain('old-trace'); expect(JSON.stringify(result)).not.toContain('"stack"'); await production.close();
  }));
  it('记录错误堆栈、底层原因和稳定追踪 ID，异步并发不会串线', async () => {
    const logger = new DiagnosticLogger({ mode: 'debug', console: false });
    await Promise.all(['one', 'two'].map((requestKey, index) => logger.run({ traceId: traceFor(requestKey) }, async () => {
      await new Promise(ok => setTimeout(ok, index ? 5 : 15)); diagnostics.warn('network.failed', '网络失败', { error: new Error('fetch failed', { cause: Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }) }) });
    })));
    for (const key of ['one', 'two']) { const entry = logger.query({ traceId: traceFor(key) }).entries[0]!; expect(entry.fields.error).toMatchObject({ message: 'fetch failed', cause: { code: 'ENOTFOUND', message: 'DNS lookup failed' } }); expect((entry.fields.error as any).stack).toContain('Error: fetch failed'); }
    await expect(logger.run({ traceId: 'failure-trace' }, async () => { throw new Error('bad'); })).rejects.toMatchObject({ diagnosticTraceId: 'failure-trace' }); await logger.close();
    const frozen = Object.freeze(new Error('original frozen error')); await expect(logger.run({ traceId: 'frozen-trace' }, async () => { throw frozen; })).rejects.toBe(frozen);
  });
  it('结构化字段、URL、JSON 文本和底层错误里的凭证全部脱敏', async () => {
    const logger = new DiagnosticLogger({ mode: 'debug', console: false, secrets: ['the-private-cookie-value', 'database-password-value'] });
    logger.write('error', 'security.check', '检查错误', {
      headers: { Authorization: 'Bearer secret-bearer-value', Cookie: 'MUSIC_U=the-private-cookie-value', 'x-http-token': 'secret-token-value' },
      url: 'https://name:password@example.com/audio?id=123&vkey=secret-vkey&ticket=secret-ticket',
      output: '{"Cookie":"cookie-secret","token":"token-secret"}',
      error: new Error('database-password-value https://example.com/path?token=secret-in-stack', { cause: new Error('Bearer secret-in-cause') }),
      lyrics: '歌词正文不写入日志',
      prompt: '审核提示词不写入日志',
      libraryOutput: "{'lyric': '上游歌词正文', 'prompt': '上游提示词'}",
    });
    const text = JSON.stringify(logger.query());
    for (const secret of ['secret-bearer-value', 'the-private-cookie-value', 'database-password-value', 'secret-token-value', 'secret-vkey', 'secret-ticket', 'cookie-secret', 'token-secret', 'secret-in-stack', 'secret-in-cause', '歌词正文不写入日志', '审核提示词不写入日志', '上游歌词正文', '上游提示词']) expect(text).not.toContain(secret);
    expect(text).toContain('id=123'); expect(text).toContain('REDACTED'); await logger.close();
  });
  it('进程输出按完整行脱敏，凭证跨数据块也不会泄漏', async () => {
    const logger = new DiagnosticLogger({ mode: 'debug', console: false }); const stream = new PassThrough();
    logger.run({ traceId: 'process-trace' }, () => captureOutput(stream, 'worker.output', '音源输出', {}));
    stream.write('Authorization: Bearer secret-'); stream.write('across-chunks\n'); stream.end('normal output\n'); await new Promise(done => stream.once('end', done));
    const text = JSON.stringify(logger.query()); expect(text).not.toContain('across-chunks'); expect(text).not.toContain('secret-'); expect(text).toContain('normal output'); expect(logger.query().entries.every(entry => entry.traceId === 'process-trace')).toBe(true); await logger.close();
  });
  it('滚动日志有大小和数量上限，重启仍能读取最近记录', async () => temporary(async directory => {
    const logger = new DiagnosticLogger({ mode: 'debug', directory, console: false, maxBytes: 800, maxFiles: 2, maxEntries: 3 }); await logger.init();
    for (let i = 0; i < 12; i++) logger.write('info', 'rotate.check', `record ${i}`);
    await logger.close(); const files = await readdir(directory); expect(files.length).toBeLessThanOrEqual(3); expect(logger.query().buffered).toBe(3);
    const restarted = new DiagnosticLogger({ mode: 'debug', directory, console: false, maxBytes: 800 }); await restarted.init(); expect(restarted.query().entries[0]!.message).toBe('record 11'); await restarted.close();
  }));
  it('日志级别过滤不会改变业务，文件不可写时明确报告但不抛出', async () => temporary(async directory => {
    const logger = new DiagnosticLogger({ mode: 'debug', directory: join(directory, 'invalid'), console: false, level: 'warn' });
    const { writeFile } = await import('node:fs/promises'); await writeFile(join(directory, 'invalid'), 'not a directory'); await logger.init();
    logger.write('debug', 'hidden', 'debug'); logger.write('warn', 'visible', 'warning'); await logger.flush();
    expect(logger.query().entries.map(entry => entry.event)).toEqual(['visible']); expect(logger.query().diskError).toBeTruthy(); await logger.close();
  }));
  it('写入文件的内容与管理接口一致，不能出现原始 URL 凭证', async () => temporary(async directory => {
    const logger = new DiagnosticLogger({ mode: 'debug', directory, console: false }); await logger.init(); logger.write('warn', 'platform.failed', '平台失败', { url: 'https://example.com/song?id=4&vkey=signed-credential' }); await logger.close();
    const text = await readFile(join(directory, 'backend.jsonl'), 'utf8'); expect(text).not.toContain('signed-credential'); expect(JSON.parse(text).event).toBe('platform.failed');
  }));
  it('真实 Node Worker 的原始错误与原因经过 RPC 保留，并关联到调用的追踪 ID', async () => temporary(async directory => {
    const { writeFile } = await import('node:fs/promises'); const workerPath = join(directory, 'worker.cjs');
    await writeFile(workerPath, "const {parentPort}=require('node:worker_threads');parentPort.postMessage({type:'ready'});parentPort.on('message',({id})=>parentPort.postMessage({type:'result',id,error:{name:'Error',message:'Meting returned HTTP 503',code:'UPSTREAM_503',stack:'upstream stack',cause:{message:'connect reset',code:'ECONNRESET'}}}));");
    const logger = new DiagnosticLogger({ mode: 'debug', console: false }); const runtime = new AdapterRuntime({ engine: 'meting', dataDir: directory, changed: () => {}, workerPath });
    try {
      await expect(logger.run({ traceId: 'worker-request' }, () => runtime.call('resolve', { platform: 'netease', externalId: '1', title: 'test', artists: [], album: '', coverUrl: '', shareUrl: '', lyrics: '', durationSeconds: 0 }))).rejects.toThrow('HTTP 503');
      const entry = logger.query({ traceId: 'worker-request' }).entries.find(entry => entry.event === 'music.rpc.failed')!;
      expect(entry.fields.error).toMatchObject({ cause: { code: 'UPSTREAM_503', stack: 'upstream stack', cause: { code: 'ECONNRESET' } } });
    } finally { await runtime.close(); await logger.close(); }
  }));
});
