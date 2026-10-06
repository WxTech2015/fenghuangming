import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export interface AgentConfig { serverUrl: string; token: string; mpvPath: string; dataDir: string; cacheMaxMb: number; ipcSecret: string; pipe: string; mpvPipe: string }
export async function loadConfig(filename: string): Promise<AgentConfig> {
  return parseConfig(JSON.parse(await readFile(filename, 'utf8')), filename);
}
export function parseConfig(data: Partial<AgentConfig>, filename: string): AgentConfig {
  if (!data.serverUrl || !data.token || data.token.length < 32 || !data.mpvPath) throw new Error('配置需要 serverUrl、设备 token 和 mpvPath');
  const url = new URL(data.serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('serverUrl 必须是 HTTP / HTTPS 根地址，例如 http://music.example.com:3000');
  const secret = data.ipcSecret || createHash('sha256').update(`local-ipc:${data.token}`).digest('hex');
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) throw new Error('ipcSecret 需要 32–256 字符，留空则自动生成');
  const instance = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  const directory = resolve(data.dataDir ?? resolve(filename, '..', 'agent-data'));
  const cacheMaxMb = data.cacheMaxMb ?? 2048;
  if (!Number.isInteger(cacheMaxMb) || cacheMaxMb < 100 || cacheMaxMb > 100000) throw new Error('cacheMaxMb 应在 100–100000 之间');
  return { serverUrl: url.origin, token: data.token, mpvPath: resolve(data.mpvPath), dataDir: directory, cacheMaxMb, ipcSecret: secret,
    pipe: process.platform === 'win32' ? `\\\\.\\pipe\\qqmusic-worker-${instance}` : resolve(directory, `worker-${instance}.sock`),
    mpvPipe: process.platform === 'win32' ? `\\\\.\\pipe\\qqmusic-mpv-${instance}` : resolve(directory, `mpv-${instance}.sock`) };
}
