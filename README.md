# 凤凰鸣 · QQ 群点歌

在指定 QQ 群分享音乐卡片或链接，由对应 Windows 电脑上的 mpv 播放。机器人使用 NapCat 已登录的 QQ 账号，群内发送 `#menu` 查看菜单。

公司：青州正宸电子科技有限公司 · 开发者：晚霞 · 协议：[MIT](LICENSE)

## 三个独立项目

| 目录 | 部署位置 | 内容 |
| --- | --- | --- |
| [frontend](frontend/README.md) | Linux | Vue 3 / Naive UI 网页，构建后由 Nginx 提供 |
| [backend](backend/README.md) | Linux | Node.js / MySQL、NapCat 接入、音源、队列和管理接口 |
| [agent](agent/README.md) | Windows 播放电脑 | 独立 exe，内置 mpv 和 NSSM，一条命令安装 |

三个目录可独立开发和部署。前后端使用 npm 安装和构建，需要 Node.js 24+；单独构建前端也支持 Node.js 22.13+。Linux 服务器通过宝塔安装 MySQL 8 和 Nginx。Windows Agent 使用发行包，无需安装 Node.js；源码打包命令为在 `agent` 目录执行 `npm run package:win`。

## 宝塔部署

完整步骤见 [宝塔部署说明](backend/docs/deployment.md)。前端创建静态网站，后端创建 Node 项目并选择 `start` 启动脚本。默认前后端在同一台 Linux 服务器，Nginx 使用 HTTP 80，后端使用本机 19988：

```text
浏览器 ────────────────→ Nginx / frontend
NapCat ──主动反向 WS───→ Nginx /ws/onebot ──→ backend ──→ MySQL
Agent ───主动 WS───────→ Nginx /ws/agents ──→ backend
Agent ───HTTP 下载音频─→ Nginx /api/        ──→ backend
```

NapCat 仍部署在其原服务器。Windows Agent 不需要公网 IP 或入站端口。HTTP / WS 可以直接使用，SSL 可按需要配置。

后端配置位于 `backend/.env`，运行数据默认写入 `backend/data/`。生产环境使用 MySQL；原文件存储中的业务数据不会自动迁移到 MySQL。

## 本地开发

在根目录安装开发启动器，然后分别安装三个项目：

```powershell
npm install
npm run install:all
npm run dev
```

分别复制前后端的 `.env.example` 为 `.env`。后端开发时设置 `APP_MODE=debug`；本地没有 MySQL 时将 `STORAGE_DRIVER` 设置为 `file`。前端开发地址为 `http://127.0.0.1:5173`。生产构建和测试：

```powershell
npm run build
npm run typecheck
npm test
```

这些根目录命令只方便源码开发，单独部署时直接使用各目录的命令。

## 运行模式与日志

后端 `.env` 使用一个状态控制默认行为：

```dotenv
APP_MODE=production
LOG_LEVEL=
LOG_TRACE_ENABLED=
```

`production` 默认记录 `info` 及以上日志，隐藏堆栈和追踪 ID；`debug` 增加详细日志、堆栈及追踪 ID。后两项留空跟随模式，也可填写日志级别和 `true` / `false` 单独覆盖。修改后从宝塔重启后端，详见 [日志说明](backend/docs/diagnostics.md)。

## 源码发布

根目录执行 `npm run prepare:source`，生成 `fenghuangming-source.zip`，解压后可作为 GitHub 仓库内容。打包只收录代码、文档、测试、示例配置与锁文件；排除真实配置、设备凭证、数据、日志、依赖目录和发行二进制，并检查已知本机凭证是否混入源码。原有配置和部署包保留在本机。

贡献方式见 [CONTRIBUTING](CONTRIBUTING.md)，第三方组件见 [THIRD_PARTY](THIRD_PARTY.md)，检查范围与剩余依赖告警见 [校验记录](backend/docs/verification.md)。

## 功能

- QQ 群与播放区绑定、设备注册、播放队列、歌单、管理员暂停 / 继续 / 切歌 / 音量控制。
- 用户与歌曲黑名单，可作用于全局、群或播放区。
- 每人每日插队次数 `0–999`，按上海日期计算，跨群共享额度。
- 可选 AI 审核歌名、歌手和歌词；审核失败处理方式可配置。
- 原分享链接与平台歌曲 ID 优先；解析、下载或完整音频校验失败后按音源顺序回退。名称搜索默认关闭。
- go-music-dl、musicdl、Meting、api-enhanced、GD Studio 五种音源。go-music-dl 和 musicdl 需在后台点击「安装」；GD Studio 保存配置即可使用。全部音源由后端取源和下载缓存。
- 歌曲提前预热、分段并行下载、传输耗时与速度日志；PyPI 20 个入口测速与安装回退。
- 网页与桌面按 1 秒调整播放进度：拖动、秒数输入、−1 秒 / +1 秒，保留暂停状态。
- Windows Agent 桌面控制台：Windows 服务注册与运行指示器、后端连接、播放器状态、播放与待播总览、下载速度、日志、端点配置和持久化紧急制动；音频输出异常后可从原位置恢复当前歌曲。

常用群指令：`#menu`、`#点歌 <分享链接>`、`#正在播放`、`#队列`、`#我的`、`#插队 [任务编号]`、`#取消 [任务编号]`、`#歌单`、`#切歌`、`#暂停`、`#继续`、`#音量 0-100`。

协议源码以 `backend/src/contracts/index.ts` 为维护入口；修改后在完整源码根目录运行 `npm run sync:contracts`，更新前端与 Agent 内置副本，各项目运行时不依赖其他目录。

- [架构说明](backend/docs/architecture.md)
- [Agent 协议](backend/docs/agent-protocol.md)
- [音源方案](backend/docs/music-sources.md)
- [PyPI 镜像目录](backend/docs/pypi-mirrors.md)
- [预热与下载](backend/docs/downloads.md)
- [全项目校验记录](backend/docs/verification.md)
- [复用调研](backend/docs/reuse-research.md)
