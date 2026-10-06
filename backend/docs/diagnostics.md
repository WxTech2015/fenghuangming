# 解析与播放诊断

后端通过 `.env` 的 `APP_MODE` 选择运行状态，修改后在宝塔重启后端。日志输出到宝塔 Node 项目运行日志和 `DATA_DIR/logs/backend.jsonl`，默认路径为 `backend/data/logs/backend.jsonl`。

| 配置 | 生产模式 `production` | 调试模式 `debug` |
| --- | --- | --- |
| 默认日志级别 | `info`，记录正常操作和错误 | `debug`，增加请求、取源、下载和进程细节 |
| 错误堆栈 | 隐藏 | 显示 |
| 追踪 ID | 关闭 | 开启，用于关联同一次点歌的处理过程 |

```dotenv
APP_MODE=production
# 留空沿用模式默认值，也可填写 debug / info / warn / error。
LOG_LEVEL=
# 留空沿用模式默认值，也可填写 true / false。
LOG_TRACE_ENABLED=
```

`LOG_LEVEL=debug` 会启用堆栈，但不会单独打开追踪 ID。`LOG_TRACE_ENABLED=true` 可在生产模式下启用追踪，日志级别保持不变。无效配置会阻止启动。生产模式禁止使用默认管理员密码与默认会话密钥，即使后端通过本机端口接入反向代理。

## 在后台排查

1. 打开「诊断日志」。在「测试解析」粘贴失败歌曲的音乐分享链接，可指定首选音源，或使用已保存的音源配置。
2. 点击测试。后端沿用实际取源、回退、下载和完整音频校验流程；不加入播放队列，不向 Agent 发播放指令。成功音频进入正常缓存，后续同曲可复用。
3. 开启追踪时，测试结束后自动按追踪 ID 显示日志。WARN / ERROR 的「详情」包含底层 cause、HTTP 状态、音源、歌曲 ID 和耗时；堆栈按当前配置显示。「导出当前结果」下载筛选后的 JSONL。
4. 对群内实际点歌，在「最近失败的歌曲」点击「查看日志」。追踪开启时按处理链路筛选，关闭时按队列任务筛选。生产模式下详细的 `debug` 事件不会记录，排查时先切换模式，再重新点歌或测试解析。

网页每 3 秒刷新，可关闭自动刷新。界面保留最近 2000 条记录，单次最多查询 1000 条；默认显示最近 500 条。文件按 10 MiB 滚动，保留当前文件和 5 个历史文件。超出网页范围的历史日志可在宝塔文件管理中读取 `backend.jsonl.1` 至 `.5`。

| 日志环节 | 用途 |
| --- | --- |
| `card.*` | 卡片类型、平台与原歌曲 ID，JSON 格式和短链接展开失败 |
| `metadata.*` / `moderation.*` | 曲目信息补全、AI 接口失败与审核结论；不记录歌词和提示词 |
| `queue.*` / `playback.*` | 入队、拒绝、调度、准备失败和实际开播 |
| `music.original.*` / `music.canonical.*` | 原链接取源和 QQ 数字 ID 转换失败 |
| `music.provider.*` / `music.search.*` | 每个音源的取源、跳过原因、同曲匹配和回退 |
| `music.rpc.*` / `music.worker.*` / `musicdl.*` | Worker 初始化、具体异常、Python traceback、进程输出和 RPC 超时 |
| `gomusicdl.*` | go-music-dl 启动、健康检查、标准输出 / 标准错误和进程退出 |
| `gdstudio.*` | GD 音乐台原 ID 请求、请求音质、返回音质和大小、接口失败与限流 |
| `network.*` / `platform.*` | DNS、连接错误、重定向、HTTP 状态、内容类型与平台返回码 |
| `media.*` | 缓存命中、下载字节数、格式与时长、试听拒绝、文件权限与 Agent 下载 |
| `agent.*` | 连接与就绪变化、指令派发 / ACK、Agent 报告的播放结果 |
| `github.*` / `pypi.*` / `music.install.*` / `python.prepare.*` | GitHub 与 PyPI 节点测速、下载校验、换源安装与 Python 准备 |
| `backend.*` / `storage.*` / `api.*` / `onebot.*` | 启动、数据库、接口请求、NapCat 账号与群接口 |

网页显示当前模式、日志级别、追踪状态与日志目录。日志文件不可写时，后台显示具体错误，运行日志仍可使用。切回生产模式后，网页会按当前设置过滤旧日志；磁盘上的历史文件不会改写。

日志会脱敏凭证、Authorization、Cookie、平台临时签名、数据库密码、歌词和审核提示词。记录音频地址时隐藏签名与票据查询值，保留域名、路径和歌曲 ID。开启追踪时，API 错误回复携带 `traceId` / `X-Trace-Id`，群内错误回复附带追踪 ID；关闭后不显示。只有已登录管理员能读取、导出日志和执行解析测试。提交问题时仍应检查并删去个人信息和设备名称。

## 从宝塔更新

上传后端源码，保留原 `.env`、`data/` 和数据库。执行 `npm install --include=dev`、`npm run build`，表结构发生变化时备份数据库后执行 `npm run db:push`，再从宝塔重启 `start`。新版前端构建后覆盖静态网站目录。日志配置不需要修改 Agent。

若日志出现 `Unknown argument source`，需要重新生成 Prisma 客户端；若出现 `source` 列不存在，需更新数据库表结构。缓存文件写入或数据库保存失败会报告 `MEDIA_CACHE_ERROR`，保留底层原因并停止准备。

测试解析成功只证明后端能取得完整音频；Windows 声卡输出仍需实际播放验证。未复现之前先按追踪 ID 查看第一个具体错误和后续回退结果。

音质排查时查看 `media.validation.metadata` 的 bitrate（bit/s）、sampleRate（Hz）、bitsPerSample、channels、codec 和 container。例如 bitrate=128000 表示实际 128kbps，与播放器显示无损无关。旧缓存命中不重新下载；升级取源策略不会改变已经缓存的文件。

musicdl 安装失败看 `python.prepare.step` 和 `python.prepare.stderr`；镜像失败与换源看 `pypi.node.tested`、`pypi.install.failed`；已安装但取源失败看 `music.rpc.failed`、`musicdl.alternate.failed` 和 `musicdl.official.failed`。先区分安装、初始化和具体歌曲解析，不把三者当成同一问题。
