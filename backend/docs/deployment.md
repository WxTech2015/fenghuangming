# 宝塔部署：Linux 前后端 + Windows Agent

前后端上传到宝塔所在的 Linux 服务器，Agent 发行包放在 Windows 播放电脑，NapCat 使用现有服务器。前后端使用 npm，Windows Agent 无需安装 Node.js。

## 1. 准备

在「软件商店」安装 Nginx、MySQL 8、Node.js 版本管理器，在版本管理器安装 Node.js 24，并将项目版本和命令行版本都选为 24。

通过「文件」上传 `frontend/` 和 `backend/`，下面按实际后端目录 `/www/wwwroot/fenghuangming/backend` 举例。上传时排除 Windows 上的 `node_modules/`、`dist/` 和依赖缓存。更新已有项目时保留服务器上的 `.env`、`data/` 和数据库。

## 2. 后端

在「数据库」添加 MySQL 数据库，记录数据库名、用户名和密码。在「文件」打开 `backend/.env`；首次部署可复制 `.env.example` 为 `.env`。保留已经填好的管理员密码、会话密钥和 NapCat 密钥，调整部署项：

```dotenv
HOST=127.0.0.1
PORT=19988
STORAGE_DRIVER=mysql
DATABASE_URL=mysql://数据库用户名:数据库密码@127.0.0.1:3306/数据库名
PUBLIC_URL=http://music.example.com
COOKIE_SECURE=false
DATA_DIR=./data
```

`PUBLIC_URL` 填浏览器打开的前端地址，包含协议和非默认端口，不带路径或末尾斜杠。使用域名时填写域名；HTTP 无需证书。数据库密码里的 URL 特殊字符需要编码。

在宝塔终端进入 `/www/wwwroot/fenghuangming/backend`，依次执行安装、构建和建表命令：

```bash
npm install --include=dev
npm run build
npm run db:push
```

安装需要保留开发依赖，因为 TypeScript 和 Prisma 构建工具在开发依赖中。构建生成 `dist/main.js` 和 Prisma 客户端；建表命令连接 `.env` 指定的数据库。首次使用空数据库执行即可；已有数据库发生结构变化时，先备份并确认命令提示。

项目的 `package.json` 已记录所需 Prisma 与 esbuild 版本的 `allowScripts`。已有安装出现未覆盖脚本的提示时，可以在当前后端目录执行 `npm install-scripts approve @prisma/client @prisma/engines esbuild prisma`；若之前脚本被跳过，再执行 `npm rebuild @prisma/client @prisma/engines esbuild prisma`。命令说明见 [npm 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)。

完成后在「网站 → Node 项目」添加或修改项目：

| 配置项 | 填写 |
| --- | --- |
| 项目目录 | `/www/wwwroot/fenghuangming/backend` |
| Node 版本 | `24` |
| 运行方式 / 启动脚本 | `start`，对应 `npm start` |
| 自定义启动命令（若界面采用此方式） | `npm start` |
| 项目端口 | `19988` |
| 实例数量 | `1` |
| 运行用户 | `www`，该用户需能读取 `.env` 并写入 `backend/data/` |

如果管理器使用「启动文件」，选择 `backend/dist/main.js`，工作目录设为 `backend`。选择当前管理器提供的一种启动方式即可。通过面板启动、停止、重启和查看项目日志。

## 3. 前端网站

在宝塔终端进入 `frontend` 目录执行：

```bash
npm install --include=dev
npm run build
```

也可以在 Windows 构建后只上传生成的 `dist/`。在宝塔添加静态网站，绑定公网 IP 或域名，网站目录指向实际的 `frontend/dist`。使用自定义 HTTP 端口时，同时在宝塔和云安全组放行该端口。

进入静态网站 `music.example.com` 的「设置 → 伪静态」，选择自定义，将内容替换为下面的路由。也可以放在「配置文件」的 `server { ... }` 内；两个位置选择一个，同一 `location` 只保留一份。

```nginx
location / {
    try_files $uri $uri/ /index.html;
}

location ^~ /api/ {
    proxy_pass http://127.0.0.1:19988;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache off;
    proxy_buffering off;
    proxy_read_timeout 120s;
}

location ^~ /ws/ {
    proxy_pass http://127.0.0.1:19988;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}

location = /healthz {
    proxy_pass http://127.0.0.1:19988;
    proxy_set_header Host $http_host;
}
```

`proxy_pass http://127.0.0.1:19988;` 的地址末尾不加 `/`，以保留 `/api/v1/...` 路径。这里同时处理 Vue 网页路由、API、SSE 和 WebSocket；仅设置网页回退无法修复接口的 404。

先在宝塔终端执行 `curl http://127.0.0.1:19988/healthz` 确认后端返回 `ok: true`。保存配置后通过宝塔重载 Nginx，再打开 `http://music.example.com/healthz`，应返回同样的 JSON。未登录访问 `/api/v1/snapshot` 返回 401，登录后返回 200，说明请求已经进入后端。网页、API、音频和 WebSocket 共用这个网站地址；后端与 MySQL 使用本机连接。

## 4. NapCat 与 Agent

NapCat 的 OneBot v11 网络配置使用 WebSocket 客户端 / 反向 WebSocket：

| 配置项 | 值 |
| --- | --- |
| 地址 | `ws://网站地址/ws/onebot` |
| Token | `backend/.env` 的 `ONEBOT_TOKEN`，填写密钥本身 |
| 消息格式 | `array` |
| 上报自身消息 | 关闭 |

启用后后台会读取 NapCat 已登录的 QQ 号和群。在后台创建播放区，把 QQ 群绑定到播放区，注册设备并下载 Agent 配置。

Windows 解压 Agent 发行包，将下载的 `agent.config.json` 放在 `fenghuangming-agent.exe` 旁边。`serverUrl` 填 `http://网站地址`，`mpvPath` 保持 `auto` 使用内置播放器。在该目录的管理员 PowerShell 执行：

```powershell
.\fenghuangming-agent.exe --install --config .\agent.config.json
```

也可复制后台注册设备后提供的安装命令。程序自动配置 NSSM 服务和用户登录任务，无需另装 Node.js、mpv 或 NSSM。Agent 主动连接，无需公网 IP，播放用户需要保持登录；源码与详细维护步骤见独立的 [Agent 仓库](https://github.com/WxTech2015/fenghuangming-agent#readme)。

在「音源与设置」选择 GitHub 下载方式并保存，默认自动测速选择节点，然后点击安装需要的 go-music-dl / musicdl；Meting 与 api-enhanced 随后端 Node 依赖安装。群里发送 `#menu`、音乐卡片或链接验证。

## 常见问题

- 依赖安装停在 npm 警告：警告本身不代表失败。在 `backend` 目录执行 `npm install --include=dev --loglevel verbose` 查看最后处理的包或下载地址，以实际退出结果判断安装状态。
- `Unknown global config "--init.module"`：检查宝塔当前 Node 版本的 npm 环境变量配置。该警告来自 npm 配置，项目没有此项；需要清理时删除对应配置行。
- `{x-http-token:...}: 未找到命令`：Shell 把这段内容当成命令执行了。如果它来自自定义命令或前置命令栏，删除该栏中的 HTTP 请求头内容，启动命令填写 `npm start`。
- `Unsupported URL Type "link:"`：服务器还在使用旧版源码，重新上传当前后端的 `package.json`、锁文件和 `src/` 后再安装。
- `dist/main.js` 不存在：先完成 `npm run build`，再从面板启动。
- `The table SystemLock does not exist`：当前数据库缺少项目表结构。在后端目录执行 `npm run db:push`，确认建表成功后从面板启动 `start`。如果已经执行过，核对 `.env` 的 `DATABASE_URL` 是否指向刚初始化的数据库。
- 启动日志显示 `dev`、`tsc --watch`：在 Node 项目把运行脚本改选 `start`，项目通过 `npm run build` 构建后运行。
- 502：查看 Node 项目日志，检查后端已启动且代理端口与 `PORT` 相同。
- 接口返回 Nginx 的 HTML 404：检查当前域名网站中的 `/api/`、`/ws/`、`/healthz` 转发是否已保存并生效。
- 登录来源校验失败：核对 `PUBLIC_URL` 与浏览器地址的协议、域名/IP、端口完全一致。
- NapCat 未连接：核对 `/ws/onebot`、WebSocket 转发和 `ONEBOT_TOKEN`。

后端更新后重新安装、构建，按数据库变更需要执行建表命令，然后在 Node 项目里重启；前端更新后重新构建网站文件。

宝塔官方参考：[Node.js 版本管理器与项目部署](https://www.bt.cn/bbs/thread-75284-1-1.html)。
