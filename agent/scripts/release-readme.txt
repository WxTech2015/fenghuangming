凤凰鸣 Windows Agent 0.1.4 · Windows 10/11 x64

已内置播放器和服务组件，无需安装 Node.js、npm、mpv 或 NSSM。

1. 在网页「群组与设备」创建播放区、绑定 QQ 群、注册设备。
2. 下载设备配置 agent.config.json，放在 fenghuangming-agent.exe 旁边。
3. 在此文件夹打开 PowerShell，以管理员身份执行：

   .\fenghuangming-agent.exe --install --config .\agent.config.json

也可直接填写网站地址和后台生成的设备凭证：

   .\fenghuangming-agent.exe --install --endpoint http://music.example.com --token 设备凭证

安装后自动复制程序到 C:\Program Files\FenghuangmingAgent，配置、日志和缓存默认位于
C:\ProgramData\QQMusicAgent。原安装包可以移走。服务开机启动，播放器在用户登录后启动；
播放用户需要保持登录，锁屏不影响运行。如使用其他管理员账户安装，请加 --user '电脑名\播放用户名'。

临时前台运行：
   .\fenghuangming-agent.exe --config .\agent.config.json
检查服务器和播放器：
   .\fenghuangming-agent.exe --check --config .\agent.config.json
卸载服务与登录任务（管理员 PowerShell）：
   .\fenghuangming-agent.exe --uninstall
更新：在管理员 PowerShell 中先卸载旧服务，再用新程序读取当前配置重新安装：
   .\fenghuangming-agent.exe --uninstall --config 'C:\ProgramData\QQMusicAgent\agent.config.json'
   .\fenghuangming-agent.exe --install --config 'C:\ProgramData\QQMusicAgent\agent.config.json'
自定义数据目录改为实际配置路径。配置和播放缓存会保留。
桌面控制台：安装后双击桌面「凤凰鸣控制台」，或执行：
   .\fenghuangming-agent.exe --console
提供播放总览、下载进度与速度、待播列表、日志、服务器端点和设备凭证配置。
顶部独立显示 Windows 服务是否注册、运行与启动方式，后端连接和播放器状态。
进度条、输入秒数跳转和 −1 秒 / +1 秒按钮按整数秒调整，保留暂停状态。
以播放器实际时长为准，最多跳到末尾前一秒；下载和恢复期间不能跳转。
「立即制动」立即停止播放器并禁止后续播放，离线和重启后仍保持。
只有本机点击「解除制动」才恢复接收新歌曲，不重播已被停止的歌曲。
修改端点后会保持制动，确认新端点连接成功后手动解除。
跟随 Windows 默认扬声器/耳机，使用共享输出模式，记录设备列表和 mpv 退出原因。
mpv 意外退出会自动重启，连接有效且未制动时恢复当前歌曲的位置、音量和暂停状态。
10 秒内连续退出、恢复超时或文件加载失败会报告失败；制动或停止时取消恢复。
本机功能兼容旧后端。网页 1 秒进度控制需同时更新前端、后端及 Agent 0.1.4，无需数据库迁移。
更多参数：
   .\fenghuangming-agent.exe --help

Agent 主动连接服务器，无需公网 IP 或开放 Windows 入站端口。
设备凭证由网页注册设备时生成，不是 NapCat 的 ONEBOT_TOKEN，请勿公开。
