import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseConfig, type AgentConfig } from './config';
import { AgentService } from './service';
import { Worker } from './worker';
import { parseOptions, HELP } from './cli';
import { appDirectory, defaultDataDirectory, packaged, prepareTools } from './bundle';
import { installAgent, uninstallAgent, openDesktopConsole } from './setup';
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log('凤凰鸣 Agent 0.1.4'); return; }
  const endpoint = options.endpoint || options.server || process.env.FENGHUANGMING_SERVER;
  const token = options.token || process.env.FENGHUANGMING_TOKEN;
  const localConfig = resolve(appDirectory(), 'agent.config.json');
  const filename = options.config ? resolve(options.config) : options['data-dir'] ? resolve(options['data-dir'], 'agent.config.json') : existsSync(localConfig) ? localConfig : resolve(defaultDataDirectory(), 'agent.config.json');
  let input: Partial<AgentConfig> = {};
  if (options.config || !endpoint || !token) {
    try { input = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (options.config || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (endpoint) input.serverUrl = endpoint;
  if (token) input.token = token;
  if (options['data-dir']) input.dataDir = options['data-dir'];
  const dataDir = input.dataDir ? resolve(input.dataDir) : packaged ? defaultDataDirectory() : resolve(appDirectory(), 'agent-data');
  if (options.uninstall) { await uninstallAgent(dataDir); return; }
  if (options.mpv) input.mpvPath = options.mpv;
  const automaticPlayer = !input.mpvPath || input.mpvPath === 'auto' || packaged && input.mpvPath.toLowerCase() === 'c:\\tools\\mpv\\mpv.exe' && !existsSync(input.mpvPath);
  input.dataDir = dataDir;
  if (automaticPlayer) input.mpvPath = resolve(dataDir, 'tools/mpv/mpv.exe');
  if (!input.serverUrl || !input.token) throw new Error('请使用 --endpoint 和 --token，或 --config 指定后台下载的设备配置。运行 --help 查看用法。');
  const config = parseConfig(input, filename);
  if (options.console) { await openDesktopConsole(filename, config.dataDir); return; }
  if (options.install) { await installAgent(config, options.user); return; }
  if (packaged && automaticPlayer && options.role !== 'service') await prepareTools(dataDir);
  if (options.check) {
    const response = await fetch(new URL('/healthz', config.serverUrl), { signal: AbortSignal.timeout(15000) });
    const health = await response.json() as { ok?: boolean };
    if (!response.ok || health.ok !== true) throw new Error('服务器健康检查失败');
    console.log('服务器连接正常。');
    await new Promise<void>((accept, reject) => {
      const player = spawn(config.mpvPath, ['--version'], { windowsHide: true, stdio: 'inherit' });
      player.once('error', reject); player.once('exit', code => code === 0 ? accept() : reject(new Error('播放器检查失败')));
    });
    return;
  }
  const role = options.role;
  const service = role !== 'worker' ? new AgentService(config) : undefined; const worker = role !== 'service' ? new Worker(config) : undefined;
  await service?.start();
  try { await worker?.start(); } catch (error) { await service?.close(); throw error; }
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void (async () => { await worker?.close(); await service?.close(); process.exit(0); })(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
