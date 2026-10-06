import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installRelease, type ReleaseArtifact } from './install';
import { GithubDownloader, mirrorUrl } from './github-download';
import { PypiDownloader } from './pypi-download';
import { captureOutput, diagnostics } from '../core/diagnostics';

export const MUSICDL_VERSION = '2.14.0';
export const UV_VERSION = '0.12.23';
const releases: Record<string, [string, string]> = {
  'win32-x64': ['x86_64-pc-windows-msvc', '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90'],
  'win32-arm64': ['aarch64-pc-windows-msvc', '13294e232ececbe709c06b74e6ced06f2a225ea5591476685362f22be56a50d5'],
  'win32-ia32': ['i686-pc-windows-msvc', '22a92f4374e4716c2848acaa0392f2f8e4a13b0ff65d080e2a5ade167bce96a8'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f'],
  'linux-arm': ['armv7-unknown-linux-gnueabihf', '4d568920e1f60c4b881cbe2827dfa20592a9a9721f69b57d47650d035c4fe8f6'],
  'darwin-x64': ['x86_64-apple-darwin', '960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4'],
  'darwin-arm64': ['aarch64-apple-darwin', '50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544'],
};
export function uvArtifact(platform = process.platform, arch = process.arch): ReleaseArtifact {
  const entry = releases[`${platform}-${arch}`]; if (!entry) throw new Error(`musicdl 暂不支持在 ${platform}/${arch} 自动准备 Python`);
  const [target, sha256] = entry; const windows = platform === 'win32';
  return { filename: `uv-${target}.${windows ? 'zip' : 'tar.gz'}`, binary: windows ? 'uv.exe' : `uv-${target}/uv`, sha256, version: UV_VERSION };
}
export async function downloadUv(artifact: ReleaseArtifact, signal: AbortSignal, downloads = new GithubDownloader()) {
  return downloads.download(`https://github.com/astral-sh/uv/releases/download/${artifact.version}/${artifact.filename}`, artifact.sha256, signal);
}
export function pythonEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const root = resolve(dataDir, 'tools', 'musicdl');
  return { ...process.env, UV_CACHE_DIR: resolve(root, 'cache'), UV_PYTHON_INSTALL_DIR: resolve(root, 'python'), UV_PYTHON_BIN_DIR: resolve(root, 'bin'), UV_NO_PROGRESS: '1', UV_NO_CONFIG: '1', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', QQMUSIC_MUSICDL_LOG_DIR: resolve(root, 'logs'), XDG_CACHE_HOME: resolve(root, 'xdg-cache'), XDG_CONFIG_HOME: resolve(root, 'xdg-config'), XDG_DATA_HOME: resolve(root, 'xdg-data') };
}
async function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeout = 600000) {
  diagnostics.info('python.prepare.step', '执行 Python / musicdl 准备步骤', { executable, args, cwd });
  await new Promise<void>((ok, fail) => {
    let output = '';
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    captureOutput(child.stdout, 'python.prepare.stdout', 'Python 准备输出', {}); captureOutput(child.stderr, 'python.prepare.stderr', 'Python 准备标准错误输出', {});
    const onExit = () => { child.kill(); }; process.once('exit', onExit);
    const timer = setTimeout(() => { child.kill(); fail(new Error('Python / musicdl 准备超时，请检查后端访问 GitHub、PyPI 的网络后重试')); }, timeout);
    child.once('error', error => { clearTimeout(timer); process.off('exit', onExit); fail(error); });
    child.once('exit', code => {
      clearTimeout(timer); process.off('exit', onExit);
      if (code === 0) { ok(); return; }
      // Keep bounded, redacted diagnostics on the server, never in snapshots.
      const safe = diagnostics.current().safe(output);
      const detail = safe.split(/\r?\n/).filter(line => line.trim()).slice(-8).join('\n').slice(-1600);
      void writeFile(resolve(cwd, 'prepare.log'), safe, { mode: 0o600 }).catch(() => {}).then(() => fail(new Error(`Python / musicdl 准备失败（${args[0]}，退出码 ${code}）${detail ? `：${detail}` : ''}；详细日志：tools/musicdl/${MUSICDL_VERSION}/prepare.log`)));
    });
  });
}
export async function findInstalledMusicDl(dataDir: string): Promise<string | null> {
  const directory = resolve(dataDir, 'tools', 'musicdl', MUSICDL_VERSION);
  const python = resolve(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, 'installed.json'), 'utf8'));
    return manifest.version === MUSICDL_VERSION && (await stat(python)).isFile() ? python : null;
  } catch { return null; }
}
export async function installPythonPackages(uv: string, python: string, directory: string, env: NodeJS.ProcessEnv, signal: AbortSignal, indexes: PypiDownloader, runner = run) {
  await indexes.install(async (index, attemptSignal) => {
    const installEnv = { ...env, UV_DEFAULT_INDEX: index, UV_INDEX_URL: index, PIP_INDEX_URL: index, UV_HTTP_TIMEOUT: '30', UV_HTTP_RETRIES: '2' };
    for (const key of ['UV_INDEX', 'UV_EXTRA_INDEX_URL', 'PIP_EXTRA_INDEX_URL']) delete (installEnv as NodeJS.ProcessEnv)[key];
    await runner(uv, ['pip', 'install', '--python', python, '--default-index', index, `musicdl==${MUSICDL_VERSION}`], directory, installEnv, attemptSignal, 300000);
  }, signal);
}
export async function installMusicDl(dataDir: string, signal: AbortSignal, downloads?: GithubDownloader, indexes = new PypiDownloader()): Promise<string> {
  const directory = resolve(dataDir, 'tools', 'musicdl', MUSICDL_VERSION); await mkdir(directory, { recursive: true });
  const venv = resolve(directory, 'venv'); const python = resolve(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const manifestPath = resolve(directory, 'installed.json'); const env = pythonEnvironment(dataDir);
  // musicdl creates its log directory at import time. Keep this library side
  // effect in DATA_DIR on every OS, including Windows service accounts.
  const verify = `import os, platformdirs; platformdirs.user_log_dir = lambda *a, **k: os.environ['QQMUSIC_MUSICDL_LOG_DIR']; from musicdl import musicdl; import musicdl as package; assert package.__version__ == '${MUSICDL_VERSION}'`;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version === MUSICDL_VERSION) { await run(python, ['-c', verify], directory, env, signal, 60000); return python; }
  } catch { signal.throwIfAborted(); }
  const uv = await installRelease({ dataDir, signal, toolName: 'uv', artifact: uvArtifact(), download: (artifact, signal) => downloadUv(artifact, signal, downloads) });
  const pythonEnv: NodeJS.ProcessEnv = { ...env };
  const githubMirror = downloads?.snapshot().selected;
  if (!pythonEnv.UV_PYTHON_INSTALL_MIRROR && githubMirror) pythonEnv.UV_PYTHON_INSTALL_MIRROR = mirrorUrl('https://github.com/astral-sh/python-build-standalone/releases/download', githubMirror);
  try { await run(uv, ['venv', '--allow-existing', '--python', '3.12', '--managed-python', venv], directory, pythonEnv, signal, 180000); }
  catch (error) {
    signal.throwIfAborted(); if (!githubMirror || env.UV_PYTHON_INSTALL_MIRROR) throw error;
    diagnostics.warn('python.prepare.mirror_failed', 'Python 下载镜像失败，改用官方源', { error });
    await run(uv, ['venv', '--allow-existing', '--python', '3.12', '--managed-python', venv], directory, env, signal, 180000);
  }
  await installPythonPackages(uv, python, directory, env, signal, indexes);
  await run(python, ['-c', verify], directory, env, signal, 60000);
  await writeFile(manifestPath, JSON.stringify({ version: MUSICDL_VERSION, python: '3.12' }), { mode: 0o600 });
  return python;
}
