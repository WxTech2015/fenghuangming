import 'reflect-metadata';
import { Body, Catch, Controller, Delete, ExceptionFilter, Get, HttpException, Inject, Module, Param, Post, Put, Query, Req, Res, Sse, UseGuards, type ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { interval, map, merge, startWith } from 'rxjs';
import { z, ZodError } from 'zod';
import { EngineSchema, type QueueItem } from './contracts';
import { AuthService, AdminGuard, type AuthConfig } from './auth/auth';
import { Store } from './core/store';
import { Events } from './core/events';
import { SystemService, hashToken } from './core/system';
import { QueueService } from './queues/queue';
import { ModerationService } from './policies/moderation';
import { MusicService, GoMusicDlProvider } from './music/providers';
import { GoMusicDlRuntime } from './music/runtime';
import { MusicManager } from './music/manager';
import { releaseUrl } from './music/install';
import { MetadataService, type TrackMetadata } from './music/metadata';
import { MediaService, parseRange } from './media/cache';
import { PlaybackService } from './playback/playback';
import { Gateway } from './transport/gateway';
import { AppError } from './core/errors';
import { DiagnosticLogger, diagnostics, diagnosticTrace, requestTrace, traceFor } from './core/diagnostics';
import { parseMusicCard } from './onebot/cards';

export interface ApplicationOptions { store: Store; dataDir: string; auth: AuthConfig; botToken: string; music?: MusicService; manageMusic?: boolean; metadata?: TrackMetadata | null; webDirectory?: string; logger?: false; diagnostics?: DiagnosticLogger }
export class AppContext {
  readonly log: DiagnosticLogger;
  readonly events = new Events();
  readonly system: SystemService;
  readonly queue: QueueService;
  readonly media: MediaService;
  readonly playback: PlaybackService;
  readonly gateway: Gateway;
  readonly musicRuntime?: GoMusicDlRuntime;
  readonly musicManager?: MusicManager;
  private readonly settingsSubscription;
  constructor(readonly options: ApplicationOptions) {
    this.log = options.diagnostics ?? new DiagnosticLogger({ directory: resolve(options.dataDir, 'logs'), console: options.logger !== false, secrets: [options.auth.password, options.auth.secret, options.botToken] });
    this.system = new SystemService(options.store, this.events);
    this.queue = new QueueService(options.store, this.events, new ModerationService(), options.metadata === null ? undefined : options.metadata ?? new MetadataService());
    if (options.manageMusic !== false && !options.music) {
      this.musicManager = new MusicManager(options.dataDir, (engine, status) => { this.events.musicRuntimes[engine] = status; if (engine === 'gomusicdl') this.events.musicRuntime = status; this.events.changed('music'); }, () => this.events.changed('github-download'));
      this.musicRuntime = this.musicManager.go;
    }
    this.media = new MediaService(options.store, options.music ?? this.musicManager?.music ?? new MusicService([new GoMusicDlProvider()]), resolve(options.dataDir, 'media'), options.auth.secret);
    this.playback = new PlaybackService(options.store, this.events, this.media, agentId => this.gateway.online(agentId));
    this.gateway = new Gateway(options.store, this.events, this.queue, this.playback, options.botToken);
    this.settingsSubscription = this.events.changes.subscribe(event => {
      if (event.data.reason === 'settings') void this.configureMusic().catch(error => diagnostics.error('music.configure.failed', '音源配置失败', { error }));
    });
  }
  async configureMusic() { const config = await this.options.store.transaction(async tx => (await tx.get('setting', 'settings'))!.value); await this.musicManager?.configure(config); }
  async closeMusic() { this.settingsSubscription.unsubscribe(); await this.musicManager?.close(); }
}
@Catch()
class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly log: DiagnosticLogger) {}
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = this.log.traceEnabled ? diagnosticTrace(exception) ?? requestTrace() : undefined;
    this.log.write(exception instanceof HttpException && exception.getStatus() < 500 || exception instanceof ZodError ? 'warn' : 'error', 'api.request.failed', '接口请求失败', { traceId, error: exception });
    if (traceId) response.setHeader('X-Trace-Id', traceId);
    if (exception instanceof ZodError || exception && typeof exception === 'object' && 'name' in exception && exception.name === 'ZodError' && 'issues' in exception && Array.isArray(exception.issues)) { const error = exception as ZodError; response.status(400).json(this.log.safe({ code: 'VALIDATION_ERROR', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'), ...this.log.traceFields(traceId) })); return; }
    if (exception instanceof HttpException) { const result = exception.getResponse(); response.status(exception.getStatus()).json(this.log.safe({ ...(typeof result === 'object' ? result : { message: result }), ...this.log.traceFields(traceId) })); return; }
    response.status(500).json({ code: 'INTERNAL_ERROR', message: this.log.traceEnabled ? '服务器处理失败，请按追踪 ID 查看诊断日志' : '服务器处理失败，请查看后端日志', ...this.log.traceFields(traceId) });
  }
}
@Controller()
class PublicController {
  constructor(@Inject(AuthService) readonly auth: AuthService, @Inject(AppContext) readonly context: AppContext) {}
  @Get('healthz') health() { return { ok: true, version: '0.1.0' }; }
  @Post('api/v1/login') login(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.auth.checkOrigin(request);
    const data = z.object({ username: z.string().max(100), password: z.string().max(200) }).parse(input); return this.auth.login(data.username, data.password, request, response);
  }
  @Post('api/v1/logout') logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) { this.auth.checkOrigin(request); response.clearCookie('qqmusic_session', { path: '/' }); return { ok: true }; }
  @Get('api/v1/media/:assetId') async media(@Param('assetId') assetId: string, @Req() request: Request, @Res() response: Response) {
    const token = request.headers.authorization?.replace(/^Bearer /i, '') ?? '';
    const result = await this.context.options.store.transaction(async tx => ({ agent: (await tx.all('agent')).find(a => a.tokenHash === hashToken(token)), asset: await tx.get('mediaAsset', assetId) }));
    if (!result.agent || !this.context.media.verifyTicket(String(request.query.ticket ?? ''), result.agent.id, assetId)) throw new AppError('UNAUTHORIZED', '音频访问凭证无效', 401);
    if (!result.asset) throw new AppError('NOT_FOUND', '音频缓存不存在', 404);
    const ticketPayload = JSON.parse(Buffer.from(String(request.query.ticket).split('.')[0]!, 'base64url').toString('utf8')) as { playbackId?: string };
    const item = await this.context.options.store.transaction(async tx => (await tx.all('queueItem')).find(value => value.playbackId === ticketPayload.playbackId && value.assetId === assetId && value.zoneId === result.agent!.zoneId));
    const traceId = item ? traceFor(item.requestKey) : diagnosticTrace();
    const range = parseRange(request.headers.range, result.asset.bytes);
    response.status(range.partial ? 206 : 200).set({ 'Content-Type': result.asset.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', ETag: `"${result.asset.sha256}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${result.asset.bytes}`);
    const stream = this.context.media.stream(result.asset, range.start, range.end);
    diagnostics.debug('media.agent.transfer', '向 Agent 传输缓存音频', { traceId, itemId: item?.id, agentId: result.agent.id, assetId, bytes: range.end - range.start + 1, partial: range.partial });
    stream.on('error', error => { diagnostics.error('media.agent.transfer_failed', '缓存音频传输失败', { traceId, itemId: item?.id, agentId: result.agent!.id, assetId, error }); response.destroy(); }); response.on('close', () => stream.destroy()); stream.pipe(response);
  }
}
@Controller('api/v1')
@UseGuards(AdminGuard)
class AdminController {
  constructor(@Inject(AppContext) readonly c: AppContext) {}
  @Get('snapshot') async snapshot() { return { ...await this.c.system.snapshot(), preloads: this.c.playback.preloader.snapshot(), githubDownload: this.c.musicManager?.downloads.snapshot(), pypiDownload: this.c.musicManager?.pypi.snapshot() }; }
  @Get('diagnostics/logs') logs(@Query() input: unknown) {
    const filter = z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).optional(), traceId: z.string().max(100).optional(), itemId: z.string().max(100).optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(input);
    return this.c.log.query(filter);
  }
  @Get('diagnostics/export') exportLogs(@Res() response: Response) {
    const entries = this.c.log.query({ limit: 1000 }).entries.reverse();
    response.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="fenghuangming-debug.jsonl"', 'Cache-Control': 'no-store' }).send(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
  @Get('diagnostics/queue/:id') async queueLogs(@Param('id') id: string) {
    const item = await this.c.options.store.transaction(tx => tx.get('queueItem', id));
    if (!item) throw new AppError('NOT_FOUND', '队列歌曲不存在', 404);
    const traceId = traceFor(item.requestKey); return { ...this.c.log.query(this.c.log.traceEnabled ? { traceId, limit: 500 } : { itemId: item.id, limit: 500 }), ...this.c.log.traceFields(traceId), itemId: item.id };
  }
  @Post('diagnostics/resolve') async testResolve(@Body() input: unknown) {
    const { shareUrl, engine } = z.object({ shareUrl: z.string().url().max(2000).refine(url => ['http:', 'https:'].includes(new URL(url).protocol), '仅支持 HTTP / HTTPS 分享链接'), engine: EngineSchema.optional() }).parse(input);
    const traceId = diagnosticTrace() ?? requestTrace();
    return this.c.log.run({ traceId, diagnostic: true }, async () => {
      diagnostics.info('diagnostic.resolve.start', '开始测试分享链接解析', { shareUrl, engine });
      try {
        let track = await parseMusicCard([{ type: 'text', data: { text: shareUrl } }]);
        if (!track) throw new AppError('CARD_UNSUPPORTED', '未识别到支持的音乐分享链接');
        if (this.c.queue.metadata) track = await this.c.queue.metadata.enrich(track, false);
        const snapshot = await this.c.system.snapshot();
        const item: QueueItem = { id: `diagnostic_${traceId}`, requestKey: traceId, zoneId: snapshot.zones[0]?.id ?? 'zone_default', userId: 'diagnostic', userName: '解析测试', groupId: '', botId: '', track, engine: engine ?? snapshot.settings.audioEngine, status: 'preparing', priority: 0, promotedAt: null, createdAt: new Date().toISOString(), playbackId: null, assetId: null, error: null, reviewReason: null };
        const asset = await this.c.media.prepare(item);
        diagnostics.info('diagnostic.resolve.ok', '解析与完整音频校验成功', { source: asset.source, bytes: asset.bytes, durationSeconds: asset.durationSeconds });
        return { ok: true, ...this.c.log.traceFields(traceId), track: { platform: track.platform, externalId: track.externalId, title: track.title, artists: track.artists }, source: asset.source, bytes: asset.bytes, durationSeconds: asset.durationSeconds };
      } catch (error) {
        diagnostics.error('diagnostic.resolve.failed', '测试解析失败', { error });
        return { ok: false, ...this.c.log.traceFields(traceId), code: error instanceof AppError ? error.code : 'RESOLVE_FAILED', message: diagnostics.summary(error) };
      }
    });
  }
  @Post('music/github-mirrors/test') testGithubMirrors() {
    if (!this.c.musicManager) throw new AppError('ENGINE_UNAVAILABLE', '音源服务未启用');
    if ([this.c.musicManager.go, ...Object.values(this.c.musicManager.adapters)].some(runtime => runtime.status.phase === 'installing')) throw new AppError('INSTALL_BUSY', '安装正在进行，请完成后重新测速', 409);
    void this.c.musicManager.downloads.test(releaseUrl(), true).catch(error => diagnostics.warn('github.test.failed', 'GitHub 节点测速失败', { error }));
    return { ok: true };
  }
  @Post('onebot/refresh') refreshBots() { return this.c.gateway.refreshBots(); }
  @Post('music/pypi-mirrors/test') testPypiMirrors() {
    if (!this.c.musicManager) throw new AppError('ENGINE_UNAVAILABLE', '音源服务未启用');
    if (this.c.musicManager.adapters.musicdl.status.phase === 'installing') throw new AppError('INSTALL_BUSY', 'musicdl 安装正在进行，请完成后重新测速', 409);
    void this.c.musicManager.pypi.test(true).catch(error => diagnostics.warn('pypi.test.failed', 'PyPI 镜像测速失败', { error }));
    return { ok: true };
  }
  @Post('music/install') installMusic(@Body() input: unknown) { if (!this.c.musicManager) throw new AppError('ENGINE_UNAVAILABLE', '音源服务未启用'); const { engine } = z.object({ engine: EngineSchema }).parse(input); void this.c.musicManager.install(engine); return { ok: true }; }
  @Post('music/restart') restartMusic(@Body() input: unknown) { if (!this.c.musicManager) throw new AppError('ENGINE_UNAVAILABLE', '自动音源服务未启用'); const { engine } = z.object({ engine: EngineSchema.default('gomusicdl') }).parse(input ?? {}); void this.c.musicManager.restart(engine); return { ok: true }; }
  @Sse('events') events() { return merge(this.c.events.changes, interval(15000).pipe(map(() => ({ data: { reason: 'keepalive', at: new Date().toISOString() } })))).pipe(startWith({ data: { reason: 'connected', at: new Date().toISOString() } })); }
  @Put('settings') settings(@Body() input: unknown) { return this.c.system.saveSettings(input); }
  @Post('zones') zone(@Body() input: unknown) { return this.c.system.saveZone(input); }
  @Put('zones/:id') updateZone(@Param('id') id: string, @Body() input: unknown) { return this.c.system.saveZone(input, id); }
  @Post('bindings') binding(@Body() input: unknown) { return this.c.system.bind(input); }
  @Delete('bindings/:id') removeBinding(@Param('id') id: string) { return this.c.system.remove('binding', id); }
  @Post('blacklists') ban(@Body() input: unknown) { return this.c.system.blacklist(input); }
  @Delete('blacklists/:id') removeBan(@Param('id') id: string) { return this.c.system.remove('blacklist', id); }
  @Post('agents') device(@Body() input: unknown) { return this.c.system.registerAgent(input); }
  @Delete('agents/:id') async removeDevice(@Param('id') id: string) { const result = await this.c.system.remove('agent', id); this.c.gateway.sessions.get(id)?.socket.close(4003, 'removed'); return result; }
  @Post('queue') enqueue(@Body() input: unknown) { return this.c.queue.enqueue(input); }
  @Post('queue/:id/promote') promote(@Param('id') id: string) { return this.c.queue.promote(id); }
  @Post('queue/:id/review') review(@Param('id') id: string, @Body() input: unknown) { return this.c.queue.review(id, z.object({ approve: z.boolean() }).parse(input).approve); }
  @Delete('queue/:id') cancel(@Param('id') id: string) { return this.c.queue.cancel(id); }
  @Post('zones/:id/control') async control(@Param('id') id: string, @Body() input: unknown) {
    const data = z.discriminatedUnion('action', [z.object({ action: z.literal('seek'), position: z.number().int().min(0).max(86400), playbackId: z.string().min(1).max(100) }), z.object({ action: z.enum(['skip', 'pause', 'resume', 'volume']), volume: z.number().int().min(0).max(100).optional() })]).parse(input);
    const result = data.action === 'seek' ? await this.c.playback.control(id, data.action, data.position, data.playbackId) : await this.c.playback.control(id, data.action, data.volume);
    await this.c.gateway.flush(true); return result;
  }
  @Post('playlists') playlist(@Body() input: unknown) { return this.c.system.playlist(input); }
  @Put('playlists/:id') updatePlaylist(@Param('id') id: string, @Body() input: unknown) { return this.c.system.playlist(input, id); }
  @Delete('playlists/:id') removePlaylist(@Param('id') id: string) { return this.c.system.remove('playlist', id); }
  @Post('playlists/:id/enqueue') enqueuePlaylist(@Param('id') id: string) { return this.c.queue.enqueuePlaylist(id); }
}
export async function createApplication(options: ApplicationOptions) {
  const context = new AppContext(options); const auth = new AuthService(options.auth);
  await context.log.init();
  return context.log.run({ component: 'backend' }, async () => {
  await context.system.init(); await context.playback.recover();
  void context.configureMusic();
  @Module({ controllers: [PublicController, AdminController], providers: [{ provide: AppContext, useValue: context }, { provide: AuthService, useValue: auth }, AdminGuard] })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: options.logger === false ? false : ['error', 'warn', 'log'] });
  app.use((request: Request, response: Response, next: () => void) => {
    const traceId = context.log.traceEnabled ? requestTrace() : undefined; const started = Date.now(); const path = request.path;
    if (traceId) response.setHeader('X-Trace-Id', traceId);
    context.log.run({ traceId, method: request.method, path }, () => {
      response.once('finish', () => {
        if (response.statusCode < 400 && ['/api/v1/snapshot', '/api/v1/events', '/healthz', '/api/v1/diagnostics/logs'].includes(path)) return;
        context.log.write(response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'debug', 'api.request.finished', '接口请求结束', { traceId, method: request.method, path, status: response.statusCode, durationMs: Date.now() - started });
      });
      next();
    });
  });
  app.useGlobalFilters(new ApiErrorFilter(context.log));
  if (options.webDirectory && existsSync(resolve(options.webDirectory, 'index.html'))) app.useStaticAssets(options.webDirectory);
  await app.init(); context.gateway.attach(app.getHttpServer());
  diagnostics.info('backend.initialized', '后端初始化完成', { storage: options.store.driver, dataDir: options.dataDir, logLevel: context.log.level });
  return { app, context, close: async () => { context.gateway.close(); const preloads = context.playback.preloader.close(); const media = context.media.close(); await context.closeMusic(); await Promise.allSettled([preloads, media]); await app.close(); await options.store.close(); await context.log.close(); } };
  });
}
