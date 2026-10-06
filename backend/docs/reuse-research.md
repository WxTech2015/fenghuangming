# GitHub 复用调研

检索与读取日期：2026-10-04。通过 GitHub 仓库搜索、官方仓库 README、部分源码、LICENSE 和仓库元数据核实。没有安装候选项目，也没有用真实音乐账号测试其接口；仓库声明的支持范围不等于已经验证的可播放范围。

项目采用模块化适配，选型以接口可用性和复用成本为依据。下表保留来源与许可记录。

当前采用 mpv JSON IPC 与 Naive UI，自建管理界面和业务模块。go-music-dl 与 musicdl 由管理员点击安装；Meting、api-enhanced 作为隔离的 Node 适配器，GD Studio 作为可选远程接口。原链接优先，下载或完整音频校验失败才调用备用音源。下文保留初始候选比较，当前部署与固定版本以 README、锁文件和 [音源方案](music-sources.md) 为准。

## 1. 建议采用的组合

建议自建点歌、审核、队列与设备控制业务，复用成熟的基础能力：

1. NapCat 独立部署，通过 OneBot 接口对接，不复制它的内部实现。
2. Vue 后台优先从 SoybeanAdmin 的 Naive UI 版本开始，叠加自有玻璃主题组件。
3. 卡片解析参考 maibot-music，将明确授权的解析规则移植为 TypeScript 插件。
4. 多平台下载使用 go-music-dl。api-enhanced、Meting、QQMusicApi 作为后续元数据或音源适配候选。后端统一下载缓存，Agent 拉取本地播放。
5. mpv 作为独立播放器进程，通过官方 JSON IPC 驱动。
6. 中央播放调度、黑名单、每日插队额度和 Agent 恢复机制由本项目实现。

本轮没有发现可以直接同时满足 NapCat、Vue / Naive UI、MySQL、NSSM 远程播放、AI 审核和每日插队额度的完整项目。以下候选按模块复用更合适。

## 2. 候选项目比较

| 项目 | 已核实能力 | 建议复用位置 | 许可证 / 限制 | 判断 |
| --- | --- | --- | --- | --- |
| [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | NTQQ 协议端；官方文档提供 OneBot、反向 WS 接入 | A，独立运行后接接口 | 自定义受限许可，不能按 MIT 处理；LICENSE 包含非商业限制 | 指定的 QQ 接入端；保持外部边界 |
| [soybeanjs/soybean-admin](https://github.com/soybeanjs/soybean-admin) | Vue 3、TypeScript、Pinia、UnoCSS、Naive UI 版本、权限路由和主题 | B，后台页面骨架 | [MIT](https://github.com/soybeanjs/soybean-admin/blob/main/LICENSE) | 首选；更适合统一 TypeScript 协议 |
| [zclzone/vue-naive-admin](https://github.com/zclzone/vue-naive-admin) | Vue 3、Naive UI、管理页面、主题和权限路由 | B，轻量模板替选 | [MIT](https://github.com/zclzone/vue-naive-admin/blob/2.x/LICENSE)；已读取的 2.x 前端以 JavaScript 为主 | 希望使用配套全栈模板时考虑 |
| [zclzone/isme-nest-serve](https://github.com/zclzone/isme-nest-serve) | NestJS、TypeORM、MySQL、Redis、JWT 和 RBAC | C，认证与后台基础参考 | [MIT](https://github.com/zclzone/isme-nest-serve/blob/main/LICENSE) | 可整套采用 TypeORM 路线，或仅参考；不与 Prisma 混用 |
| [pan-ice/maibot-music](https://github.com/pan-ice/maibot-music) | QQ / 网易云链接、短链、音乐卡片和小程序解析；原消息精确 ID 提取 | `card-parsers`、音乐错误处理参考 | [MIT](https://github.com/pan-ice/maibot-music/blob/main/LICENSE)；Python / MaiBot 插件 | 很贴近卡片需求，移植解析层即可 |
| [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | 网易云第三方 Node API、TypeScript 类型与部署说明 | 网易云 Provider | [MIT](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/LICENSE)；接口和登录态需实测 | 优先验证；以 Adapter 隔离变化 |
| [metowolf/Meting](https://github.com/metowolf/Meting) | 当前默认分支是 Node.js 版本，统一多平台搜索、详情、歌词、音源接口 | 可选多平台 Provider | [MIT](https://github.com/metowolf/Meting/blob/master/LICENSE)；平台声明需逐项测试 | 多平台候选，不直接承诺全部可播 |
| [jsososo/QQMusicApi](https://github.com/jsososo/QQMusicApi) | Express / Axios QQ 音乐 API、Cookie、搜索和登录刷新示例 | QQ Provider 候选 | [GPL-3.0](https://github.com/jsososo/QQMusicApi/blob/master/LICENSE)；仓库最后 push 为 2024-06-25 | 较老，先验证接口和许可边界 |
| [mpv-player/mpv](https://github.com/mpv-player/mpv) | 外部控制、JSON IPC、Windows 命名管道 | `player-drivers/mpv` | [默认 GPLv2+，特定构建可为 LGPLv2.1+](https://github.com/mpv-player/mpv/blob/master/Copyright) | 采用官方 IPC，管理实际发版构建的分发材料 |
| [qq01-hub/openmusic](https://github.com/qq01-hub/openmusic) | 多人房间点歌、队列与进度、站点管理；Redis 与 Meting 依赖 | 队列 / 房间交互参考 | [MIT with Attribution Requirement](https://github.com/qq01-hub/openmusic/blob/main/LICENSE)，有额外可见署名要求 | 适合参考产品行为，整套改造成本较高 |
| [Enkianssus/AwooMusicBot](https://github.com/Enkianssus/AwooMusicBot) | Windows 弹幕点歌、队列权限、多播放器连接器、Electron 与 .NET | Windows 交互和播放器边界参考 | README 声明 MIT，采用前仍需核查各连接器许可 | 已选择 mpv，通常无需整套引入 |
| [nICEnnnnnnnLee/DanmuMusicPlayer](https://github.com/nICEnnnnnnnLee/DanmuMusicPlayer) | Java 弹幕点歌、QQ / 网易云、可扩展音源与播放器接口 | 接口拆分参考 | README 声明 Apache-2.0 | 与当前技术栈距离较大，优先级低 |

许可证信息作为依赖来源记录保留，发布时随依赖整理版权和许可材料。

## 3. 卡片解析的直接参考

maibot-music 源码包含几类贴近需求的入口：

- [url_parser.py](https://github.com/pan-ice/maibot-music/blob/main/url_parser.py)：QQ 和网易云长链接、短链接、分享文本、卡片文字解析。
- [plugin.py](https://github.com/pan-ice/maibot-music/blob/main/plugin.py)：`_resolve_music_card_from_raw` 通过原始消息 JSON 段读取音乐卡片和小程序里的跳转地址。
- [music_api.py](https://github.com/pan-ice/maibot-music/blob/main/music_api.py)：音乐 API 实现入口；本轮仅定位该文件，未完整审查实现。
- [tests](https://github.com/pan-ice/maibot-music/tree/main/tests)：仓库已有测试样本入口；本轮未运行其测试。

推荐把原始 JSON 结构、URL 规则和错误降级逻辑拆成独立解析器，而不是为了一个音乐能力引入整个 MaiBot。NapCat 事件中已有完整数据时直接解析，缺失时再补取消息。

这也说明不能假定 QQ 用户发来的音乐分享一定是标准 `music` 段。必须兼容实际原始结构，并记录无法识别的样本。

## 4. 音乐源选择

### 网易云

调研时 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 原仓库处于 archived 状态；这仅说明该 GitHub 仓库归档，不代表同名 npm 包绝无更新。

当前集成 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，固定 npm 版本。升级前核对上游维护状态、运行要求和许可证。

### QQ 音乐

[QQMusicApi](https://github.com/jsososo/QQMusicApi) 的 README 提供 Node 与 Cookie 使用示例，但最后 push 较早。不能以搜索成功来判断音源接口仍有效。

[Meting](https://github.com/metowolf/Meting) 当前默认分支 README 与 package.json 明确为 Node.js 包 `@meting/core`，不能按旧印象认为只有 PHP 版本；声明支持网易云、腾讯、酷狗、百度和酷我。仍需独立验证 QQ 的完整音频、歌词、登录与账号权限。

平台凭据与实际可播放权限有关。例如 maibot-music 的 README 明确区分账号会员 / 专辑权益和直链失败。设计上必须返回“完整音频 / 试听 / 受限”，并将受限结果显示给管理员。

### 实施前验证清单

| 样本 | 需要确认 |
| --- | --- |
| 免费歌曲 | 明确 ID、正确版本、完整播放、时长一致 |
| 会员歌曲与付费专辑 | 当前账号是否有权限；无权限时返回明确限制 |
| 长链接、短链接、小程序、JSON / XML 变体 | 输入能否正确定位同一歌曲 |
| 云端解析 + Windows 播放 | URL 是否受出口 IP、必要请求头或区域影响 |
| 等待较久的队列项 | 临近播放刷新音源，过期重试不重复播放 |
| 不同歌曲版本 | 不把 Live、翻唱或混音误当原版 |
| 下架或区域受限曲目 | 准确失败，不自动换成未经审核的同名歌曲 |

以上为候选接入时的验证方法。当前实现与支持范围见 [音源说明](music-sources.md)。

## 5. 基础能力与边界

- Naive UI 自身支持主题覆盖：[官方仓库](https://github.com/tusen-ai/naive-ui)。液态玻璃视觉仍需本项目制作，后台模板不等于已有该效果。
- NapCat 使用 OneBot 反向 WS：[官方接入文档](https://doc.napneko.icu/use/integration)。Agent 使用本项目独立协议，不与 OneBot 混用。
- mpv 推荐用 JSON IPC，不解析终端文字；Windows 支持命名管道：[官方手册](https://mpv.io/manual/master/)。
- Windows 服务与用户会话进程分离基于 Microsoft 的 Session 0 与 IPC 建议：[官方文档](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)。
- NSSM 的安装、退出重启和日志配置：[使用文档](https://www.nssm.cc/usage)；[下载页](https://www.nssm.cc/download)声明 public domain。下载页的构建较旧，需要在实际 Windows 版本验证。

## 6. 引入顺序

先做 NapCat 原始分享 -> 曲目详情 -> 完整音源 -> Windows mpv 实际出声的小规模验证，再锁定 Provider 版本。然后引入后台模板，实现中央持久队列、黑名单和每日额度，最后扩展 AI 与更多平台。

复用代码时记录来源、版本或 commit、许可证与修改范围。新平台接入必须提供真实样本与兼容验证结果；第三方接口变动不应要求重写队列、网页或 Agent。

## 7. 当前音源与自动部署

当前固定使用 [go-music-dl v1.1.1](https://github.com/guohuiyuan/go-music-dl/releases/tag/v1.1.1)。核实了官方发行包、CLI 参数、仅监听本机的桌面服务模式、健康检查和下载接口；后端增加了安装及进程管理模块。UNM 不再属于默认或可选后端。

另核对了 nonebot-plugin-multincm、maibot-music、astrbot_plugin_music 和 astrbot_plugin_musicdl 的实际取源 / 下载实现。其他候选后端、模块边界与部署说明见[音源后端与自动部署](music-sources.md)。
