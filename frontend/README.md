# 凤凰鸣前端

此目录可独立安装和构建，包含 Vue 3 / Naive UI 管理网页与本地协议源码。需要 Node.js 22.13+，宝塔服务器统一使用 Node.js 24 即可。

在本目录执行，Windows 和 Linux 均使用相同命令：

```bash
npm install --include=dev
npm run build
```

在宝塔创建静态网站，网站目录指向生成的 `dist/`。也可以在 Windows 构建，再把 `dist/` 上传到网站目录。网站的 API / WebSocket 转发配置见 [宝塔部署说明](../backend/docs/deployment.md)。

生产 API 使用网站同源地址；后端 `PUBLIC_URL` 填该网站实际访问地址。NapCat 连接 `ws://网站地址/ws/onebot`，Agent 的 `serverUrl` 填 `http://网站地址`。

本地开发执行 `npm run dev`，打开 `http://127.0.0.1:5173`。默认开发代理连接 `http://127.0.0.1:19988`，可复制 `.env.example` 为 `.env`，在 `VITE_API_PROXY_TARGET` 修改，前端独立读取配置。

「音源与设置」可配置预热数量、预热并发、单首下载连接数，查看 20 个 PyPI 入口的测速结果；队列显示预热状态。更新时上传整个 `dist/`，与对应后端版本一起使用。

播放页提供按 1 秒拖动的进度条、秒数输入和「−1 秒 / +1 秒」。跳转需要对应后端和 Agent 0.1.4，旧 Agent 会显示升级提示；播放器实际时长决定可调范围，断线、下载或恢复期间禁用跳转。已暂停的歌曲调整后仍保持暂停。
