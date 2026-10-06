# 音源后端与自动部署

更新日期：2026-10-05。已集成 go-music-dl、musicdl、api-enhanced、Meting 和 GD Studio。UNM 不作为可选音源；旧 UNM 队列及配置迁移到 go-music-dl，新音源的设置和顺序会保留。

## 原链接优先

1. 卡片 / 分享链接保留原平台、原歌曲 ID、分享地址及可识别的原音频地址。QQ 数字 songid 通过详情接口转为同一歌曲的 songmid；先扩展短链接，扩展失败但有歌名、歌手的卡片保留原链接等待回退。
2. 优先尝试卡片内同平台音频地址；网易云尝试原 ID 的外链，QQ 使用原歌曲详情和 vkey 取音频。其他平台的原分享页尚未统一实现直接取音频，由下面的适配器继续按原 ID 处理。
3. 下载并校验真实音频格式、大小、时长及是否为试听片段。原链接成功后立即使用，不调用任何备用 Provider 或名称搜索。
4. 原链接解析失败、下载失败、返回网页或试听片段，才依次调用首选备用音源及保存的备用顺序。所有 Provider 先按原平台 ID 取源。
5. 名称搜索为独立开关，默认关闭。开启后仅在上述路径全失败时搜索同平台，完整歌名（含 Live / 翻唱等版本信息）和全部歌手必须一致，已知时长需在 5 秒或 3% 内，实际下载时再次核对。信息不足时停止，不直接取搜索的第一条。

命中缓存和取源成功前都会检查原请求及实际返回歌曲 ID 的黑名单。缓存记录实际音源、匹配方式和平台 ID，活动记录显示 `audio.source`。音频地址、Cookie 和临时凭证不进入网页快照。切换关闭名称搜索后，不复用通过名称搜索取得的缓存。

## 当前实现

[go-music-dl](https://github.com/guohuiyuan/go-music-dl) 提供多平台解析和音频下载，官方 CLI 发行包可直接运行。后端管理固定的 [v1.1.1](https://github.com/guohuiyuan/go-music-dl/releases/tag/v1.1.1)，无需 Go 编译环境。首次显示「未安装」，只有管理员在后台点击「安装」才下载程序；后端启动、保存配置、重启和取源只检查已有安装，不自动下载或修复。

- 安装模块选择操作系统对应的官方包，验证固定 SHA-256，只提取预期的 music-dl 可执行文件，保存安装记录。并发安装共享锁，已安装文件通过校验后复用。
- 进程模块使用官方桌面服务模式，只监听后端本机，不打开浏览器。等待 /music/healthz 返回 app=go-music-dl、status=ok 后提供音源接口。
- 下载适配器调用 /music/download?stream=1，传入原平台歌曲 ID、歌名、歌手和专辑。上游返回音频字节，项目统一验证并缓存。
- 外部模式使用管理员保存的 /music 地址，不下载程序、不启动子进程。该服务须允许后端调用。
- 运行状态通过后台快照与 SSE 更新；安装失败显示原因并允许重试，意外退出最多自动重启三次。切换外部模式或关闭后端会关闭受管理的进程。

配置入口在「音源与设置」。默认 managed；已有部署选择 external。安装和配置文件放在 DATA_DIR/tools/gomusicdl/。播放电脑只运行 Agent、用户会话播放器及 mpv。

## GitHub 下载加速

「音源与设置 → GitHub 下载加速」内置 [NapCatQQ 的 44 个 Release 文件镜像](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-common/src/mirror.ts)，另有 GitHub 直连。列表核对日期为 2026-10-05，后续上游节点变动需要更新项目列表。

默认自动选择。点击安装时，后端先以实际固定版本安装包做 64 KiB Range 抽样，测首字节延迟和包含连接时间的抽样速度；最多同时测试 8 个节点，单节点 3 秒超时，结果缓存 30 分钟。可用节点按抽样速度排序，同速时按延迟选择；网页可以查看结果和点击「重新测速」。该速度仅供节点排序，不等于持续下载速度。

可以选择 GitHub 直连（不测速、不请求镜像），或指定内置优先节点；指定节点下载失败后尝试其他可用节点和直连。下载失败、返回 HTML、安装包超限或 SHA-256 不符时自动切换。完整下载及回退共用 3 分钟上限，只有固定 SHA-256 校验成功才进入解包和安装。

这套下载器同时用于 go-music-dl 和 musicdl 的 uv 引导程序。下载托管 Python 时复用已选 GitHub 节点，失败后尝试官方源；用户显式设置的 `UV_PYTHON_INSTALL_MIRROR` 优先。后端启动和保存配置不测速、不自动安装；主动测速只下载片段，不执行程序。配置保存到现有设置 JSON，无需新增数据库表。

## PyPI 下载加速

「音源与设置 → PyPI 下载加速」提供自动测速、官方源、指定优先镜像。内置 20 个 HTTPS 入口，包括官方、教育网和云厂商，完整地址与转发关系见 [镜像目录](pypi-mirrors.md)。自动模式在管理员点击 musicdl「安装 / 重试安装」后测速；也可单独点击「重新测速」。支持 HTML / JSON 索引及受限 HTTPS 重定向，索引和文件阶段各最多 15 秒，同时检测 4 个入口。固定 `musicdl==2.14.0` wheel 最多抽样 64 KiB，检查版本、文件签名和下载范围。成功结果缓存 30 分钟，全失败缓存 1 分钟；延迟包含索引和 wheel 首字节等待，速度用于排序，网页逐项显示进度和失败阶段。

安装先使用最快可用镜像；指定模式先尝试选定镜像。镜像依赖未同步、超时或安装失败时换到其他镜像，抽样失败但索引可达时仍允许尝试安装，最后尝试官方源。官方模式仅访问官方源，不测速。每次依赖安装尝试最长 5 分钟，整个镜像轮换最多 15 分钟；失败保留已下载内容。只修改本次 uv 子进程的索引参数，不修改系统 pip、npm 或用户配置。

安装失败可从音源状态和 `python.prepare.*` / `pypi.*` 日志查看失败步骤与原因；子进程末尾输出经过脱敏，同时保留 `DATA_DIR/tools/musicdl/2.14.0/prepare.log`。PyPI 测速成功只证明固定包可访问，Python 下载、其他依赖和歌曲解析分别判断。

当前卡片解析接入网易云、QQ、酷狗、酷我、咪咕和基础波点链接。go-music-dl 暂不支持波点，该平台需要 musicdl。自动安装不代表所有平台歌曲一定可下载，音源取决于平台接口、账号状态和网络；失败仍展示在队列中。

## 其他音源适配器

| 后端 | 官方能力与形态 | 本项目接入方式 |
| --- | --- | --- |
| [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl) | Python 多平台客户端 | 固定 2.14.0，通过 Python JSONL Worker 调用原 ID 解析与可选搜索，支持本项目六个平台 |
| [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | 网易云 Node API | 固定 npm 4.41.0，原生 v1 取源依次请求 lossless、exhigh、standard；v1 请求全部异常时兼容原生 `song_url`；支持网易云 |
| [Meting](https://github.com/metowolf/Meting) | Node 统一多平台 API | 固定 npm `@meting/core` 1.6.1，支持本项目的网易云、QQ、酷狗、酷我；不把不支持的平台自动当网易云处理 |
| [GD Studio / GD 音乐台](https://music-api.gdstudio.xyz/api.php) | 在线多平台 API | 直接从后端按原 ID 请求官方 API，支持网易云、QQ 音乐、酷我；无需安装、Cookie 或 API Key |

Meting 与 api-enhanced 通过项目的 `npm install` 一起安装，运行在可终止的 Node Worker 里，无需额外 HTTP 端口。默认备用顺序是 go-music-dl → Meting → api-enhanced；原链接始终优先。可以在后台更换首选、添加 / 移除备用源、调整顺序和重启。

GD Studio 可在「首选备用音源」选择，或加入「继续尝试的音源」并调整顺序。保存后直接启用，没有安装步骤或启用前联网检查。后台可选择最高可用、16bit 无损、320 / 192 / 128kbps，默认请求 `br=999`。实际音质以返回文件的 metadata 为准。

GD 适配器使用官方 `https://music-api.gdstudio.xyz/api.php?types=url&source=...&id=...&br=...`，QQ 平台映射为 `tencent`，QQ 数字歌曲 ID 沿现有流程转换为 MID。不按歌名搜索替换；不支持的平台直接继续其他音源。音频照常经过完整校验和缓存后发给 Agent。按官方限制在单个后端进程内设置 5 分钟最多 50 次 API 请求，超限立即回退；已缓存音频不重复请求。API 异常与返回音质记录在 `gdstudio.*` 日志中，平台 Cookie 不发送到 GD API。

musicdl 首次显示「未安装」，选择它或保存设置不会触发安装。点击「安装」才下载固定 [uv 0.12.23 官方发行包](https://github.com/astral-sh/uv/releases/tag/0.12.23)并验证固定 SHA-256，下载托管 Python 3.12，建立独立 venv 并安装 musicdl。程序、解释器、缓存、日志都位于 `DATA_DIR/tools/`，不要求系统 Python 或 Go。下次启动只读取安装记录和本地解释器，启用时由 Worker 验证导入；损坏或依赖缺失时显示未安装 / 启动失败，由管理员点击安装修复。安装失败保留已下载内容，点击「重试安装」继续。首次准备需访问 GitHub 和 PyPI，网页不等待安装完成；状态和重试入口独立显示。

安装与启动分离：`POST /api/v1/music/install` 是唯一触发 Go / Python 下载的管理入口；`POST /api/v1/music/restart` 只重启已有安装。未启用的音源也可先安装，完成后显示「已安装」，保存为首选或备用源后才启动。Meting、api-enhanced 的依赖随 `npm install` 已安装，标记为「内置」，服务运行期间不再下载依赖。

musicdl 的公开接口主要是搜索 / 下载，没有统一单曲解析接口，因此本项目针对固定版本包装平台内部 ID 解析方法。咪咕需要 copyrightId 和 contentId，按提供的 ID 查询并严格匹配后才能解析。升级 musicdl 时必须重新验证这层适配。只返回 HTTP 音频链接，暂不支持该库的 HLS、DRM 对象、专辑批量下载等路径。

未配置平台登录态时，musicdl 先尝试其固定版本内置的备用解析接口，避免官方游客试听地址提前结束取源。已配置登录态时使用官方解析，不向公开备用接口传递凭证。所有返回结果仍需匹配原平台歌曲 ID，并通过后端实际格式、时长和试听检查；备用接口也可能失效或超时。

可选 `NETEASE_COOKIE`、`QQ_MUSIC_COOKIE` 在后端环境变量中设置，修改后重启后端。登录态用于对应平台的原链接解析、Meting、api-enhanced 和 musicdl 官方请求；托管 go-music-dl 健康检查后通过本地 `/music/cookies` 接口同步已配置的平台。未配置时不修改托管音源已有账号；外部服务自行管理账号，不向外部服务同步环境凭证。NapCat 登录 QQ 不等于音乐平台登录。无登录态也可尝试免费完整音频；会员 / 地区限制不作可用保证。

QQ 原 ID 取源在文件可用时优先请求 FLAC、320kbps，再尝试 128kbps；Meting 请求最高可用档位。api-enhanced 只通过原生请求工具调用 v1 接口，不加载上游 `song_url_v1.js` 的取源辅助分支或 HTTP 服务入口，不启用 UNM。卡片已有音频地址仍优先，不因音质主动搜索替换歌曲；原地址完整且可播放时不会调用备用源。

下载日志 `media.validation.metadata` 记录实际码率、采样率、位深、声道、格式和时长，不能以文件名或接口声称的音质判断。已有缓存继续复用，不会被此次升级转成高码率。Agent 使用原文件交给 mpv，没有再次编码或主动添加均衡器；声音发闷仍需结合实际音源与 Windows 输出设备判断。

可在设置中启用 [歌曲预热与分段下载](downloads.md)。预热不跳过原 ID、完整音频校验、审核或黑名单，也不改变插队规则；下载日志区分连接、传输和验证耗时。

Worker 取源超时会终止对应进程并继续回退，下一次调用自动重启；关闭后端清理受管理进程。启动成功表示依赖能运行，完整可播仍以一次歌曲下载的校验结果为准。

## 模块边界

1. card-parsers：从 NapCat 原始卡片和分享链接得到曲目信息与平台 ID。
2. TrackMetadata：补全歌名、歌手、时长和歌词，供展示、黑名单与文字内容审核使用。
3. AudioProvider：把平台曲目转换成可下载的音源地址，保持队列、审核和 Agent 不依赖具体取源项目。
4. MusicManager / GoMusicDlRuntime / AdapterRuntime：管理启用音源、安装、Worker、健康检查、超时与重试，与下载协议分开。
5. MediaService：下载、格式检查、实际时长、试听判断、缓存和设备专属票据。
6. Agent / mpv：向后端主动连接，验证音频文件后在对应电脑播放。

增加后端时扩展共享引擎枚举和配置、注册 AudioProvider 即可；保持调度和 Agent 协议不变。MediaService 驱动惰性的取源顺序，只有下载或校验失败才取下一项。跨平台自动换源仍未开放。

## 同类机器人使用的方案

前期读取的 nonebot-plugin-multincm、[maibot-music](https://github.com/pan-ice/maibot-music)、astrbot_plugin_music 和 astrbot_plugin_musicdl 的实现有各自的取源与下载路径；少量样本不能代表全部机器人。共同可复用的部分是曲目信息、解析音源、下载缓存，再发送或播放。本项目沿用这一边界，业务队列、额度、审核与远程电脑控制独立实现。

具体仓库核实记录保留在 [复用调研](reuse-research.md)。其中早期 UNM 方案已经撤销，以本文与 README 的当前实现为准。

其他候选见 [其他音源后端](music-alternatives.md)，其中 GD Studio 已集成。
