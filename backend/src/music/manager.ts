import { TrackSchema, type AudioEngine, type MusicRuntimeStatus, type Settings, type Track } from '../contracts';
import { AppError } from '../core/errors';
import { GoMusicDlRuntime } from './runtime';
import { AdapterRuntime, type LibraryEngine } from './adapter-runtime';
import { GoMusicDlProvider, MusicService, type AudioProvider, type ResolvedSource } from './providers';
import { GithubDownloader } from './github-download';
import { downloadRelease, installGoMusicDl } from './install';
import { installMusicDl } from './python-install';
import { PypiDownloader } from './pypi-download';
import { GDStudioProvider } from './gdstudio';

class LibraryProvider implements AudioProvider {
  constructor(readonly name: LibraryEngine, private readonly runtime: AdapterRuntime) {}
  async resolve(track: Track): Promise<ResolvedSource> {
    const result = await this.runtime.call<ResolvedSource>('resolve', track);
    if (!result || typeof result.url !== 'string') throw new AppError('SOURCE_UNAVAILABLE', '音源未返回音频地址');
    // A local RPC worker never grants private network access to a returned URL.
    return { url: result.url, headers: result.headers, source: this.name };
  }
  async search(track: Track): Promise<Track[]> {
    const result = await this.runtime.call<unknown>('search', track); if (!Array.isArray(result)) return [];
    return result.slice(0, 5).flatMap(value => { const parsed = TrackSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  }
}
export class MusicManager {
  readonly go: GoMusicDlRuntime;
  readonly adapters: Record<LibraryEngine, AdapterRuntime>;
  readonly gdstudio: GDStudioProvider;
  readonly music: MusicService;
  readonly downloads: GithubDownloader;
  readonly pypi: PypiDownloader;
  constructor(dataDir: string, changed: (engine: AudioEngine, status: MusicRuntimeStatus) => void, downloadChanged?: () => void) {
    this.downloads = new GithubDownloader({ changed: () => downloadChanged?.() });
    this.pypi = new PypiDownloader({ changed: () => downloadChanged?.() });
    this.go = new GoMusicDlRuntime({ dataDir, changed: status => changed('gomusicdl', status), install: options => installGoMusicDl({ ...options, download: (artifact, signal) => downloadRelease(artifact, signal, this.downloads) }) });
    this.adapters = Object.fromEntries((['musicdl', 'neteaseapi', 'meting'] as const).map(engine => [engine, new AdapterRuntime({ engine, dataDir, changed: status => changed(engine, status), installPython: (directory, signal) => installMusicDl(directory, signal, this.downloads, this.pypi) })])) as typeof this.adapters;
    this.gdstudio = new GDStudioProvider({ changed: status => changed('gdstudio', status) });
    this.music = new MusicService([new GoMusicDlProvider(config => this.go.endpoint(config)), this.gdstudio, ...Object.entries(this.adapters).map(([name, runtime]) => new LibraryProvider(name as LibraryEngine, runtime))]);
  }
  async configure(settings: Settings) {
    this.downloads.configure(settings.githubDownload);
    this.pypi.configure(settings.pypiDownload);
    const enabled = new Set([settings.audioEngine, ...settings.fallbackEngines]);
    this.gdstudio.configure(enabled.has('gdstudio'));
    await Promise.all([this.go.configure(settings.gomusicdl, false, enabled.has('gomusicdl')), ...Object.entries(this.adapters).map(([engine, runtime]) => runtime.configure(enabled.has(engine as AudioEngine)))]);
  }
  install(engine: AudioEngine) { if (engine === 'gdstudio') throw new AppError('ENGINE_UNAVAILABLE', 'GD Studio 是在线音源，保存配置即可启用', 400); return engine === 'gomusicdl' ? this.go.install() : this.adapters[engine].install(); }
  restart(engine: AudioEngine) { return engine === 'gdstudio' ? Promise.resolve(this.gdstudio.restart()) : engine === 'gomusicdl' ? this.go.restart() : this.adapters[engine].restart(); }
  async close() { this.downloads.close(); this.pypi.close(); this.gdstudio.close(); await Promise.all([this.go.close(), ...Object.values(this.adapters).map(runtime => runtime.close())]); }
}
