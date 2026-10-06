import { getAsset, isSea } from 'node:sea';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export const packaged = isSea();
export const appDirectory = () => packaged ? dirname(process.execPath) : resolve(__dirname, '..');
export const defaultDataDirectory = () => process.platform === 'win32'
  ? resolve(process.env.ProgramData || 'C:\\ProgramData', 'QQMusicAgent')
  : resolve(appDirectory(), 'agent-data');

interface Asset { key: string; path: string; sha256: string; bytes: number }
async function hashFile(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareTools(dataDir: string, player = true) {
  if (!packaged) throw new Error('此功能需要使用已打包的 fenghuangming-agent.exe');
  const assets = JSON.parse(Buffer.from(getAsset('release-manifest')).toString('utf8')) as Asset[];
  const directory = resolve(dataDir, 'tools');
  for (const asset of assets) {
    if (!player && asset.path.startsWith('mpv/')) continue;
    const filename = resolve(directory, asset.path);
    if (!filename.startsWith(directory + sep)) throw new Error('无效的内置文件路径');
    try { if ((await stat(filename)).size === asset.bytes && await hashFile(filename) === asset.sha256) continue; } catch { /* first extraction */ }
    const bytes = Buffer.from(getAsset(asset.key));
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('内置文件校验失败');
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename + '.tmp', bytes);
    await rename(filename + '.tmp', filename);
  }
  return { mpv: resolve(directory, 'mpv/mpv.exe'), nssm: resolve(directory, 'nssm.exe'),
    install: resolve(directory, 'scripts/install-agent.ps1'), uninstall: resolve(directory, 'scripts/uninstall-agent.ps1'), console: resolve(directory, 'scripts/desktop-console.ps1') };
}
