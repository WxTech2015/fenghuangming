import { config } from 'dotenv';
import { resolve } from 'node:path';
import { PROJECT_INFO } from './contracts';
import { createApplication } from './app';
import { FileStore, MysqlStore } from './core/store';
import { DiagnosticLogger, diagnostics, useDefaultLogger } from './core/diagnostics';
import { runtimeConfig } from './core/config';

const root = resolve(__dirname, '..'); config({ path: resolve(root, '.env') });
async function main() {
  const dataDir = resolve(root, process.env.DATA_DIR ?? 'data');
  const settings = runtimeConfig();
  process.env.NODE_ENV = settings.mode === 'production' ? 'production' : 'development';
  const log = new DiagnosticLogger({ directory: resolve(dataDir, 'logs') });
  await log.init(); useDefaultLogger(log);
  diagnostics.info('backend.starting', '后端正在启动', { mode: settings.mode, logLevel: settings.logLevel, traceEnabled: settings.traceEnabled, nodeVersion: process.version, platform: process.platform, arch: process.arch, dataDir });
  const host = process.env.HOST ?? '127.0.0.1'; const password = process.env.ADMIN_PASSWORD ?? 'dev-password-change-me'; const secret = process.env.SESSION_SECRET ?? 'local-development-secret-change-before-deployment';
  // 反向代理下后端仍可能监听本机，生产模式也必须检查默认凭证。
  if ((settings.mode === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(host)) && (!password.trim() || password === 'dev-password-change-me' || password === 'change-me' || secret.trim().length < 32 || /^(replace-with|local-development-secret)/.test(secret))) throw new Error('请设置管理员密码和至少 32 字符的随机 SESSION_SECRET');
  const driver = process.env.STORAGE_DRIVER ?? 'file';
  if (!['file', 'mysql'].includes(driver)) throw new Error('STORAGE_DRIVER 只能为 file 或 mysql');
  diagnostics.info('storage.connecting', '连接存储', { driver });
  const store = driver === 'mysql' ? await new MysqlStore().init() : await new FileStore(resolve(dataDir, 'database.json')).init();
  diagnostics.info('storage.connected', '存储连接成功', { driver });
  const server = await createApplication({ store, dataDir, auth: { username: process.env.ADMIN_USERNAME ?? 'admin', password, secret, secure: process.env.COOKIE_SECURE === 'true' }, botToken: process.env.ONEBOT_TOKEN ?? '', diagnostics: log });
  await server.app.listen(Number(process.env.PORT ?? 19988), host);
  console.log(`${PROJECT_INFO.name}服务已启动：http://${host}:${process.env.PORT ?? 19988} / 存储 ${driver}`);
  diagnostics.info('backend.listening', '后端开始监听', { host, port: Number(process.env.PORT ?? 19988), onebotConfigured: !!process.env.ONEBOT_TOKEN });
  if (driver === 'file') console.log('当前是本地演示存储；部署时请使用 MySQL。');
  if (!process.env.ONEBOT_TOKEN) console.log('未设置 ONEBOT_TOKEN，NapCat 入口暂未开放。');
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void server.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
void main().catch(async error => { diagnostics.error('backend.start.failed', '后端启动失败', { error }); await diagnostics.current().flush(); process.exit(1); });
