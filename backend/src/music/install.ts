import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { extract } from 'tar-stream';
import { GithubDownloader } from './github-download';
import { diagnostics } from '../core/diagnostics';

// Update the version and hashes together after reviewing the official release.
export const GOMUSIC_VERSION = 'v1.1.1';
export interface ReleaseArtifact { filename: string; sha256: string; binary: string; version: string }
const hashes: Record<string, string> = {
  windows_amd64: 'ba557963f8cea3feed0415c58a68c54f3423416293aad13f3a8ff4eb3c309a21',
  linux_amd64: 'be7b828096a23b7401d69649484ece667ed588116a6039bb8f55e0f4df7c5949',
  linux_arm64: '099958e021ed35a5710b7004b19593a6d09779afebf7df9be276f34d2b9d2fbd',
  linux_386: 'e2daed3ca71381f46dcde8dfe0b0b4ece4543ae09127fc14974d1d4824a16604',
  linux_armv7: '0f1bd6e6c1ee12527a07568509feba23ad9179bc3083dad00358f1563d9a7c4b',
  linux_armv6: '879410559651428f1932fe75468bfbbca4f019940c609d2c204e173a243a847d',
  darwin_amd64: '3339a871352c2e606a55a39c0e5cffd35992f8336c5ccfbf89a4707fbc617101',
  darwin_arm64: '9397c5f00fbd2cef1e9f388823a9461d9cd9e30fe06a2615b23d03b1a85d03b9',
};
export function releaseArtifact(platform: string = process.platform, arch: string = process.arch, armVersion = String((process.config.variables as Record<string, unknown>).arm_version ?? '7')): ReleaseArtifact {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = ({ x64: 'amd64', ia32: '386', arm64: 'arm64', arm: Number(armVersion) >= 7 ? 'armv7' : 'armv6' } as Record<string, string>)[arch];
  const sha256 = hashes[`${os}_${cpu}`];
  if (!sha256) throw new Error(`go-music-dl 暂无 ${platform}/${arch} 自动安装包，请选择连接已有服务`);
  return { filename: `go-music-dl_${os}_${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`, sha256, binary: os === 'windows' ? 'music-dl.exe' : 'music-dl', version: GOMUSIC_VERSION };
}
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_BINARY = 128 * 1024 * 1024;
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const releaseUrl = (artifact: ReleaseArtifact = releaseArtifact()) => `https://github.com/guohuiyuan/go-music-dl/releases/download/${artifact.version}/${artifact.filename}`;
export async function downloadRelease(artifact: ReleaseArtifact, signal: AbortSignal, downloads = new GithubDownloader()): Promise<Buffer> {
  try {
    return await downloads.download(releaseUrl(artifact), artifact.sha256, signal);
  } catch (error) {
    signal.throwIfAborted();
    const reason = error instanceof Error ? error.name === 'TimeoutError' || error.name === 'AbortError' ? '下载超时' : error.message === 'fetch failed' ? '无法连接 GitHub' : error.message : '连接失败';
    throw new Error(`下载官方 go-music-dl 失败：${reason}`);
  }
}

export async function extractBinary(archive: Buffer, artifact: ReleaseArtifact): Promise<Buffer> {
  if (archive.length > MAX_ARCHIVE || sha256(archive) !== artifact.sha256) throw new Error('官方安装包 SHA-256 校验失败，未执行安装');
  let binary: Buffer | undefined;
  if (artifact.filename.endsWith('.zip')) {
    const files = unzipSync(archive, { filter: entry => {
      if (entry.name !== artifact.binary) return false;
      if (entry.originalSize > MAX_BINARY) throw new Error('安装包中的可执行文件过大');
      return true;
    } });
    if (files[artifact.binary]) binary = Buffer.from(files[artifact.binary]);
  } else {
    const parser = extract();
    parser.on('entry', (header, stream, next) => {
      if (header.name !== artifact.binary) { stream.resume(); stream.on('end', next); return; }
      if (binary || header.type !== 'file' || (header.size ?? 0) > MAX_BINARY) { parser.destroy(new Error('安装包中的可执行文件无效')); return; }
      const chunks: Buffer[] = []; let size = 0;
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BINARY) parser.destroy(new Error('安装包中的可执行文件过大')); else chunks.push(chunk); });
      stream.on('end', () => { binary = Buffer.concat(chunks); next(); });
    });
    await pipeline(Readable.from(archive), createGunzip(), parser);
  }
  if (!binary?.length) throw new Error('官方安装包中未找到预期可执行文件');
  return binary;
}

export interface InstallerOptions { dataDir: string; signal: AbortSignal; artifact?: ReleaseArtifact; download?: typeof downloadRelease; toolName?: 'gomusicdl' | 'uv' }
export async function findInstalledRelease(options: Pick<InstallerOptions, 'dataDir' | 'artifact' | 'toolName'>): Promise<string | null> {
  const artifact = options.artifact ?? releaseArtifact();
  const directory = resolve(options.dataDir, 'tools', options.toolName ?? 'gomusicdl', artifact.version, artifact.filename.replace(/\.(zip|tar\.gz)$/, ''));
  const executable = resolve(directory, artifact.binary.split('/').at(-1)!);
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, 'installed.json'), 'utf8'));
    return manifest.archiveSha256 === artifact.sha256 && manifest.binarySha256 === sha256(await readFile(executable)) ? executable : null;
  } catch { return null; }
}
export const findInstalledGoMusicDl = (dataDir: string) => findInstalledRelease({ dataDir });
export async function installRelease(options: InstallerOptions): Promise<string> {
  const artifact = options.artifact ?? releaseArtifact();
  const directory = resolve(options.dataDir, 'tools', options.toolName ?? 'gomusicdl', artifact.version, artifact.filename.replace(/\.(zip|tar\.gz)$/, ''));
  const executable = resolve(directory, artifact.binary.split('/').at(-1)!); const manifestPath = resolve(directory, 'installed.json');
  const valid = async () => !!await findInstalledRelease({ ...options, artifact });
  if (await valid()) { diagnostics.info('music.install.reused', '复用校验通过的已安装程序', { tool: options.toolName ?? 'gomusicdl', version: artifact.version, executable }); if (process.platform !== 'win32') await chmod(executable, 0o700); return executable; }
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, 'install.lock'); const started = Date.now();
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (!lock) {
    options.signal.throwIfAborted();
    try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await valid()) return executable;
      // A terminated backend must not leave future installs blocked forever.
      try {
        const pid = Number(await readFile(lockPath, 'utf8')); let alive = true;
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
        if (!alive || Date.now() - (await stat(lockPath)).mtimeMs > 240000) { await rm(lockPath, { force: true }); continue; }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      if (Date.now() - started > 190000) throw new Error(`另一个后端正在安装 ${options.toolName ?? 'gomusicdl'}，请稍后重试`);
      await delay(250, undefined, { signal: options.signal });
    }
  }
  const temporary = `${executable}.${process.pid}.tmp`;
  try {
    if (await valid()) return executable;
    const bytes = await extractBinary(await (options.download ?? downloadRelease)(artifact, options.signal), artifact);
    diagnostics.info('music.install.verified', '官方安装包完整校验并解包通过', { tool: options.toolName ?? 'gomusicdl', version: artifact.version, filename: artifact.filename, bytes: bytes.length });
    options.signal.throwIfAborted();
    await writeFile(temporary, bytes, { mode: 0o700 }); await rename(temporary, executable);
    await writeFile(manifestPath, JSON.stringify({ version: artifact.version, archiveSha256: artifact.sha256, binarySha256: sha256(bytes) }), { mode: 0o600 });
    return executable;
  } finally { await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true }); }
}
export async function installGoMusicDl(options: InstallerOptions): Promise<string> { return installRelease(options); }
