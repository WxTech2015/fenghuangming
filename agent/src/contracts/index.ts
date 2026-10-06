import { z } from 'zod';

export const PROJECT_INFO = { name: '凤凰鸣', company: '', developer: '' } as const;

export const EngineSchema = z.enum(['gomusicdl', 'musicdl', 'neteaseapi', 'meting', 'gdstudio']);
export type AudioEngine = z.infer<typeof EngineSchema>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface DiagnosticEntry { id: string; at: string; level: LogLevel; event: string; message: string; traceId: string | null; fields: Record<string, unknown> }
export interface DiagnosticResult { entries: DiagnosticEntry[]; matched: number; buffered: number; level: LogLevel; mode?: 'production' | 'debug'; traceEnabled?: boolean; includeStack?: boolean; directory: string | null; diskError: string | null }
const serviceUrl = z.string().url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), '仅支持 HTTP / HTTPS');
export const PYPI_MIRRORS = [
  { mirror: 'https://pypi.org/simple/', label: 'PyPI 官方' },
  { mirror: 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/', label: '清华 TUNA' },
  { mirror: 'https://mirrors.aliyun.com/pypi/simple/', label: '阿里云' },
  { mirror: 'https://repo.huaweicloud.com/repository/pypi/simple/', label: '华为云' },
  { mirror: 'https://mirrors.cloud.tencent.com/pypi/simple/', label: '腾讯云' },
  { mirror: 'https://mirrors.ustc.edu.cn/pypi/simple/', label: '中国科大 USTC' },
  { mirror: 'https://mirror.sjtu.edu.cn/pypi/web/simple/', label: '上海交大 SJTUG' },
  { mirror: 'https://mirrors.nju.edu.cn/pypi/web/simple/', label: '南京大学' },
  { mirror: 'https://mirrors.zju.edu.cn/pypi/web/simple/', label: '浙江大学' },
  { mirror: 'https://mirrors.sustech.edu.cn/pypi/web/simple/', label: '南方科技大学' },
  { mirror: 'https://mirrors.bfsu.edu.cn/pypi/web/simple/', label: '北京外国语大学' },
  { mirror: 'https://mirrors.ha.edu.cn/pypi/simple/', label: '河南省教科网' },
  { mirror: 'https://mirror.nyist.edu.cn/pypi/simple/', label: '南阳理工学院' },
  { mirror: 'https://mirrors.hust.edu.cn/pypi/web/simple/', label: '华中科技大学' },
  { mirror: 'https://mirrors.cernet.edu.cn/pypi/web/simple/', label: '教育网自动路由' },
  { mirror: 'https://mirror.baidu.com/pypi/simple/', label: '百度' },
  { mirror: 'https://mirrors.tencent.com/pypi/simple/', label: '腾讯云备用入口' },
  { mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple/', label: '清华 TUNA 备用入口' },
  { mirror: 'https://mirror.lzu.edu.cn/pypi/web/simple/', label: '兰州大学转发入口' },
  { mirror: 'https://pypi.doubanio.com/simple/', label: '豆瓣旧入口（转腾讯云）' },
] as const;
export const SettingsSchema = z.object({
  audioEngine: EngineSchema.default('gomusicdl'),
  fallbackEngines: z.array(EngineSchema).max(5).refine(x => new Set(x).size === x.length, '备用音源不能重复').default(['meting', 'neteaseapi']),
  searchFallback: z.boolean().default(false),
  gomusicdl: z.object({ mode: z.enum(['managed', 'external']).default('managed'), baseUrl: serviceUrl.default('http://127.0.0.1:8080/music') }).default({}),
  gdstudio: z.object({ quality: z.enum(['999', '740', '320', '192', '128']).default('999') }).default({}),
  githubDownload: z.object({ mode: z.enum(['auto', 'direct', 'mirror']).default('auto'), mirror: z.string().max(300).default('') }).refine(value => value.mode !== 'mirror' || /^https:\/\//.test(value.mirror) && (() => { try { const url = new URL(value.mirror); return !url.username && !url.password && !url.search && !url.hash; } catch { return false; } })(), '请选择 HTTPS 下载节点').default({}),
  pypiDownload: z.object({ mode: z.enum(['auto', 'official', 'mirror']).default('auto'), mirror: z.string().max(300).default('') }).refine(value => value.mode !== 'mirror' || PYPI_MIRRORS.some(node => node.mirror === value.mirror), '请选择内置 PyPI 镜像').default({}),
  dailyJumpLimit: z.number().int().min(0).max(999).default(3),
  maxPendingPerUser: z.number().int().min(1).max(100).default(5),
  maxQueueSize: z.number().int().min(1).max(1000).default(100),
  maxDurationSeconds: z.number().int().min(30).max(7200).default(900),
  cacheMaxMb: z.number().int().min(100).max(100000).default(2048),
  downloads: z.object({ preloadCount: z.number().int().min(0).max(10).default(3), preloadConcurrency: z.number().int().min(1).max(4).default(2), connections: z.number().int().min(1).max(8).default(4) }).default({}),
  ai: z.object({ enabled: z.boolean().default(false), baseUrl: serviceUrl.default('https://api.example.com/v1'), model: z.string().max(100).default(''), policy: z.string().max(4000).default('适合办公室背景播放，拒绝明显色情、辱骂或暴力内容。'), unknownAction: z.enum(['review', 'allow']).default('review') }).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const TrackSchema = z.object({ platform: z.enum(['netease', 'qq', 'kugou', 'kuwo', 'migu', 'bodian']), externalId: z.string().max(100).regex(/^[A-Za-z0-9_-]*$/).default(''), title: z.string().min(1).max(200), artists: z.array(z.string().max(100)).max(10).default([]), album: z.string().max(200).default(''), durationSeconds: z.number().min(0).max(14400).default(0), coverUrl: z.string().max(2000).default(''), lyrics: z.string().max(30000).default(''), shareUrl: z.string().max(2000).default(''), originalAudioUrl: serviceUrl.optional() }).refine(x => !!x.externalId || /^https?:\/\//.test(x.shareUrl) && x.artists.some(a => a.trim()), '缺少歌曲 ID 时需要原分享链接和歌手');
export type Track = z.infer<typeof TrackSchema>;
export const EnqueueSchema = z.object({ zoneId: z.string().min(1).max(100), userId: z.string().min(1).max(100), userName: z.string().max(100).default(''), track: TrackSchema, requestKey: z.string().min(1).max(200), groupId: z.string().max(100).default(''), botId: z.string().max(100).default('') });
export type EnqueueInput = z.infer<typeof EnqueueSchema>;
export const ZoneSchema = z.object({ name: z.string().min(1).max(80), volume: z.number().int().min(0).max(100).default(50), enabled: z.boolean().default(true) });
export const BindingSchema = z.object({ botId: z.string().regex(/^\d{1,20}$/).optional(), groupId: z.string().regex(/^\d{1,20}$/), zoneId: z.string().min(1).max(100), enabled: z.boolean().default(true) });
export const BlacklistSchema = z.object({ kind: z.enum(['user', 'track']), value: z.string().min(1).max(300), scope: z.enum(['global', 'zone', 'group']).default('global'), scopeId: z.string().max(100).default(''), reason: z.string().max(300).default('管理员禁用') }).refine(x => x.scope === 'global' || !!x.scopeId, '请填写作用范围 ID');
export const CommandPayloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), playbackId: z.string(), queueItemId: z.string(), assetId: z.string(), ticket: z.string(), sha256: z.string().length(64), bytes: z.number().int().positive(), mime: z.string(), volume: z.number().int().min(0).max(100), title: z.string().max(200).optional(), artists: z.array(z.string().max(100)).max(10).optional(), durationSeconds: z.number().nonnegative().optional() }),
  z.object({ action: z.literal('stop'), playbackId: z.string() }),
  z.object({ action: z.enum(['pause', 'resume']), playbackId: z.string() }),
  z.object({ action: z.literal('seek'), playbackId: z.string(), position: z.number().int().min(0).max(86400) }),
  z.object({ action: z.literal('volume'), volume: z.number().int().min(0).max(100) }),
]);
export type CommandPayload = z.infer<typeof CommandPayloadSchema>;
export const WireCommandSchema = z.object({ v: z.literal(1), kind: z.literal('command'), id: z.string(), agentId: z.string(), zoneId: z.string(), epoch: z.number().int().positive(), expiresAt: z.string().datetime(), payload: CommandPayloadSchema });
export type WireCommand = z.infer<typeof WireCommandSchema>;
export const AgentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), v: z.literal(1), ready: z.boolean(), version: z.string().max(40), capabilities: z.array(z.literal('seek')).max(1).optional(), bootId: z.string().max(100), playbackId: z.string().nullable(), started: z.boolean().optional(), position: z.number().nonnegative(), durationSeconds: z.number().min(0).max(86400).optional(), seekable: z.boolean().optional() }),
  z.object({ type: z.literal('heartbeat'), ready: z.boolean(), playbackId: z.string().nullable(), started: z.boolean().optional(), position: z.number().nonnegative(), paused: z.boolean(), durationSeconds: z.number().min(0).max(86400).optional(), seekable: z.boolean().optional() }),
  z.object({ type: z.literal('ack'), commandId: z.string(), status: z.enum(['accepted', 'duplicate', 'rejected']), error: z.string().max(500).optional() }),
  z.object({ type: z.literal('playback'), eventId: z.string(), playbackId: z.string(), state: z.enum(['started', 'ended', 'stopped', 'failed']), error: z.string().max(500).optional() }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export interface Zone { id: string; name: string; volume: number; enabled: boolean; revision: number; currentItemId: string | null; priorityStreak: number }
export interface GroupBinding { id: string; botId: string; groupId: string; zoneId: string; enabled: boolean }
export interface NapCatBot { id: string; nickname: string; connected: boolean; groups: { id: string; name: string }[]; lastSyncedAt: string | null; syncError: string | null }
export interface Agent { id: string; name: string; zoneId: string; tokenHash: string; lastSeen: string | null; ready: boolean; epoch: number; position: number; paused: boolean }
export interface AgentLiveState { version?: string; supportsSeek?: boolean; playbackId?: string | null; durationSeconds?: number; seekable?: boolean }
export type QueueStatus = 'review' | 'queued' | 'preparing' | 'dispatching' | 'playing' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export interface QueueItem { id: string; zoneId: string; requestKey: string; userId: string; userName: string; groupId: string; botId: string; track: Track; engine: AudioEngine; status: QueueStatus; priority: number; promotedAt: string | null; createdAt: string; playbackId: string | null; assetId: string | null; error: string | null; reviewReason: string | null }
export interface Blacklist { id: string; kind: 'user' | 'track'; value: string; scope: 'global' | 'zone' | 'group'; scopeId: string; reason: string; createdAt: string }
export interface Quota { id: string; userId: string; date: string; used: number }
export interface QuotaEvent { id: string; quotaId: string; itemId: string; operation: 'consume' | 'refund'; createdAt: string }
export interface Playlist { id: string; name: string; zoneId: string; tracks: Track[]; createdAt: string }
export interface Command { id: string; agentId: string; zoneId: string; itemId: string | null; epoch: number; payload: CommandPayload; state: 'pending' | 'acked' | 'done' | 'rejected'; createdAt: string; expiresAt: string }
export interface MediaAsset { id: string; trackKey: string; filename: string; mime: string; bytes: number; sha256: string; durationSeconds: number; createdAt: string; lastAccessedAt: string; source?: { engine: AudioEngine | 'direct'; match: 'original' | 'id' | 'search'; platform: Track['platform']; externalId: string } }
export interface Audit { id: string; action: string; targetId: string; detail: string; createdAt: string }
export interface Setting { id: string; value: Settings }
export interface MusicRuntimeStatus { mode: 'managed' | 'external' | 'builtin'; phase: 'uninstalled' | 'stopped' | 'installing' | 'starting' | 'ready' | 'external' | 'failed'; installed: boolean; version: string; baseUrl: string | null; error: string | null }
export interface GithubMirrorResult { mirror: string; label: string; available: boolean | null; latencyMs: number | null; speedBytesPerSecond: number | null; error: string | null }
export interface GithubDownloadState { phase: 'idle' | 'testing' | 'downloading' | 'ready' | 'failed'; selected: string | null; checkedAt: string | null; filename: string | null; error: string | null; nodes: GithubMirrorResult[] }
export interface PypiMirrorResult { mirror: string; label: string; available: boolean | null; latencyMs: number | null; speedBytesPerSecond: number | null; error: string | null; indexReachable?: boolean; stage?: 'index' | 'download' | 'complete' }
export interface PypiDownloadState { phase: 'idle' | 'testing' | 'installing' | 'ready' | 'failed'; selected: string | null; checkedAt: string | null; error: string | null; nodes: PypiMirrorResult[] }
export interface Tables { setting: Setting; zone: Zone; binding: GroupBinding; agent: Agent; queueItem: QueueItem; blacklist: Blacklist; quota: Quota; quotaEvent: QuotaEvent; playlist: Playlist; command: Command; mediaAsset: MediaAsset; audit: Audit }
export type TableName = keyof Tables;
export interface Snapshot { preloads?: { itemId: string; phase: 'warming' | 'ready' | 'failed'; error: string | null; checkedAt: number }[]; storageDriver: string; settings: Settings; zones: Zone[]; bindings: GroupBinding[]; agents: (Omit<Agent, 'tokenHash'> & AgentLiveState)[]; queue: QueueItem[]; blacklists: Blacklist[]; quotas: Quota[]; playlists: Playlist[]; audit: Audit[]; botConnected: boolean; bots: NapCatBot[]; onebotError: string | null; musicRuntime: MusicRuntimeStatus; musicRuntimes: Partial<Record<AudioEngine, MusicRuntimeStatus>>; githubDownload?: GithubDownloadState; pypiDownload?: PypiDownloadState }
