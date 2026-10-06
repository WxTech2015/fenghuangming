const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync, unzipSync } = require('fflate');

// 发布清单不依赖 .gitignore，避免将本机配置与历史发行包带入源码。
const rootFiles = ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY.md', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json'];
const projectFiles = ['README.md', 'LICENSE', '.gitignore', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.mts', 'vite.config.ts', 'index.html', 'agent.config.example.json', 'agent.config.public.example.json'];
const directories = ['.github', 'backend/src', 'backend/tests', 'backend/docs', 'backend/scripts', 'backend/prisma', 'frontend/src', 'agent/src', 'agent/tests', 'agent/scripts', 'agent/docs'];
const blocked = new Set(['node_modules', 'dist', 'release', '.build', '.git', '.codex', '.agents', 'data', 'logs', 'coverage', '__pycache__']);
const extensions = new Set(['.ts', '.mts', '.vue', '.css', '.json', '.cjs', '.py', '.md', '.txt', '.ps1', '.prisma', '.yml', '.yaml']);

function allowed(relative) {
  const parts = relative.split('/'); const name = parts.at(-1);
  if (parts.some(part => blocked.has(part)) || name === 'agent.config.json' || name.startsWith('.env') && name !== '.env.example') return false;
  return extensions.has(path.posix.extname(name)) || name === '.env.example';
}
function collectFiles(root) {
  root = path.resolve(root);
  const result = [];
  for (const project of ['backend', 'frontend', 'agent']) {
    const directory = path.resolve(root, project);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${project}`);
  }
  function add(relative, required = false) {
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) throw new Error('发布路径超出项目目录');
    if (!fs.existsSync(filename)) { if (required) throw new Error(`缺少发布文件：${relative}`); return; }
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${relative}`);
    if (stat.isFile()) result.push(relative);
  }
  function walk(relative) {
    for (const item of fs.readdirSync(path.resolve(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (blocked.has(item.name)) continue;
      if (item.isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${name}`);
      if (item.isDirectory()) walk(name);
      else if (item.isFile() && allowed(name)) add(name);
    }
  }
  for (const file of rootFiles) add(file, true);
  for (const project of ['backend', 'frontend', 'agent']) for (const file of projectFiles) add(`${project}/${file}`);
  for (const directory of directories) {
    const filename = path.resolve(root, directory);
    if (!fs.existsSync(filename)) continue;
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${directory}`);
    walk(directory);
  }
  return [...new Set(result)].sort();
}
function localSecrets(root) {
  const values = new Set();
  function add(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 8 && !/^(test[-_]|fixture[-_]|example|replace-with|dev-password-change-me|change-me|从后台)/i.test(trimmed) && !trimmed.includes('change-me')) values.add(trimmed);
  }
  for (const project of ['', 'backend', 'frontend', 'agent']) {
    const filename = path.resolve(root, project, '.env');
    if (!fs.existsSync(filename)) continue;
    for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
      if (!match || !/password|secret|token|cookie|api_?key|database_url/i.test(match[1])) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2'); add(value);
      if (match[1] === 'DATABASE_URL') { try { add(decodeURIComponent(new URL(value).password)); } catch { /* 非 URL 配置 */ } }
      if (/cookie/i.test(match[1])) for (const pair of value.split(';')) add(pair.slice(pair.indexOf('=') + 1));
    }
  }
  function configs(relative) {
    const directory = path.resolve(root, relative); if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory() && !['node_modules', 'dist', '.build', '.git', 'data'].includes(item.name)) configs(`${relative}/${item.name}`);
      else if (item.isFile() && item.name === 'agent.config.json') {
        const config = JSON.parse(fs.readFileSync(path.resolve(directory, item.name), 'utf8').replace(/^\uFEFF/, ''));
        add(config.token); add(config.ipcSecret);
      }
    }
  }
  configs('agent'); return [...values];
}
function assertClean(relative, content, secrets) {
  const text = content.toString('utf8');
  // 只报告文件名，不在终端回显命中的凭证。
  if (secrets.some(secret => text.includes(secret)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(text)) throw new Error(`发布文件疑似包含凭证：${relative}`);
}
function createSourcePackage(root) {
  root = path.resolve(root);
  const files = collectFiles(root); const secrets = localSecrets(root); const entries = {}; const manifest = [];
  for (const relative of files) {
    const content = fs.readFileSync(path.resolve(root, relative)); assertClean(relative, content, secrets);
    entries[`fenghuangming/${relative}`] = content;
    manifest.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  entries['fenghuangming/SOURCE_MANIFEST.json'] = Buffer.from(JSON.stringify({ files: manifest }, null, 2) + '\n');
  const archive = zipSync(entries, { level: 6 }); const checked = unzipSync(archive);
  for (const [name, content] of Object.entries(entries)) if (!Buffer.from(checked[name] || []).equals(content)) throw new Error('源码压缩包完整性校验失败');
  const filename = path.resolve(root, 'fenghuangming-source.zip'); fs.writeFileSync(filename, archive);
  return { filename, files: files.length, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
}
module.exports = { collectFiles, assertClean, createSourcePackage };
if (require.main === module) {
  try { const result = createSourcePackage(path.resolve(__dirname, '../..')); console.log(`源码包：${result.filename}\n文件：${result.files}，大小：${result.bytes} 字节\nSHA-256：${result.sha256}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
