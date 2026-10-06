# Agent 协议 v1（v0.1 实现）

更新日期：2026-10-06。实际 schema 在 `backend/src/contracts/index.ts`，各项目带有独立副本；此文档描述当前代码。

## 连接

Agent 配置 `serverUrl` 为 HTTP / HTTPS 根地址，自动使用对应的 WS / WSS：例如 `http://服务器:3000` 对应 `ws://服务器:3000/ws/agents`，`https://服务器` 对应 `wss://服务器/ws/agents`。请求头为 `Authorization: Bearer <设备凭证>`。凭证由管理页面注册设备时签发，明文只显示一次，服务器保存 SHA-256。NapCat 使用独立的 `/ws/onebot` 和 ONEBOT_TOKEN。HTTP / WS 不加密。

每个播放区一个 Agent。新连接增加设备 epoch，替换旧连接。Worker 未连接或 mpv 未就绪时，设备不能接收新的播放任务。

Agent 首帧：

```json
{"type":"hello","v":1,"ready":true,"version":"0.1.4","capabilities":["seek"],"bootId":"启动 UUID","playbackId":null,"started":false,"position":0,"durationSeconds":0,"seekable":false}
```

服务器回复：

```json
{"type":"welcome","v":1,"agentId":"agent_x","zoneId":"zone_x","epoch":1,"leaseMs":60000}
```

服务器每 5 秒续约，Agent 每 5 秒发送 heartbeat。Worker 每秒向联网服务报告实际播放状态。服务器 45 秒未收到有效消息会断开设备，服务与 Worker 用单调时钟限制本地租约最多 60 秒。

## 播放命令

```json
{
  "v": 1,
  "kind": "command",
  "id": "cmd_x",
  "agentId": "agent_x",
  "zoneId": "zone_x",
  "epoch": 1,
  "expiresAt": "2026-10-04T10:00:00.000Z",
  "payload": {
    "action": "start",
    "playbackId": "play_x",
    "queueItemId": "item_x",
    "assetId": "media_x",
    "ticket": "短期签名下载凭证",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "bytes": 123456,
    "mime": "audio/mpeg",
    "volume": 50
  }
}
```

示例使用占位值。其他 payload：

start 可选带 `title`、`artists`、`durationSeconds` 供桌面显示；不参与歌曲身份或文件校验。旧端忽略附加字段，新端缺少时显示准备中，协议版本仍为 v1。

| action | 字段 | 含义 |
| --- | --- | --- |
| stop | playbackId | 停止对应任务 |
| pause / resume | playbackId | 暂停 / 继续对应任务 |
| volume | volume，整数 0–100 | 修改受管 mpv 的音量 |
| seek | playbackId、position，整数 0–86400 | 跳到当前歌曲的指定秒数，保留暂停状态 |

0.1.4 在 hello 中声明可选 `capabilities: ["seek"]`，hello / heartbeat 报告 mpv 实际 `durationSeconds` 与 `seekable`。旧端缺少字段时不开放网页跳转。网页向 `/api/v1/zones/<zoneId>/control` 提交 `action: "seek"`、当前 `playbackId` 和整数 `position`。后端核对当前任务、设备能力与就绪状态，限定到实际时长末尾前一秒，并立即派发有效期 10 秒的命令。Agent 与 Worker 再次核对任务、租约及制动，使用 mpv `absolute+exact` 跳转；不切换暂停状态。

Agent 检查版本、设备、播放区、epoch 与 expiresAt，持久记录近期命令 ID，回复：

```json
{"type":"ack","commandId":"cmd_x","status":"accepted"}
```

status 为 accepted / duplicate / rejected，拒绝时可附加 error。ACK 只表示接受任务。开始下载和命令 ACK 都不会让服务器将歌曲标记为正在播放。

待确认命令保存在数据库，每 5 秒重发，原 ID 不变。Agent 保留最近 500 个命令 ID；重复 start 不重复执行。重连先核对实际播放状态，禁止靠新命令 ID 盲目重播。该实现不承诺崩溃交界处严格 exactly-once。

## 音频

Agent 从固定的服务器地址拉取 `/api/v1/media/<assetId>?ticket=<ticket>`，仍需设备 Bearer 凭证。ticket 绑定设备、音频资源和播放会话，签发后 10 分钟过期。接口支持单段字节 Range。

WSS 不传整首音频。Agent 下载到本地临时文件，验证 bytes 与 SHA-256 后原子重命名，再通过本机 IPC 将固定缓存路径交给 Worker。远程命令不携带任意 shell、脚本或 mpv 参数。平台 Cookie 留在服务器。

2 MiB 以上缓存采用四路单段 Range 请求；不正确的范围取消全部分段后回退单连接。后端返回资源 SHA-256 的 ETag，Agent 最后核对完整哈希。票据和设备凭证每段都必须验证。

## 桌面总览与本机制动

后端每 5 秒向认证设备发送可选 `overview`：`zone` 包含 id/name/enabled/volume，`waitingCount` 为待播放与待审核总数，`queue` 最多十条 id/title/artists/status，按当前公平调度顺序展示，待审核项放在后面。旧 Agent 忽略该帧；新 Agent 连接旧后端时总览为空，播放协议仍兼容。

桌面控制台使用只监听 127.0.0.1 的随机 HTTP 端口，凭证是保护目录中的 ipcSecret，服务拒绝 Origin 与未认证请求。接口为 GET /state、GET /logs，POST /brake、/config、/control。桌面接口不经过公网后端；远端不能解除本机制动。

制动状态保存于 control-state.json。设置后立即取消待下载任务、向 Worker 发送带凭证的 emergency-stop，并报告 ready=false；Worker 不依赖远端租约，250 ms 未响应停止则终止 mpv。制动代数防止旧异步 start 在校验后恢复播放。网络中断、服务及播放器重启仍保持锁定，只有本机解除后接收新歌曲。

## 播放事件

```json
{"type":"playback","eventId":"事件 UUID","playbackId":"play_x","state":"started"}
```

state 为 started / ended / stopped / failed，失败可附加 error。Worker 的 mpv file-loaded 事件产生 started，end-file 产生对应终态。进度和暂停状态放在 heartbeat：

```json
{"type":"heartbeat","ready":true,"playbackId":"play_x","started":true,"position":32.5,"paused":false,"durationSeconds":235.2,"seekable":true}
```

Agent 联网服务持久化播放事件，等待服务器 `{"type":"event-ack","eventId":"..."}` 后清理。服务器通过当前队列项、playbackId 与状态迁移保证重复终态不重复推进队列；旧连接 epoch 不能修改新连接状态。

## 重连与恢复

- 重连退避为约 1、2、4、8、16、30 秒，并加入随机抖动。
- hello 中报告 Worker 的真实播放状态，服务器保留相同 playbackId 的当前播放，不重新开始。
- 若派发状态的任务尚未实际启动、重连快照为空，回到待播队列并产生新的播放会话。
- 若已在播的任务丢失，标记失败并释放播放区。
- 若设备正在播放未知任务，先发送 stop，并保持该设备不可派发；快照 / 心跳确认空闲后才能开始下一首。
- 网络中断时不自动接下一首。未继续收到租约时，Worker 停止当前受管播放。

服务启动时会恢复尚未完成的 preparing 状态；实际正在播放或派发的任务等待设备重新报告，不能把断线当作已停止。

## 本机结构与当前边界

NSSM 管理 LocalService 联网进程。用户登录任务启动 Worker，Worker 通过 mpv JSON IPC 控制播放器。Windows 本机服务管道允许跨账户读写，使登录用户可连接 LocalService；每次连接仍需配置派生的独立秘密认证，不接受未认证指令。配置和数据目录仅授予服务、播放用户、系统和管理员相应权限。0.1.1 修复了跨账户管道 EPERM，并记录播放器连接错误到 `player-error.log`。

桌面控制台提供持久化紧急制动、下载速度与四路缓存传输。mpv 启动失败或崩溃会记录原因，并以 2–30 秒退避重试。0.1.3 支持按 1 秒调整进度，并在音频输出异常退出后，从缓存恢复已开始、租约有效的当前任务，保留位置、音量和暂停状态。10 秒内再次退出、加载失败或恢复超时则报告失败；停止、制动和租约失效取消恢复。解除制动不会恢复旧任务。更新卸载会清理对应旧 Worker 与 mpv，保留配置和缓存。

0.1.4 加入网页整数秒跳转、seek 能力声明及实际时长上报，协议版本仍为 v1；设备能力和播放快照仅保存在当前连接内，不增加数据库字段。桌面控制台独立读取 Windows 服务注册、运行和启动方式，同时展示后端与播放器状态。本机跳转仍走认证本机接口。mpv 跟随 Windows 默认声卡输出，当前没有远端声卡选择或一次性配对码。设备使用注册凭证接入。发行包验证使用静音音频，具体声卡输出仍需在播放电脑上实际确认。
