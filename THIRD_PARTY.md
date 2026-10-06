# 第三方组件

凤凰鸣自行编写的源码采用 [MIT](LICENSE)。npm / Python 依赖和发行包附带的程序保留各自许可证，项目许可证不替代上游许可证。具体版本以各目录的锁文件和安装模块中的固定版本为准。

| 组件 | 用途 | 许可证 / 来源 |
| --- | --- | --- |
| Vue、Naive UI、NestJS、Meting、api-enhanced、ws、zod、fflate、music-metadata、tar-stream | 前端、服务、协议与音源 | npm 包声明 MIT |
| Prisma、RxJS、reflect-metadata | 数据库与服务基础库 | npm 包声明 Apache-2.0 |
| dotenv | 环境配置 | npm 包声明 BSD-2-Clause |
| Lucide | 界面图标 | npm 包声明 ISC |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 独立 QQ 接入服务 | 不随源码包分发，按其项目说明部署 |
| [go-music-dl](https://github.com/guohuiyuan/go-music-dl) | 可选音源程序 | 管理员点击安装时获取官方发行包 |
| [musicdl](https://github.com/CharlesPikachu/musicdl) | 可选 Python 音源 | 管理员点击安装时创建独立环境并安装固定版本 |
| [GD Studio](https://music-api.gdstudio.xyz/) | 可选远程音源接口 | 在线服务，不随项目分发 |
| [mpv Windows 构建](https://github.com/shinchiro/mpv-winbuild-cmake) | Windows 播放器 | 发行包保留该构建附带的许可证文件 |
| [NSSM](https://nssm.cc/) | Windows 服务管理 | 上游声明 Public Domain |
| [Node.js](https://nodejs.org/) | Agent 独立程序运行时 | 打包保留 Node.js LICENSE 与第三方声明 |

源码包只包含适配与打包代码，不包含上述第三方程序二进制。Agent 打包流程会附带软件声明与上游许可证，分发发行包时应一并保留。
