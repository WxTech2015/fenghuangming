const { copyFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const source = resolve(root, 'backend/src/contracts/index.ts');
for (const folder of ['frontend', 'agent']) {
  const destination = resolve(root, folder, 'src/contracts/index.ts');
  if (!existsSync(destination)) throw new Error(`请在完整源码目录运行：缺少 ${folder}/src/contracts/index.ts`);
  copyFileSync(source, destination);
}
console.log('协议源码已同步到 frontend 和 agent。');
