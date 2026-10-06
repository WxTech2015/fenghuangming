# 参与开发

三个项目独立安装，统一使用 Node.js 24 和 npm。首次运行：

```bash
npm ci
npm --prefix backend ci --include=dev
npm --prefix frontend ci --include=dev
npm --prefix agent ci --include=dev
```

开发前复制 `.env.example` 为 `.env`。后端本地开发设置 `APP_MODE=debug`，没有 MySQL 时使用 `STORAGE_DRIVER=file`。服务连接测试需要独立的 NapCat 账号与设备凭证。

修改共享协议后执行 `npm run sync:contracts`，同时提交三个副本。音源实现放在 `backend/src/music/`，下载与缓存放在 `backend/src/media/`，业务规则放在队列和策略模块，设备播放放在 `agent/src/`。

提交前运行：

```bash
npm run typecheck
npm run build
npm test
python backend/tests/musicdl-worker.test.py
```

Python 测试使用 Python 3.10+ 的标准库，不需要安装 musicdl。Windows 发行包还需在 `agent/` 执行 `npm run package:win` 和 `npm run test:package`；验证工具不会安装系统服务。

问题反馈附版本、系统、触发步骤和脱敏日志。音源问题附公开分享链接与平台名称，勿提交 Cookie、设备凭证、数据库密码或私人群消息。涉及数据库结构的修改需说明兼容方式；真实声卡与第三方平台可用性需在目标环境验证。

项目源码采用 MIT 协议，贡献代码沿用该协议；第三方组件保留各自许可证。
