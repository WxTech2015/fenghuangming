const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
mkdirSync(resolve(__dirname, '../dist/music'), { recursive: true });
copyFileSync(resolve(__dirname, '../src/music/musicdl-worker.py'), resolve(__dirname, '../dist/music/musicdl-worker.py'));
