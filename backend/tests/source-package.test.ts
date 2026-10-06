import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, expect, test } from 'vitest';

const { createSourcePackage, collectFiles, assertClean } = require('../scripts/source-package.cjs');
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fenghuangming-source-test-')); roots.push(root);
  for (const name of ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY.md', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json']) await writeFile(join(root, name), name);
  await mkdir(join(root, 'backend/src'), { recursive: true }); await mkdir(join(root, 'agent/release'), { recursive: true });
  await writeFile(join(root, 'backend/src/example.ts'), 'export const value = 1;');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'fenghuangming-source-test-')) throw new Error('测试清理目录不正确');
    await rm(root, { recursive: true, force: true });
  }
});
test('源码包仅收录公开文件并保存哈希清单', async () => {
  const root = await fixture();
  await writeFile(join(root, 'backend/.env'), 'SESSION_SECRET=' + randomBytes(32).toString('hex'));
  await writeFile(join(root, 'backend/.env.example'), 'APP_MODE=production');
  await writeFile(join(root, 'backend/src/agent.config.json'), '{"token":"private"}');
  await writeFile(join(root, 'backend/src/debug.log'), 'private logs');
  await writeFile(join(root, 'agent/release/old.exe'), 'binary');
  const result = createSourcePackage(root); const files = unzipSync(readFileSync(result.filename));
  expect(Object.keys(files)).toContain('fenghuangming/backend/.env.example');
  expect(Object.keys(files).some(name => /\/\.env$|agent\.config\.json|debug\.log|old\.exe/.test(name))).toBe(false);
  const manifest = JSON.parse(Buffer.from(files['fenghuangming/SOURCE_MANIFEST.json']!).toString());
  expect(manifest.files.find((file: any) => file.path === 'backend/src/example.ts').sha256).toMatch(/^[a-f0-9]{64}$/);
});
test('本机凭证混入代码时拒绝发布且不回显凭证', async () => {
  const root = await fixture(); const secret = randomBytes(32).toString('hex');
  await writeFile(join(root, 'backend/.env'), `SESSION_SECRET=${secret}`);
  await writeFile(join(root, 'backend/src/example.ts'), `export const secret = '${secret}';`);
  try { createSourcePackage(root); throw new Error('没有拒绝发布'); } catch (error) {
    expect((error as Error).message).toContain('backend/src/example.ts'); expect((error as Error).message).not.toContain(secret);
  }
});
test('常见私钥与 Token 格式拒绝发布', () => {
  for (const text of [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'ghp_' + 'A'.repeat(36)]) expect(() => assertClean('source.ts', Buffer.from(text), [])).toThrow('source.ts');
});
test('发布目录拒绝符号链接', async () => {
  const root = await fixture(); await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(root, 'backend/src/link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => collectFiles(root)).toThrow('符号链接');
});
