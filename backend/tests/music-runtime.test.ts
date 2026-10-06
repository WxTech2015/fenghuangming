import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { zipSync } from '../node_modules/fflate';
import { pack } from '../node_modules/tar-stream';
import { downloadRelease, extractBinary, findInstalledRelease, installGoMusicDl, releaseArtifact, sha256, type ReleaseArtifact } from '../src/music/install';
import { GoMusicDlRuntime } from '../src/music/runtime';
import { AdapterRuntime } from '../src/music/adapter-runtime';
import { findInstalledMusicDl } from '../src/music/python-install';
import { MusicManager } from '../src/music/manager';
import { GithubDownloader } from '../src/music/github-download';
import { SettingsSchema, TrackSchema } from '../src/contracts';
import { FileStore } from '../src/core/store';
import { SystemService } from '../src/core/system';
import { Events } from '../src/core/events';
import { QueueService } from '../src/queues/queue';
import { ModerationService } from '../src/policies/moderation';

const config = SettingsSchema.parse({}).gomusicdl;
const testBinary = Buffer.from('test-binary');
const zip = Buffer.from(zipSync({ 'music-dl.exe': testBinary, '../outside': Buffer.from('ignore') }));
const artifact: ReleaseArtifact = { filename: 'test.zip', sha256: sha256(zip), binary: 'music-dl.exe', version: 'test' };
async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'qqmusic-runtime-'));
  try { await work(directory); }
  finally { if (!resolve(directory).startsWith(resolve(tmpdir(), 'qqmusic-runtime-'))) throw new Error('Unexpected test directory'); await rm(directory, { recursive: true, force: true }); }
}
async function waitFor(check: () => boolean) { const deadline = Date.now() + 6000; while (!check()) { if (Date.now() > deadline) throw new Error('等待音源状态超时'); await new Promise(ok => setTimeout(ok, 20)); } }
const stub = "const port=Number(process.argv[process.argv.indexOf('--port')+1]); require('node:http').createServer((req,res)=>{ res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({app:'go-music-dl',status:'ok'})); }).listen(port,'127.0.0.1');";
function launch(_exe: string, args: string[], cwd: string) { return spawn(process.execPath, ['-e', stub, ...args], { cwd, windowsHide: true, stdio: 'ignore' }); }

describe('官方音源自动安装', () => {
  it('按后端操作系统选择固定版本包，拒绝无官方包的平台', () => {
    expect(releaseArtifact('win32', 'x64').filename).toBe('go-music-dl_windows_amd64.zip');
    expect(releaseArtifact('linux', 'arm64').filename).toBe('go-music-dl_linux_arm64.tar.gz');
    expect(releaseArtifact('linux', 'arm', '7').filename).toContain('armv7');
    expect(() => releaseArtifact('win32', 'arm64')).toThrow('连接已有服务');
  });
  it('下载限定官方固定版本，HTTP 或网络失败给出可操作的错误', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const artifact = { ...releaseArtifact('win32', 'x64'), sha256: sha256(zip) };
      const downloads = new GithubDownloader(); downloads.configure({ mode: 'direct', mirror: '' });
      fetcher.mockResolvedValueOnce(new Response(zip));
      expect(await downloadRelease(artifact, new AbortController().signal, downloads)).toEqual(zip);
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://github.com/guohuiyuan/go-music-dl/releases/download/v1.1.1/go-music-dl_windows_amd64.zip');
      fetcher.mockResolvedValueOnce(new Response('error', { status: 503 }));
      await expect(downloadRelease(artifact, new AbortController().signal, downloads)).rejects.toThrow('HTTP 503');
      fetcher.mockRejectedValueOnce(new Error('fetch failed'));
      await expect(downloadRelease(artifact, new AbortController().signal, downloads)).rejects.toThrow('无法连接 GitHub');
    } finally { fetcher.mockRestore(); }
  });
  it('校验包并只提取预期二进制，拒绝错误哈希及路径替代', async () => {
    expect(await extractBinary(zip, artifact)).toEqual(testBinary);
    await expect(extractBinary(zip, { ...artifact, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    const malicious = Buffer.from(zipSync({ '../music-dl.exe': testBinary }));
    await expect(extractBinary(malicious, { ...artifact, sha256: sha256(malicious) })).rejects.toThrow('未找到');
    const tar = pack(); const chunks: Buffer[] = []; const collected = new Promise<Buffer>((ok, fail) => { tar.on('data', chunk => chunks.push(chunk)); tar.on('end', () => ok(Buffer.concat(chunks))); tar.on('error', fail); });
    tar.entry({ name: 'music-dl', type: 'file', mode: 0o755 }, testBinary); tar.entry({ name: '../escape' }, 'ignore'); tar.finalize();
    const compressed = gzipSync(await collected);
    expect(await extractBinary(compressed, { ...artifact, filename: 'test.tar.gz', binary: 'music-dl', sha256: sha256(compressed) })).toEqual(testBinary);
  });
  it('并发安装只下载一次，重启复用已校验文件；损坏后重新安装', async () => temporary(async directory => {
    let downloads = 0;
    const options = { dataDir: directory, signal: new AbortController().signal, artifact, download: async () => { downloads++; await new Promise(ok => setTimeout(ok, 30)); return zip; } };
    const [a, b] = await Promise.all([installGoMusicDl(options), installGoMusicDl(options)]);
    expect(a).toBe(b); expect(downloads).toBe(1); expect(await readFile(a)).toEqual(testBinary);
    await installGoMusicDl(options); expect(downloads).toBe(1);
    await writeFile(a, 'tampered'); await installGoMusicDl(options); expect(downloads).toBe(2); expect(await readFile(a)).toEqual(testBinary);
  }));
});

describe('音源进程生命周期', () => {
  it('并发调用共享一个启动，健康检查后才可使用，切换外部服务关闭本地进程', async () => temporary(async directory => {
    let installs = 0; let child: ChildProcess | undefined;
    const runtime = new GoMusicDlRuntime({ dataDir: directory, changed: () => {}, findInstalled: async () => installs ? process.execPath : null, install: async () => { installs++; return process.execPath; }, launch: (exe, args, cwd) => { child = launch(exe, args, cwd); expect(args).toContain('--desktop'); return child; } });
    try {
      await runtime.configure(config); expect(runtime.status.phase).toBe('uninstalled');
      await Promise.all([runtime.install(), runtime.install()]);
      const [a, b] = await Promise.all([runtime.endpoint(config), runtime.endpoint(config)]);
      expect(a).toBe(b); expect(installs).toBe(1); expect(runtime.status.phase).toBe('ready');
      expect((await fetch(a + '/healthz')).status).toBe(200);
      await runtime.configure({ ...config, mode: 'external', baseUrl: 'http://127.0.0.1:9999/music' });
      expect(runtime.status.phase).toBe('external'); expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      await expect(fetch(a + '/healthz')).rejects.toThrow();
    } finally { await runtime.close(); }
  }));
  it('运行中退出会自动恢复，关闭后不会再拉起', async () => temporary(async directory => {
    const children: ChildProcess[] = [];
    const install = vi.fn(async () => process.execPath);
    const runtime = new GoMusicDlRuntime({ dataDir: directory, changed: () => {}, findInstalled: async () => process.execPath, install, launch: (exe, args, cwd) => { const child = launch(exe, args, cwd); children.push(child); return child; } });
    try {
      await runtime.configure(config); expect(runtime.status.phase).toBe('ready'); children[0]!.kill();
      await waitFor(() => runtime.status.phase === 'failed');
      await runtime.endpoint(config);
      await waitFor(() => children.length === 2 && runtime.status.phase === 'ready');
      expect(install).not.toHaveBeenCalled();
      await runtime.close(); expect(children[1]!.exitCode !== null || children[1]!.signalCode !== null).toBe(true);
      expect(runtime.status.phase).toBe('stopped');
    } finally { await runtime.close(); }
  }));
  it('安装失败显示原因且可重试；安装期间切换模式会取消旧启动', async () => temporary(async directory => {
    let attempts = 0; let installed = false;
    const runtime = new GoMusicDlRuntime({ dataDir: directory, changed: () => {}, launch, findInstalled: async () => installed ? process.execPath : null, install: async ({ signal }) => {
      attempts++; if (attempts === 1) throw new Error('无法连接 GitHub');
      if (attempts === 3) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
      installed = true; return process.execPath;
    } });
    try {
      await runtime.configure(config); expect(runtime.status.phase).toBe('uninstalled'); expect(attempts).toBe(0);
      await runtime.install(); expect(runtime.status.error).toBe('无法连接 GitHub');
      await expect(runtime.endpoint(config)).rejects.toThrow('无法连接 GitHub');
      await runtime.restart(); expect(runtime.status.phase).toBe('uninstalled'); expect(attempts).toBe(1);
      await runtime.install(); expect(runtime.status.phase).toBe('ready');
      const restarting = runtime.install(); await waitFor(() => attempts === 3);
      await runtime.configure({ ...config, mode: 'external' }); await restarting;
      expect(runtime.status.phase).toBe('external'); expect(attempts).toBe(3);
    } finally { await runtime.close(); }
  }));
  it('启动后退出与启动超时均被报告并清理', async () => temporary(async directory => {
    for (const script of ['process.exit(23)', 'setInterval(()=>{},1000)']) {
      let child: ChildProcess | undefined;
      const runtime = new GoMusicDlRuntime({ dataDir: directory, changed: () => {}, findInstalled: async () => process.execPath, startupTimeoutMs: 500, launch: (_exe, _args, cwd) => child = spawn(process.execPath, ['-e', script], { cwd, windowsHide: true, stdio: 'ignore' }) });
      try { await runtime.configure(config); expect(runtime.status.phase).toBe('failed'); expect(runtime.status.error).toMatch(/退出|超时/); expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true); }
      finally { await runtime.close(); }
    }
  }));
});

describe('只有显式安装操作可以下载音源依赖', () => {
  it('安装探测不创建目录；损坏或缺少程序都返回未安装', async () => temporary(async directory => {
    expect(await findInstalledRelease({ dataDir: directory, artifact })).toBeNull();
    expect(await findInstalledMusicDl(directory)).toBeNull(); expect(await readdir(directory)).toEqual([]);
    const executable = await installGoMusicDl({ dataDir: directory, artifact, signal: new AbortController().signal, download: async () => zip });
    expect(await findInstalledRelease({ dataDir: directory, artifact })).toBe(executable);
    await writeFile(executable, 'broken'); expect(await findInstalledRelease({ dataDir: directory, artifact })).toBeNull();
  }));
  it('Go 首次启动、保存配置、重启和点歌都不会调用安装器', async () => temporary(async directory => {
    const install = vi.fn(async () => process.execPath); const launcher = vi.fn(launch);
    const runtime = new GoMusicDlRuntime({ dataDir: directory, changed: () => {}, install, launch: launcher });
    try {
      expect(runtime.status).toMatchObject({ phase: 'uninstalled', installed: false });
      await runtime.configure(config); await runtime.configure(config); await runtime.restart();
      await expect(runtime.endpoint(config)).rejects.toThrow('未安装');
      expect(install).not.toHaveBeenCalled(); expect(launcher).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
    } finally { await runtime.close(); }
  }));
  it('Python 首次启用、保存配置、重启和取源都不会调用安装器', async () => temporary(async directory => {
    const installPython = vi.fn(async () => process.execPath);
    const runtime = new AdapterRuntime({ engine: 'musicdl', dataDir: directory, changed: () => {}, installPython });
    try {
      expect(runtime.status).toMatchObject({ phase: 'uninstalled', installed: false });
      await runtime.configure(false); await runtime.configure(true); await runtime.configure(true); await runtime.restart();
      await expect(runtime.call('resolve', TrackSchema.parse({ platform: 'netease', externalId: '123', title: '测试' }))).rejects.toThrow('未安装');
      expect(installPython).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
    } finally { await runtime.close(); }
  }));
  it('未启用的 Python 可以单独安装，并发点击共享任务，重启只复用本地程序', async () => temporary(async directory => {
    let installed = false;
    const installPython = vi.fn(async () => { await new Promise(ok => setTimeout(ok, 30)); installed = true; return process.execPath; });
    const options = { engine: 'musicdl' as const, dataDir: directory, changed: () => {}, installPython, findInstalledPython: async () => installed ? process.execPath : null };
    const runtime = new AdapterRuntime(options);
    try {
      await runtime.configure(false); await Promise.all([runtime.install(), runtime.install()]);
      expect(installPython).toHaveBeenCalledTimes(1); expect(runtime.status).toMatchObject({ phase: 'stopped', installed: true });
      await runtime.restart(); expect(installPython).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); }
    const restarted = new AdapterRuntime(options);
    try { await restarted.configure(false); expect(restarted.status).toMatchObject({ phase: 'stopped', installed: true }); expect(installPython).toHaveBeenCalledTimes(1); }
    finally { await restarted.close(); }
  }));
  it('安装 Python 期间保存启用状态不会取消安装；完成后按最新设置保持停止', async () => temporary(async directory => {
    let finish!: () => void; let installed = false; let installSignal: AbortSignal | undefined;
    const installPython = vi.fn(async (_directory: string, signal: AbortSignal) => {
      installSignal = signal; await new Promise<void>(done => { finish = done; }); signal.throwIfAborted(); installed = true; return process.execPath;
    });
    const runtime = new AdapterRuntime({ engine: 'musicdl', dataDir: directory, changed: () => {}, installPython, findInstalledPython: async () => installed ? process.execPath : null });
    try {
      await runtime.configure(true); const installation = runtime.install(); await waitFor(() => !!installSignal);
      const saving = runtime.configure(false); expect(installSignal!.aborted).toBe(false); finish();
      await Promise.all([installation, saving]); expect(runtime.status).toMatchObject({ phase: 'stopped', installed: true }); expect(installPython).toHaveBeenCalledTimes(1);
    } finally { finish?.(); await runtime.close(); }
  }));
  it('管理器加载与保存设置只探测安装，内置源可独立使用', async () => temporary(async directory => {
    const manager = new MusicManager(directory, () => {});
    const goInstall = vi.spyOn(manager.go, 'install'); const pythonInstall = vi.spyOn(manager.adapters.musicdl, 'install');
    try {
      const settings = SettingsSchema.parse({ audioEngine: 'gomusicdl', fallbackEngines: ['musicdl'] });
      await manager.configure(settings); await manager.configure(settings);
      expect(manager.go.status).toMatchObject({ phase: 'uninstalled', installed: false });
      expect(manager.adapters.musicdl.status).toMatchObject({ phase: 'uninstalled', installed: false });
      expect(manager.adapters.meting.status).toMatchObject({ phase: 'stopped', installed: true });
      expect(manager.adapters.neteaseapi.status).toMatchObject({ phase: 'stopped', installed: true });
      expect(goInstall).not.toHaveBeenCalled(); expect(pythonInstall).not.toHaveBeenCalled();
    } finally { await manager.close(); }
  }));
});

describe('旧音源设置迁移', () => {
  it('旧 UNM 配置、任务迁移到默认自动服务，移除旧设置字段', async () => {
    const store = await new FileStore().init(); const events = new Events(); const system = new SystemService(store, events); await system.init();
    const queue = new QueueService(store, events, new ModerationService());
    const item = await queue.enqueue({ zoneId: 'zone_default', requestKey: 'old', userId: '123', track: { platform: 'netease', externalId: '123', title: '旧任务' } });
    await store.transaction(async tx => {
      await tx.put('setting', { id: 'settings', value: { ...SettingsSchema.parse({}), audioEngine: 'unm', unm: { sources: ['qq'] }, gomusicdl: { baseUrl: 'http://127.0.0.1:8080/music' } } as never });
      await tx.put('queueItem', { ...item, engine: 'unm' as never });
    });
    await system.init(); const snapshot = await system.snapshot();
    expect(snapshot.settings.gomusicdl.mode).toBe('managed'); expect(snapshot.settings).not.toHaveProperty('unm'); expect(snapshot.queue[0]!.engine).toBe('gomusicdl');
  });
  it('旧版已选择 go-music-dl 的外部地址保持不变', async () => {
    const store = await new FileStore().init(); const system = new SystemService(store, new Events());
    await store.transaction(tx => tx.put('setting', { id: 'settings', value: { ...SettingsSchema.parse({}), gomusicdl: { baseUrl: 'http://192.168.1.8:9000/music' } } as never }));
    await system.init(); expect((await system.snapshot()).settings.gomusicdl).toEqual({ mode: 'external', baseUrl: 'http://192.168.1.8:9000/music' });
  });
});
