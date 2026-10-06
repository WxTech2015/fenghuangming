import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { DiagnosticEntry, LogLevel } from '../contracts';
import { runtimeConfig, type AppMode } from './config';

const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitive = /password|passwd|secret|token|cookie|authorization|api[-_]?key|ticket|vkey|signature|session|lyric|prompt|messages|^body$|^payload$|^raw$/i;
const safeQuery = new Set(['id', 'songid', 'songmid', 'source', 'stream', 'format', 'platform']);
type Fields = Record<string, unknown>;
const context = new AsyncLocalStorage<{ logger: DiagnosticLogger; fields: Fields }>();
export const traceFor = (requestKey: string) => `music_${createHash('sha256').update(requestKey).digest('hex').slice(0, 20)}`;
export const requestTrace = () => `req_${randomUUID()}`;
export function diagnosticTrace(error?: unknown) { return (error as { diagnosticTraceId?: string } | null)?.diagnosticTraceId ?? context.getStore()?.fields.traceId as string | undefined; }

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw); if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return raw;
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (!safeQuery.has(key.toLowerCase())) url.searchParams.set(key, '[REDACTED]');
    return url.href;
  } catch { return raw; }
}
export function redact(value: unknown, secrets: readonly string[] = [], depth = 0, seen = new WeakSet<object>()): any {
  if (depth > 7) return '[TRUNCATED]';
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value) && value.length < 16000) { try { return JSON.stringify(redact(JSON.parse(value), secrets, depth + 1, seen)); } catch { /* ordinary output */ } }
    let text = value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => redactUrl(raw));
    text = text.replace(/((?:lyrics?|prompt|messages)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*?\2/gi, '$1"[REDACTED]"');
    text = text.replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]').replace(/((?:password|passwd|secret|token|cookie|authorization|api[-_]?key|ticket|vkey|signature|MUSIC_U|MUSIC_A|skey)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi, '$1[REDACTED]');
    for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
    return text.slice(0, 8000);
  }
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  if (seen.has(value)) return '[CIRCULAR]'; seen.add(value);
  if (value instanceof Error) return redact({ name: value.name, message: value.message, code: (value as NodeJS.ErrnoException).code, stack: value.stack, cause: value.cause, ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 5) } : {}) }, secrets, depth + 1, seen);
  if (Array.isArray(value)) return value.slice(0, 40).map(item => redact(item, secrets, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item, secrets, depth + 1, seen)]));
}
export interface DiagnosticsOptions { directory?: string; mode?: AppMode; level?: LogLevel; traceEnabled?: boolean; console?: boolean; maxBytes?: number; maxFiles?: number; maxEntries?: number; secrets?: string[] }
export class DiagnosticLogger {
  readonly directory?: string;
  readonly level: LogLevel;
  readonly mode: AppMode;
  readonly traceEnabled: boolean;
  readonly includeStack: boolean;
  private readonly entries: DiagnosticEntry[] = [];
  private readonly secrets: string[];
  private tail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private diskError = '';
  private closed = false;
  private initialized = false;
  constructor(private readonly options: DiagnosticsOptions = {}) {
    this.directory = options.directory ? resolve(options.directory) : undefined;
    const settings = runtimeConfig({ ...process.env, ...(options.mode ? { APP_MODE: options.mode } : {}), ...(options.level ? { LOG_LEVEL: options.level } : {}) });
    this.mode = settings.mode; this.level = settings.logLevel; this.traceEnabled = options.traceEnabled ?? settings.traceEnabled; this.includeStack = settings.includeStack;
    this.secrets = [...new Set([...(options.secrets ?? []), ...Object.entries(process.env).filter(([key]) => sensitive.test(key) || key === 'DATABASE_URL').map(([, value]) => value ?? '')])].filter(value => value.length >= 4);
    for (const [key, value] of Object.entries(process.env)) if (/COOKIE/.test(key)) for (const pair of (value ?? '').split(';')) { const at = pair.indexOf('='); if (at >= 0 && pair.slice(at + 1).trim().length >= 4) this.secrets.push(pair.slice(at + 1).trim()); }
  }
  safe<T>(value: T): T { return redact(value, this.secrets); }
  traceFields(traceId: string | undefined) { return this.traceEnabled && traceId ? { traceId } : {}; }
  // 展示和写盘使用同一份内容，切回生产模式后旧日志也按当前配置过滤。
  private logFields(value: unknown): any {
    if (typeof value === 'string' && /^\s*[\[{]/.test(value)) { try { return JSON.stringify(this.logFields(JSON.parse(value))); } catch { /* ordinary output */ } }
    if (Array.isArray(value)) return value.map(item => this.logFields(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => (this.includeStack || key !== 'stack') && (this.traceEnabled || !['traceId', 'diagnosticTraceId', 'requestTraceId'].includes(key))).map(([key, item]) => [key, this.logFields(item)]));
    return value;
  }
  summary(error: unknown): string {
    const e = error as { message?: string; code?: string; cause?: { message?: string; code?: string } };
    const text = e?.message ?? String(error);
    return this.safe([text, e?.code, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' / ')).slice(0, 600);
  }
  async init() {
    if (this.initialized) return; this.initialized = true;
    if (!this.directory) return;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = resolve(this.directory, 'backend.jsonl');
      try {
        const info = await stat(filename); this.bytes = info.size;
        // Read only a bounded tail, even when upgrading from a larger log file.
        if (info.size <= (this.options.maxBytes ?? 10 * 1024 * 1024)) {
          const lines = (await readFile(filename, 'utf8')).trim().split('\n').slice(-(this.options.maxEntries ?? 2000));
          for (const line of lines) { try { const entry = JSON.parse(line); if (entry?.id && entry?.event && levels[entry.level as LogLevel] >= levels[this.level]) { const safe = this.logFields(this.safe(entry)); this.entries.push({ ...safe, traceId: this.traceEnabled ? safe.traceId ?? null : null }); } } catch { /* incomplete final line */ } }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch (error) { this.diskError = this.summary(error); if (this.options.console !== false) console.error(`诊断日志文件不可写：${this.diskError}`); }
  }
  run<T>(fields: Fields, work: () => T): T {
    const old = context.getStore(); const merged = { ...(old?.logger === this ? old.fields : {}), ...fields };
    return context.run({ logger: this, fields: merged }, () => {
      try {
        const result = work();
        if (result && typeof (result as unknown as Promise<unknown>).then === 'function') return Promise.resolve(result).catch(error => { this.annotate(error); throw error; }) as T;
        return result;
      } catch (error) { this.annotate(error); throw error; }
    });
  }
  bind<T extends (...args: any[]) => any>(work: T): T { const fields = context.getStore()?.fields ?? {}; return ((...args: Parameters<T>) => this.run(fields, () => work(...args))) as T; }
  private annotate(error: unknown) { const traceId = this.traceEnabled ? diagnosticTrace(error) : undefined; if (error instanceof Error && traceId) { try { Object.assign(error, { diagnosticTraceId: traceId }); } catch { /* logging must preserve a frozen original error */ } } }
  write(level: LogLevel, event: string, message: string, fields: Fields = {}) {
    if (this.closed || levels[level] < levels[this.level]) return;
    const current = context.getStore(); const all = this.logFields(this.safe({ ...(current?.logger === this ? current.fields : {}), ...fields }));
    const entry: DiagnosticEntry = { id: randomUUID(), at: new Date().toISOString(), level, event, message: this.safe(message), traceId: typeof all.traceId === 'string' ? all.traceId : null, fields: all };
    this.entries.push(entry); if (this.entries.length > (this.options.maxEntries ?? 2000)) this.entries.shift();
    const line = JSON.stringify(entry) + '\n';
    if (this.options.console !== false) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line.trimEnd());
    if (this.directory) this.tail = this.tail.then(async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const filename = resolve(this.directory!, 'backend.jsonl');
      if (this.bytes + Buffer.byteLength(line) > (this.options.maxBytes ?? 10 * 1024 * 1024)) {
        const files = this.options.maxFiles ?? 5; await rm(`${filename}.${files}`, { force: true });
        for (let i = files - 1; i >= 0; i--) { try { await rename(i ? `${filename}.${i}` : filename, `${filename}.${i + 1}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
        this.bytes = 0;
      }
      await appendFile(filename, line, { mode: 0o600 }); this.bytes += Buffer.byteLength(line); this.diskError = '';
    }).catch(error => {
      const reason = this.summary(error); if (this.diskError !== reason && this.options.console !== false) console.error(`诊断日志写入失败：${reason}`); this.diskError = reason;
    });
  }
  query(filter: { level?: LogLevel; traceId?: string; itemId?: string; search?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 200)); const search = filter.search?.toLowerCase();
    const entries = this.entries.filter(entry => (!filter.level || entry.level === filter.level) && (!filter.traceId || entry.traceId === filter.traceId) && (!filter.itemId || entry.fields.itemId === filter.itemId) && (!search || JSON.stringify(entry).toLowerCase().includes(search)));
    return { entries: structuredClone(entries.slice(-limit).reverse()), matched: entries.length, buffered: this.entries.length, mode: this.mode, level: this.level, traceEnabled: this.traceEnabled, includeStack: this.includeStack, directory: this.directory ?? null, diskError: this.diskError || null };
  }
  async flush() { await this.tail; }
  async close() { this.closed = true; await this.flush(); }
}
const fallback = new DiagnosticLogger({ console: false });
let defaultLogger = fallback;
export function useDefaultLogger(logger: DiagnosticLogger) { defaultLogger = logger; }
export const diagnostics = {
  current: () => context.getStore()?.logger ?? defaultLogger,
  scope: <T>(fields: Fields, work: () => T): T => (context.getStore()?.logger ?? defaultLogger).run(fields, work),
  bind: <T extends (...args: any[]) => any>(work: T): T => (context.getStore()?.logger ?? defaultLogger).bind(work),
  debug: (event: string, message: string, fields?: Fields) => (context.getStore()?.logger ?? defaultLogger).write('debug', event, message, fields),
  info: (event: string, message: string, fields?: Fields) => (context.getStore()?.logger ?? defaultLogger).write('info', event, message, fields),
  warn: (event: string, message: string, fields?: Fields) => (context.getStore()?.logger ?? defaultLogger).write('warn', event, message, fields),
  error: (event: string, message: string, fields?: Fields) => (context.getStore()?.logger ?? defaultLogger).write('error', event, message, fields),
  summary: (error: unknown) => (context.getStore()?.logger ?? defaultLogger).summary(error),
};

// Buffer complete lines so credentials split across pipe chunks are redacted
// together. Oversized lines are omitted instead of logging partial secrets.
export function captureOutput(stream: Readable | null | undefined, event: string, message: string, fields: Fields) {
  if (!stream) return;
  const decoder = new StringDecoder('utf8'); let input = ''; let dropping = false;
  const log = diagnostics.current(); const publish = log.bind((line: string) => diagnostics.debug(event, message, { ...fields, output: line }));
  stream.on('data', chunk => {
    input += decoder.write(Buffer.from(chunk)); let newline: number;
    while ((newline = input.search(/[\r\n]/)) >= 0) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      if (!dropping && line.length <= 16000 && line.trim()) publish(line);
      else if (dropping || line.length > 16000) publish('[超长输出已省略]');
      dropping = false;
    }
    if (input.length > 16000) { input = ''; dropping = true; }
  });
  stream.on('end', () => { input += decoder.end(); if (input.trim() && !dropping) publish(input); });
}
