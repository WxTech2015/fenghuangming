import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import type { MediaAsset, TableName, Tables } from '../contracts';

export const TABLES: TableName[] = ['setting', 'zone', 'binding', 'agent', 'queueItem', 'blacklist', 'quota', 'quotaEvent', 'playlist', 'command', 'mediaAsset', 'audit'];
export interface UnitOfWork {
  all<K extends TableName>(table: K): Promise<Tables[K][]>;
  get<K extends TableName>(table: K, id: string): Promise<Tables[K] | null>;
  put<K extends TableName>(table: K, value: Tables[K]): Promise<void>;
  remove(table: TableName, id: string): Promise<void>;
}
export abstract class Store {
  abstract readonly driver: string;
  abstract transaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T>;
  async close() {}
}
type Data = Record<TableName, Record<string, unknown>>;
const emptyData = () => Object.fromEntries(TABLES.map(t => [t, {}])) as Data;

export class FileStore extends Store {
  readonly driver = 'file';
  private data = emptyData();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly filename?: string) { super(); }
  async init() {
    if (this.filename) {
      try { this.data = { ...emptyData(), ...JSON.parse(await readFile(this.filename, 'utf8')) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this;
  }
  transaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      const draft = structuredClone(this.data);
      const tx: UnitOfWork = {
        all: async table => structuredClone(Object.values(draft[table])) as never,
        get: async (table, id) => structuredClone(Object.hasOwn(draft[table], id) ? draft[table][id] : null) as never,
        put: async (table, value) => { Object.defineProperty(draft[table], value.id, { value: structuredClone(value), enumerable: true, configurable: true, writable: true }); },
        remove: async (table, id) => { delete draft[table][id]; },
      };
      const result = await fn(tx);
      if (this.filename && JSON.stringify(draft) !== JSON.stringify(this.data)) {
        await mkdir(dirname(this.filename), { recursive: true });
        await writeFile(this.filename + '.tmp', JSON.stringify(draft), { mode: 0o600 });
        await rename(this.filename + '.tmp', this.filename);
      }
      this.data = draft;
      return result;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

// Explicit model map keeps SQL storage separate from domain rules. The short
// global row lock serializes this first release's administrative transactions.
// No network or audio download takes place while holding this lock.
const models: Record<TableName, string> = { setting: 'setting', zone: 'zone', binding: 'groupBinding', agent: 'agent', queueItem: 'queueItem', blacklist: 'blacklist', quota: 'quota', quotaEvent: 'quotaEvent', playlist: 'playlist', command: 'command', mediaAsset: 'mediaAsset', audit: 'audit' };
export class MysqlStore extends Store {
  readonly driver = 'mysql';
  constructor(private readonly db = new PrismaClient()) { super(); }
  async init() { await this.db.$connect(); await this.db.systemLock.upsert({ where: { id: 'transactions' }, create: { id: 'transactions' }, update: {} }); return this; }
  async transaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.db.$transaction(async client => {
      await client.$queryRaw`SELECT id FROM SystemLock WHERE id = 'transactions' FOR UPDATE`;
      // Prisma's heterogeneous delegates have incompatible overloads; this
      // adapter is the sole boundary where their common CRUD shape is used.
      const model = (table: TableName) => (client as unknown as Record<string, { findMany(): Promise<unknown[]>; findUnique(args: unknown): Promise<unknown>; upsert(args: unknown): Promise<unknown>; deleteMany(args: unknown): Promise<unknown> }>)[models[table]]!;
      const fromRow = (table: TableName, row: unknown) => {
        if (table !== 'mediaAsset' || !row) return row;
        const { source, ...rest } = row as MediaAsset & { source: MediaAsset['source'] | null };
        return source == null ? rest : { ...rest, source };
      };
      return fn({
        all: async table => (await model(table).findMany()).map(row => fromRow(table, row)) as never,
        get: async (table, id) => fromRow(table, await model(table).findUnique({ where: { id } })) as never,
        put: async (table, value) => {
          if (table === 'mediaAsset') {
            const { source, ...asset } = value as MediaAsset;
            // Use the generated model type here: a domain-only field must not
            // silently pass through the heterogeneous delegate boundary.
            const create: Prisma.MediaAssetUncheckedCreateInput = { ...asset, source: source ? { ...source } : Prisma.DbNull };
            const { id, ...update } = create;
            await client.mediaAsset.upsert({ where: { id }, create, update });
            return;
          }
          const { id, ...rest } = value; await model(table).upsert({ where: { id }, create: value, update: rest });
        },
        remove: async (table, id) => { await model(table).deleteMany({ where: { id } }); },
      });
    }, { maxWait: 10000, timeout: 10000 });
  }
  override async close() { await this.db.$disconnect(); }
}
