# 凤凰鸣 Windows Agent

Windows 10/11 x64 使用发行包 `fenghuangming-agent-windows-x64-v0.1.4.zip`，解压即可。已内置运行时、mpv、NSSM 和桌面控制台，播放电脑无需安装 Node.js、npm 或其他组件。

## 安装

在网页「群组与设备」创建播放区、绑定 QQ 群、注册设备。将下载的 `agent.config.json` 放在 `fenghuangming-agent.exe` 旁边，在该文件夹打开管理员 PowerShell：

```powershell
.\fenghuangming-agent.exe --install --config .\agent.config.json
```

也可以复制后台提供的安装命令，或直接填写网站地址和设备凭证：

```powershell
.\fenghuangming-agent.exe --install --endpoint http://music.example.com --token '后台生成的设备凭证'
```

设备凭证在注册时仅显示一次，与 NapCat 的 `ONEBOT_TOKEN` 不同。HTTP / HTTPS 均支持，填写网站根地址，不加 `/ws/agents`。默认 `mpvPath: "auto"` 使用内置播放器，也可通过 `--mpv 'C:\路径\mpv.exe'` 指定自己的播放器。

安装将程序复制到 `C:\Program Files\FenghuangmingAgent`，原安装包可以移走。配置、日志和缓存默认位于 `C:\ProgramData\QQMusicAgent`，可以通过配置或 `--data-dir` 修改。

联网服务 `QQMusicAgent` 以 LocalService 开机启动；计划任务 `QQMusicAgent-Player` 在指定用户登录后启动播放器。如果使用其他管理员账户安装，加上 `--user '电脑名\播放用户名'`。播放用户需要保持登录，锁屏可以继续播放。后台设备显示「就绪」后即可点歌。

Agent 主动连接服务器并下载音频，不需要公网 IP 或开放入站端口。所有音源解析、下载器都运行在后端，Agent 只负责接收和播放。

## 运行与维护

安装后双击桌面「凤凰鸣控制台」。也可执行：

```powershell
.\fenghuangming-agent.exe --console
```

控制台提供服务器连接、播放器就绪状态、当前歌曲、进度、下载速度、待播列表、暂停 / 继续 / 音量、四个运行日志和端点配置。进度条、输入秒数跳转和「−1 秒 / +1 秒」均按整数秒调整，保留暂停状态；可用范围为 0 到歌曲末尾前一秒，以 mpv 实际读出的时长为准。下载或播放器恢复期间不能调整进度。服务器端升级后会下发待播列表；旧后端仍能播放。端点填写网站根地址，设备凭证留空保持原值，修改后自动重连并保持制动，确认后手动解除。

红色「立即制动」会取消下载、停止本机 mpv，并持久化禁止后续播放。网络断开、服务或电脑重启后仍保持，必须在本机控制台点击「解除制动」；解除不会重播被停止的歌曲。播放器停止请求未及时响应时终止本机播放器。服务暂时不可访问时，桌面控制台仍可写入制动锁并终止本设备的 mpv。制动会通过未就绪状态通知后端，后续待播歌曲保持排队。

控制台只访问随机端口的 `127.0.0.1` 本机接口，使用数据目录的 IPC 凭证认证，不开放公网管理端口。日志展示自动脱敏，不显示设备凭证。

顶部三个指示器分别显示 Windows 服务、后端连接和本机播放器。服务指示器每 5 秒读取 Windows 的 `QQMusicAgent`，显示未注册、运行中、已停止、正在启动或正在停止，并注明开机 / 手动启动或禁用；它与后端在线状态独立。前台运行时可以未注册服务，但仍能连接和播放。播放器指示器区分未就绪、播放、暂停、恢复与制动。

网页播放页也提供整数秒进度条、秒数输入和「−1 秒 / +1 秒」。需要同时更新前端、后端及 Agent 0.1.4；无需数据库结构迁移。旧 Agent 继续播放，网页会提示升级后再调整进度。跳转绑定当前播放任务，换歌、断线、未就绪或制动时拒绝旧操作；在网页跳转仍保留暂停状态。

临时前台运行，无需管理员权限或安装服务：

```powershell
.\fenghuangming-agent.exe --config .\agent.config.json
```

检查服务器和内置播放器：

```powershell
.\fenghuangming-agent.exe --check --config .\agent.config.json
```

该检查验证健康接口和播放器程序；设备凭证是否有效，以运行后的后台连接状态为准。联网日志为数据目录中的 `service.log`、`service-error.log`，播放器日志为 `player.log`、`player-error.log`。后台区分「离线」「已连接，播放器未就绪」「就绪」。

「已连接，播放器未就绪」表示网络服务在线，但用户会话播放器未报告可播放。检查播放用户是否登录、控制台是否制动，以及 `player-error.log`。mpv 跟随 Windows 默认音频输出，使用共享模式；日志记录音频设备列表、输出驱动、原生错误与退出码。意外退出或音频输出初始化失败时自动重启。已开始播放且连接租约有效的歌曲从本机缓存恢复到原位置，保留音量和暂停状态；恢复期间显示「正在恢复音频播放」。10 秒内再次退出、加载失败或恢复超时则报告失败，防止反复重播；普通音频解码错误也会报告失败。停止、制动、失去连接租约会取消恢复，解除制动不会恢复旧歌。本机进度控制与恢复功能兼容旧后端；网页进度控制使用 0.1.4 新增能力。音频缓存下载对 2 MiB 以上文件采用四路分段，范围响应不正确时取消分段并回退单连接，完整 SHA-256 校验后才允许播放。

卸载服务与登录任务，在管理员 PowerShell 执行：

```powershell
.\fenghuangming-agent.exe --uninstall
```

卸载保留配置、日志和缓存。更新时先卸载，再用新程序安装，明确指定当前数据目录中的配置：

```powershell
.\fenghuangming-agent.exe --uninstall --config 'C:\ProgramData\QQMusicAgent\agent.config.json'
.\fenghuangming-agent.exe --install --config 'C:\ProgramData\QQMusicAgent\agent.config.json'
```

以上命令在管理员 PowerShell 中执行。自定义数据目录时改为实际配置路径；播放用户不同于安装管理员时，安装命令补 `--user '电脑名\播放用户名'`。

其他参数见 `--help`。也可以用 `FENGHUANGMING_SERVER`、`FENGHUANGMING_TOKEN` 环境变量提供地址与设备凭证。配置优先级：命令行参数、环境变量、配置文件。指定 `--config` 时读取该文件；地址和凭证都已由参数或环境变量提供时，直接使用，不读取其他设备的配置。否则指定 `--data-dir` 时从该目录读取配置，默认先读取程序旁的配置，再读取默认数据目录的配置。

## 源码开发与打包

仅开发电脑需要 Node.js 24+：

```powershell
cd agent
npm install --include=dev
npm run typecheck
npm test
npm run package:win
npm run test:package
```

Windows x64 构建使用 Node.js SEA，自动获取固定版本、经过校验的 mpv 和 NSSM，输出到 `release/`，附带校验和与第三方软件说明。打包工具不安装系统服务，`test:package` 使用本机临时测试服务器验证独立程序。

源码运行可执行 `npm run build`、`npm start -- --config .\agent.config.json`，此方式需要自行填写已安装 mpv 的绝对路径。源码安装脚本仍支持 `-NodePath` 与 `-NssmPath`，发行版通过 `--install` 自动处理。
