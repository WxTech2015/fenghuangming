import { parseArgs } from 'node:util';

export function parseOptions(args: string[]) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    endpoint: { type: 'string', short: 'e' }, server: { type: 'string' }, token: { type: 'string', short: 't' },
    config: { type: 'string' }, role: { type: 'string', default: 'standalone' },
    mpv: { type: 'string' }, 'data-dir': { type: 'string' }, user: { type: 'string' },
    install: { type: 'boolean' }, uninstall: { type: 'boolean' }, check: { type: 'boolean' }, console: { type: 'boolean' },
  } });
  if (values.install && values.uninstall) throw new Error('--install 与 --uninstall 只能选择一个');
  if (!['standalone', 'service', 'worker'].includes(values.role)) throw new Error('--role 必须是 standalone、service 或 worker');
  if (values.server && values.endpoint && values.server !== values.endpoint) throw new Error('--server 与 --endpoint 地址不一致');
  return values;
}

export const HELP = `凤凰鸣 Agent 0.1.4

前台运行：
  fenghuangming-agent.exe --endpoint http://网站地址 --token 设备凭证
  fenghuangming-agent.exe --config agent.config.json

安装为开机服务（管理员终端）：
  fenghuangming-agent.exe --install --endpoint http://网站地址 --token 设备凭证
  fenghuangming-agent.exe --install --config agent.config.json

其他参数：
  --console            打开 Windows 桌面控制台
  --uninstall          移除服务和登录任务，保留配置与缓存
  --check              检查配置、服务器和播放器
  --mpv 路径           使用自己的 mpv，默认使用内置播放器
  --data-dir 路径      指定配置、日志与缓存目录
  --user 电脑名\\用户名 指定登录后播放的 Windows 用户
  --version            显示版本
  --help               显示此说明

设备凭证由网页注册设备时生成。播放用户需要保持登录。
`;
