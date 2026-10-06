const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { build } = require('esbuild');
const { inject } = require('postject');

const root = path.resolve(__dirname, '..');
const work = path.join(root, '.build');
const release = path.join(root, 'release');
const output = path.join(release, 'windows-x64');
const mpv = { name: 'mpv-x86_64-20261005-git-c152964208.7z',
  url: 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261005/mpv-x86_64-20261005-git-c152964208.7z',
  algorithm: 'sha256', hash: 'ec0e549ce107332f9b0f04f81f2ab7ce1eb23fcab63e65b939bae9dc59dcb3a5' };
const nssm = { name: 'nssm-2.24-101-g897c7ad.zip', url: 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip',
  algorithm: 'sha1', hash: 'ca2f6782a05af85facf9b620e047b01271edd11d' };

async function hash(filename, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
function run(command, args, cwd = root) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${path.basename(command)} 退出码 ${code}`)));
  });
}
async function download(source) {
  const filename = path.join(work, source.name);
  try { if (await hash(filename, source.algorithm) === source.hash) return filename; } catch { /* first build */ }
  console.log(`下载 ${source.name}`);
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(source.url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'Fenghuangming-Agent-Builder' } });
    if (response.status < 500 || attempt === 2) break;
    await response.body?.cancel(); console.log(`官方下载暂不可用，重试 ${source.name}`);
    await new Promise(accept => setTimeout(accept, (attempt + 1) * 1000));
  }
  if (!response.ok || !response.body) throw new Error(`下载失败 ${source.name}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), require('node:fs').createWriteStream(filename + '.tmp'));
  if (await hash(filename + '.tmp', source.algorithm) !== source.hash) throw new Error(`${source.name} 校验失败`);
  await fs.rename(filename + '.tmp', filename);
  return filename;
}
async function files(directory, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), name));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('请使用 Windows x64 的 Node.js 24+ 构建 Windows 发行版');
  }
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe');
  const assets = {};
  const manifest = [];
  async function asset(source, name) {
    const key = `tool:${name}`;
    assets[key] = source;
    manifest.push({ key, path: name, sha256: await hash(source), bytes: (await fs.stat(source)).size });
  }
  for (const [name, source] of [['mpv', mpv], ['nssm', nssm]]) {
    if (name === 'nssm' && process.env.AGENT_NSSM_PATH) {
      const existing = path.resolve(process.env.AGENT_NSSM_PATH);
      if (await hash(existing) !== 'eee9c44c29c2be011f1f1e43bb8c3fca888cb81053022ec5a0060035de16d848') throw new Error('本地 NSSM 文件校验失败');
      await asset(existing, 'nssm.exe');
      continue;
    }
    const archive = await download(source);
    const destination = path.join(work, name);
    await fs.mkdir(destination, { recursive: true });
    await run(tar, ['-xf', archive, '-C', destination]);
    const list = await files(destination);
    if (name === 'mpv') {
      const executable = list.find(file => path.basename(file).toLowerCase() === 'mpv.exe');
      if (!executable) throw new Error('mpv 下载包缺少 mpv.exe');
      const base = path.posix.dirname(executable);
      for (const filename of list.filter(file => file === executable || /\.dll$/i.test(file))) {
        const relative = path.posix.relative(base, filename);
        if (relative.startsWith('../')) throw new Error('mpv 包目录结构不受支持');
        await asset(path.join(destination, filename), `mpv/${relative}`);
      }
    } else {
      const executable = list.find(file => /(^|\/)win64\/nssm\.exe$/i.test(file));
      if (!executable) throw new Error('NSSM 下载包缺少 win64/nssm.exe');
      await asset(path.join(destination, executable), 'nssm.exe');
    }
  }
  for (const name of ['install-agent.ps1', 'uninstall-agent.ps1', 'start-player.ps1', 'desktop-console.ps1']) {
    await asset(path.join(__dirname, name), `scripts/${name}`);
  }
  const manifestFile = path.join(work, 'manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  assets['release-manifest'] = manifestFile;
  console.log('打包 Agent 和内置播放器');
  const mainFile = path.join(work, 'main.cjs');
  await build({ entryPoints: [path.join(root, 'src/main.ts')], outfile: mainFile, bundle: true,
    platform: 'node', target: 'node24', format: 'cjs', minify: true,
    external: ['bufferutil', 'utf-8-validate'], legalComments: 'inline' });
  const blob = path.join(work, 'agent.blob');
  const config = path.join(work, 'sea.json');
  await fs.writeFile(config, JSON.stringify({ main: mainFile, output: blob, assets,
    disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: 'none' }));
  await run(process.execPath, ['--experimental-sea-config', config]);
  const executable = path.join(output, 'fenghuangming-agent.exe');
  await fs.copyFile(process.execPath, executable);
  // A changed binary must not keep the Node distribution's Authenticode signature.
  const binary = await fs.readFile(executable);
  const pe = binary.readUInt32LE(0x3c);
  if (binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 24) !== 0x20b) throw new Error('不支持的 Node 可执行文件格式');
  const security = pe + 24 + 112 + 4 * 8;
  binary.fill(0, security, security + 8);
  await fs.writeFile(executable, binary);
  await inject(executable, 'NODE_SEA_BLOB', await fs.readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
  await run(executable, ['--version']);
  await fs.copyFile(path.join(__dirname, 'release-readme.txt'), path.join(output, 'README.txt'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  const notices = `凤凰鸣 Agent 0.1.4\n\n包含的软件及对应源码：\nNode.js ${process.versions.node}: https://github.com/nodejs/node/tree/v${process.versions.node} (MIT and bundled licenses)\nmpv ${mpv.name}: https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261005 (GPL; see upstream build sources)\nmpv source: https://github.com/mpv-player/mpv/tree/c152964208\nNSSM 2.24-101-g897c7ad: https://nssm.cc/download (public domain; download includes source)\nws: https://github.com/websockets/ws (MIT)\nzod: https://github.com/colinhacks/zod (MIT)\n\n上游下载包校验：\n${mpv.algorithm}: ${mpv.hash}  ${mpv.name}\n${nssm.algorithm}: ${nssm.hash}  ${nssm.name}\n`;
  await fs.writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices, 'utf8');
  const licenses = path.join(output, 'licenses');
  await fs.mkdir(licenses, { recursive: true });
  for (const dependency of ['ws', 'zod']) await fs.copyFile(path.join(root, 'node_modules', dependency, 'LICENSE'), path.join(licenses, `${dependency}.txt`));
  for (const [name, url] of [
    ['node.txt', `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`],
    ['mpv.txt', 'https://raw.githubusercontent.com/mpv-player/mpv/c152964208/LICENSE.GPL'],
  ]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`获取 ${name} 失败: HTTP ${response.status}`);
    await fs.writeFile(path.join(licenses, name), await response.text());
  }
  const archiveName = 'fenghuangming-agent-windows-x64-v0.1.4.zip';
  const archive = path.join(release, archiveName);
  // bsdtar's zip output needs no additional archiver on the build machine.
  await run(tar, ['-a', '-cf', archive, '-C', output, 'fenghuangming-agent.exe', 'README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'licenses']);
  // Keep the previously documented release directory and unversioned download current.
  await fs.cp(output, path.join(release, 'fenghuangming-agent-windows-x64'), { recursive: true });
  await fs.copyFile(archive, path.join(release, 'fenghuangming-agent-windows-x64.zip'));
  const checksums = `${await hash(executable)}  windows-x64/fenghuangming-agent.exe\n${await hash(archive)}  ${archiveName}\n${await hash(archive)}  fenghuangming-agent-windows-x64.zip\n`;
  await fs.writeFile(path.join(release, 'SHA256SUMS.txt'), checksums);
  console.log(`发行包：${archive}\n大小：${((await fs.stat(archive)).size / 1048576).toFixed(1)} MB`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
