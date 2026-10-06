import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MediaAsset } from '../src/contracts';
import { MysqlStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { QueueService } from '../src/queues/queue';
import { ModerationService } from '../src/policies/moderation';
import { MediaService } from '../src/media/cache';
import { MusicService } from '../src/music/providers';
import { PlaybackService } from '../src/playback/playback';

// Validate the adapter's actual create/update arguments against the generated
// Prisma model, without requiring or mutating an external database.
function sqlFixture() {
  const client: Record<string, unknown> = { $queryRaw: vi.fn(async () => []) };
  const maps = new Map<string, Map<string, any>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const rows = new Map<string, any>(); maps.set(model.name, rows);
    const fields = new Set(model.fields.map(field => field.name));
    const validate = (data: Record<string, unknown>) => { for (const key of Object.keys(data)) if (!fields.has(key)) throw new Error(`Unknown argument ${key} on ${model.name}`); };
    client[model.name[0]!.toLowerCase() + model.name.slice(1)] = {
      findMany: async () => structuredClone([...rows.values()]),
      findUnique: async ({ where }: any) => structuredClone(rows.get(where.id) ?? null),
      upsert: async ({ where, create, update }: any) => {
        validate(create); validate(update);
        const data = rows.has(where.id) ? { ...rows.get(where.id), ...update } : { ...create };
        if (data.source === Prisma.DbNull) data.source = null;
        rows.set(where.id, structuredClone(data)); return structuredClone(data);
      },
      deleteMany: async ({ where }: any) => { rows.delete(where.id); },
    };
  }
  const db = { $connect: vi.fn(), $disconnect: vi.fn(), systemLock: client.systemLock, $transaction: async (fn: (tx: any) => unknown) => fn(client) } as unknown as PrismaClient;
  return { store: new MysqlStore(db), maps };
}

const asset: MediaAsset = { id: 'media_test', trackKey: 'a'.repeat(64), filename: `${'a'.repeat(64)}.audio`, mime: 'audio/mpeg', bytes: 4254032, sha256: 'b'.repeat(64), durationSeconds: 265.85, createdAt: '2026-10-05T14:39:53.849Z', lastAccessedAt: '2026-10-05T14:39:53.849Z', source: { engine: 'direct', match: 'original', platform: 'netease', externalId: '406173' } };

describe('MySQL 音频缓存字段与派发回归', () => {
  it('生成的 MediaAsset 模型包含可空的 source JSON 字段', () => {
    expect(Prisma.dmmf.datamodel.models.find(model => model.name === 'MediaAsset')?.fields.find(field => field.name === 'source')).toMatchObject({ type: 'Json', isRequired: false });
  });
  it('真实 SQL 适配器创建、更新、读取时保留取源身份', async () => {
    const { store, maps } = sqlFixture(); await store.init();
    await store.transaction(tx => tx.put('mediaAsset', asset));
    expect(maps.get('MediaAsset')?.get(asset.id).source).toEqual(asset.source);
    const next = { ...asset, lastAccessedAt: '2026-10-05T14:40:00.000Z', source: { ...asset.source!, engine: 'meting' as const } };
    await store.transaction(tx => tx.put('mediaAsset', next));
    expect(await store.transaction(tx => tx.get('mediaAsset', asset.id))).toEqual(next);
    expect(await store.transaction(tx => tx.all('mediaAsset'))).toEqual([next]); await store.close();
  });
  it('旧记录的 SQL NULL 兼容可选 source，更新时也能清除旧取源信息', async () => {
    const { store, maps } = sqlFixture(); const { source, ...legacy } = asset;
    await store.transaction(tx => tx.put('mediaAsset', asset)); await store.transaction(tx => tx.put('mediaAsset', legacy));
    expect(maps.get('MediaAsset')?.get(asset.id).source).toBeNull();
    expect(await store.transaction(tx => tx.get('mediaAsset', asset.id))).toEqual(legacy);
    expect(await store.transaction(tx => tx.all('mediaAsset'))).toEqual([legacy]); await store.close();
  });
  it('实际下载和音频校验经过 SQL 适配器后，生成 Agent start 指令', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fenghuangming-mysql-playback-'));
    const wave = Buffer.alloc(44 + 8000 * 6 * 2); wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'audio/wav'); res.end(wave); });
    const { store } = sqlFixture();
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await store.init(); const events = new Events(); const system = new SystemService(store, events); await system.init();
      const backup = { name: 'gomusicdl' as const, resolve: vi.fn() };
      const media = new MediaService(store, new MusicService([backup], { original: async function* () { yield { source: 'direct', match: 'original', url: base + '/audio', trustedOrigin: base }; }, canonical: async track => track }), join(directory, 'media'), 'test');
      const queue = new QueueService(store, events, new ModerationService()); const playback = new PlaybackService(store, events, media, () => true);
      const { agent } = await system.registerAgent({ zoneId: 'zone_default', name: '本机' });
      await store.transaction(tx => tx.put('agent', { ...agent, ready: true, epoch: 1 }));
      const item = await queue.enqueue({ zoneId: 'zone_default', userId: 'test', requestKey: 'mysql-download', track: { platform: 'netease', externalId: '406173', title: 'Flower Dance', artists: ['DJ OKAWARI'], durationSeconds: 6 } });
      await playback.tick();
      const snapshot = await system.snapshot(); expect(snapshot.queue.find(row => row.id === item.id)).toMatchObject({ status: 'dispatching', error: null });
      const commands = await store.transaction(tx => tx.all('command')); expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ itemId: item.id, agentId: agent.id, payload: { action: 'start', bytes: wave.length } });
      expect((await store.transaction(tx => tx.all('mediaAsset')))[0]?.source).toEqual({ engine: 'direct', match: 'original', platform: 'netease', externalId: '406173' });
      expect(backup.resolve).not.toHaveBeenCalled();
    } finally {
      await store.close(); await new Promise<void>(done => server.close(() => done()));
      if (!resolve(directory).startsWith(resolve(tmpdir(), 'fenghuangming-mysql-playback-'))) throw new Error('Unexpected path'); await rm(directory, { recursive: true, force: true });
    }
  });
});
