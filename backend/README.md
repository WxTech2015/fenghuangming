# 凤凰鸣后端

此目录可独立部署，包含 Node.js 服务、Prisma 表结构、音源模块、协议源码与测试。需要 Node.js 24+、MySQL 8。配置文件为本目录的 `.env`，运行数据默认放在 `data/`。

宝塔部署步骤和项目填写项见 [部署说明](docs/deployment.md)。在宝塔创建数据库、配置 `.env` 后，在本目录执行：

```bash
npm install --include=dev
npm run build
npm run db:push
```

后台支持 [PyPI 镜像测速](docs/pypi-mirrors.md)、[歌曲预热与并行下载](docs/downloads.md)，并向 Agent 下发桌面待播总览。

随后在宝塔 Node 项目中选择启动脚本 `start`（`npm start`），项目端口 `19988`，实例数量 `1`。通过面板管理运行和日志。

`package.json` 已配置 Prisma 与 esbuild 安装脚本的版本允许名单。出现 `SystemLock` 表不存在时，先执行 `npm run db:push` 初始化当前数据库，再启动项目。

升级到当前版本时也需执行上面的构建与 `db:push`：`MediaAsset` 新增可空的 `source` JSON 字段，保存实际取源方式与平台 ID。旧缓存记录保持兼容，不需要重装 Agent。

部署配置示例：

```dotenv
HOST=127.0.0.1
PORT=19988
STORAGE_DRIVER=mysql
DATABASE_URL=mysql://数据库用户名:数据库密码@127.0.0.1:3306/数据库名
PUBLIC_URL=http://服务器公网IP
COOKIE_SECURE=false
```

`PUBLIC_URL` 填浏览器访问的前端源地址，包含协议和非默认端口，不加路径或末尾斜杠。管理员和凭证使用 `.env` 中的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`ONEBOT_TOKEN`。会话密钥至少 32 字符，NapCat 使用独立密钥。数据库密码包含 URL 特殊字符时，需要编码。

`npm run build` 生成 Prisma 客户端和后端代码；`npm run db:push` 连接数据库建表。部署时保留 `.env`、`data/` 和 MySQL 数据，已有数据的结构更新先备份。接口健康检查为 `/healthz`，NapCat 入口为 `/ws/onebot`，设备入口为 `/ws/agents`。

开发命令：

```bash
npm run dev
npm run typecheck
npm test
```

go-music-dl / musicdl 在管理后台点击「安装」后准备依赖，安装目录位于 `data/tools/`。可选后端环境变量：`AI_API_KEY`、`NETEASE_COOKIE`、`QQ_MUSIC_COOKIE`。

后台「音源与设置」分别提供 GitHub 与 PyPI 测速加速。musicdl 安装时自动选择可用 PyPI 镜像，失败后换源；保存设置或启动后端不会安装。细节见 [音源说明](docs/music-sources.md)，其他候选后端见 [调研](docs/music-alternatives.md)。

GD Studio 可选为首选或加入备用音源，保存后直接使用在线 API，支持网易云、QQ 音乐、酷我；无需安装或填写 Cookie / Key。可选择音质，音频由后端下载缓存后交给 Agent 播放。

`.env` 中 `APP_MODE=production` 默认记录 `info` 及以上日志，隐藏堆栈和追踪 ID；`APP_MODE=debug` 启用详细日志、堆栈和追踪 ID。`LOG_LEVEL`、`LOG_TRACE_ENABLED` 留空时跟随模式，也可分别覆盖。修改后在宝塔重启后端。

解析失败时打开「诊断日志」，粘贴分享链接测试，或查看失败歌曲的日志。日志写入 `data/logs/backend.jsonl`，支持筛选和导出。详见 [诊断说明](docs/diagnostics.md)。
