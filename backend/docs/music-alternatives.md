# 其他音源后端

核实日期：2026-10-05。GD Studio 已新增为本项目可选引擎；其余方案仍为候选。

| 方案 | 能力与接入成本 | 当前核实结果 | 对本项目的判断 |
| --- | --- | --- | --- |
| [GD Studio 官方 API](https://music-api.gdstudio.xyz/api.php) | 在线 HTTP API，按 source / 歌曲 ID 请求音频地址；无需 Python | 支持请求 128 / 192 / 320 / 740 / 999 档位，返回实际 br 与 size；当前限制 5 分钟 50 次请求 | 已集成网易云、QQ 音乐、酷我；保存配置即可使用，可设首选或备用、调整音质和顺序，接入已有下载校验、缓存与日志 |
| [TuneHub V3](https://tunehub.sayqz.com/docs) | 在线 API，POST `/v1/parse`，按原歌曲 ID 请求；平台 netease / qq / kuwo；无需 Python | 官方文档要求 `X-API-Key`，音质参数为 128k / 320k / flac / flac24bit | 适合作为有 Key 的可选后端。接入前需要用户选择及账户额度核实；文档可访问不等于已验证具体歌曲 |
| [go-music-api](https://github.com/guohuiyuan/go-music-api) | 可独立部署的 Go REST 服务，支持原链接解析、音频代理、扫码登录；可直接运行二进制 | 与 go-music-dl 同样基于 music-lib；有标准 `/api/v1/*` 和兼容 `/music/*`；[v1.0.1 发行版](https://github.com/guohuiyuan/go-music-api/releases/tag/v1.0.1)提供 Linux / Windows / macOS 包及校验和 | 更适合需要纯 HTTP 服务与扫码账号管理的部署；只是换封装不会自动提高 VIP 取源成功率。兼容路由与本项目请求参数仍需联调，不能直接宣称完全可替换 |

GD Studio 适配器使用当前官方 `music-api.gdstudio.xyz/api.php`；musicdl 2.14.0 的部分内部 GD 解析器使用另一个 `music.gdstudio.xyz/api.php` 地址，两条路径相互独立。

GD Studio 已沿 AudioProvider → 下载缓存 → 实际完整音频校验 → Agent 接入，原分享链接优先，失败才回退。后续需要账号管理时评估 go-music-api；已有 TuneHub Key 时可接入 V3。

musicdl 本身也包含多个公开备用接口，增加依赖它的机器人包装不会自动获得新的独立音源能力。
