import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentConfig } from './config';
import { packaged, prepareTools } from './bundle';
import { appDirectory } from './bundle';

export function powershell(args: string[]) {
  return new Promise<void>((accept, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Windows 配置失败，退出码 ${code}`)));
  });
}
export async function openDesktopConsole(filename: string, dataDir: string) {
  if (process.platform !== 'win32') throw new Error('桌面控制台仅支持 Windows');
  const script = packaged ? (await prepareTools(dataDir, false)).console : resolve(appDirectory(), 'scripts/desktop-console.ps1');
  await powershell(['-WindowStyle', 'Hidden', '-STA', '-File', script, '-ConfigPath', filename, '-DataDir', dataDir]);
}

async function requireAdministrator(install = false) {
  if (process.platform !== 'win32' || !packaged) throw new Error('安装与卸载请使用 Windows 发行版 Agent');
  await powershell(['-Command', `$ErrorActionPreference='Stop'; $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '请以管理员身份打开 PowerShell 后再执行此命令'};${install ? " if(Get-Service -Name QQMusicAgent -ErrorAction SilentlyContinue){throw '服务已经安装。更新前请先执行 --uninstall，配置和缓存会保留'}" : ''}`]);
}

export async function installAgent(config: AgentConfig, user?: string) {
  await requireAdministrator(true);
  const tools = await prepareTools(config.dataDir);
  const filename = resolve(config.dataDir, 'agent.config.json');
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(filename, JSON.stringify({ serverUrl: config.serverUrl, token: config.token, mpvPath: config.mpvPath,
    dataDir: config.dataDir, cacheMaxMb: config.cacheMaxMb, ipcSecret: config.ipcSecret }, null, 2), { mode: 0o600 });
  const args = ['-File', tools.install, '-NssmPath', tools.nssm, '-AgentPath', process.execPath, '-ConfigPath', filename];
  if (user) args.push('-TaskUser', user);
  await powershell(args);
}

export async function uninstallAgent(dataDir: string) {
  await requireAdministrator();
  const tools = await prepareTools(dataDir, false);
  await powershell(['-File', tools.uninstall, '-NssmPath', tools.nssm]);
}
