import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../src/app';
import { FileStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { PYPI_MIRRORS } from '../src/contracts';

describe('音源安装管理接口', () => {
  let backend: Awaited<ReturnType<typeof createApplication>>; let directory = ''; let base = ''; let cookie = '';
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qqmusic-install-api-'));
    const store = await new FileStore().init(); const system = new SystemService(store, new Events());
    await system.init(); await system.saveSettings({ fallbackEngines: [] });
    backend = await createApplication({ store, dataDir: directory, auth: { username: 'admin', password: 'test-password', secret: 'i'.repeat(40), secure: false }, botToken: 'test-token', logger: false, metadata: null });
    await backend.context.configureMusic(); await backend.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(backend.app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => {
    await backend?.close();
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-install-api-'))) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  it('首次启动显示未安装，安装需要管理员登录且必须指定有效音源', async () => {
    expect(backend.context.musicRuntime!.status).toMatchObject({ phase: 'uninstalled', installed: false });
    expect((await post('/music/install', { engine: 'gomusicdl' })).status).toBe(401);
    expect((await post('/music/github-mirrors/test', {})).status).toBe(401);
    expect((await post('/music/pypi-mirrors/test', {})).status).toBe(401);
    expect(backend.context.musicManager!.downloads.snapshot().checkedAt).toBeNull();
    const login = await post('/login', { username: 'admin', password: 'test-password' });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await post('/music/install', {})).status).toBe(400);
    expect((await post('/music/install', { engine: 'unm' })).status).toBe(400);
    expect((await post('/music/install', { engine: 'meting' })).status).toBe(400);
    expect((await post('/music/install', { engine: 'gdstudio' })).status).toBe(400);
  });
  it('测速接口可由管理员调用，但不会安装或执行下载器', async () => {
    const tester = vi.spyOn(backend.context.musicManager!.downloads, 'test').mockResolvedValue([]);
    const installer = vi.spyOn(backend.context.musicRuntime!, 'install').mockResolvedValue(undefined);
    try {
      expect((await post('/music/github-mirrors/test', {})).status).toBe(201);
      expect(tester).toHaveBeenCalledTimes(1); expect(installer).not.toHaveBeenCalled();
      const snapshot = await (await fetch(base + '/snapshot', { headers: { Cookie: cookie } })).json();
      expect(snapshot.githubDownload.nodes).toHaveLength(45);
      expect(snapshot.settings.githubDownload.mode).toBe('auto');
    } finally { tester.mockRestore(); installer.mockRestore(); }
  });
  it('PyPI 测速独立于安装，安装进行中不能重复测速', async () => {
    const manager = backend.context.musicManager!;
    const tester = vi.spyOn(manager.pypi, 'test').mockResolvedValue([]);
    const installer = vi.spyOn(manager.adapters.musicdl, 'install').mockResolvedValue(undefined);
    const phase = manager.adapters.musicdl.status.phase;
    try {
      expect(manager.pypi.snapshot().checkedAt).toBeNull();
      expect((await post('/music/pypi-mirrors/test', {})).status).toBe(201);
      expect(tester).toHaveBeenCalledTimes(1); expect(installer).not.toHaveBeenCalled();
      const snapshot = await (await fetch(base + '/snapshot', { headers: { Cookie: cookie } })).json();
      expect(snapshot.pypiDownload.nodes).toHaveLength(PYPI_MIRRORS.length); expect(snapshot.settings.pypiDownload.mode).toBe('auto');
      manager.adapters.musicdl.status.phase = 'installing';
      expect((await post('/music/pypi-mirrors/test', {})).status).toBe(409); expect(tester).toHaveBeenCalledTimes(1);
    } finally { manager.adapters.musicdl.status.phase = phase; tester.mockRestore(); installer.mockRestore(); }
  });
  it('重启和保存设置均不调用安装，独立安装请求才提交安装任务', async () => {
    const installer = vi.spyOn(backend.context.musicRuntime!, 'install').mockResolvedValue(undefined);
    try {
      expect((await post('/music/restart', { engine: 'gomusicdl' })).status).toBe(201);
      await backend.context.system.saveSettings({ audioEngine: 'musicdl', fallbackEngines: ['gomusicdl'] }); await backend.context.configureMusic();
      expect(installer).not.toHaveBeenCalled();
      expect(backend.context.musicManager!.adapters.musicdl.status.phase).toBe('uninstalled');
      const response = await post('/music/install', { engine: 'gomusicdl' });
      expect(response.status).toBe(201); expect(await response.json()).toEqual({ ok: true }); expect(installer).toHaveBeenCalledTimes(1);
    } finally { installer.mockRestore(); }
  });
});
