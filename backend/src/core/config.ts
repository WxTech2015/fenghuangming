import type { LogLevel } from '../contracts';

export type AppMode = 'production' | 'debug';
export interface RuntimeConfig { mode: AppMode; logLevel: LogLevel; traceEnabled: boolean; includeStack: boolean }

// APP_MODE 统一控制运行环境；空的日志配置沿用该模式的默认值。
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.APP_MODE?.trim() || 'production';
  if (mode !== 'production' && mode !== 'debug') throw new Error('APP_MODE 只能填写 production 或 debug');
  const level = env.LOG_LEVEL?.trim() || (mode === 'debug' ? 'debug' : 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error('LOG_LEVEL 只能填写 debug、info、warn 或 error');
  const trace = env.LOG_TRACE_ENABLED?.trim();
  if (trace && trace !== 'true' && trace !== 'false') throw new Error('LOG_TRACE_ENABLED 只能填写 true 或 false');
  return { mode, logLevel: level as LogLevel, traceEnabled: trace ? trace === 'true' : mode === 'debug', includeStack: mode === 'debug' || level === 'debug' };
}
