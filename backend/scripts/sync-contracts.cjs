const { copyFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const source = resolve(root, 'backend/src/contracts/index.ts');
for (const folder of ['frontend']) {
  const destination = resolve(root, folder, 'src/contracts/index.ts');
  if (!existsSync(destination)) throw new Error(`请在前后端仓库根目录运行：缺少 ${folder}/src/contracts/index.ts`);
  copyFileSync(source, destination);
}
console.log('协议源码已同步到 frontend。Agent 仓库的协议副本需单独更新。');
