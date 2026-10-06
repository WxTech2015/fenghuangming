import { describe, expect, it } from 'vitest';
import { runtimeConfig } from '../src/core/config';

describe('运行模式', () => {
  it('默认生产模式，日志简洁且关闭追踪', () => {
    expect(runtimeConfig({})).toEqual({ mode: 'production', logLevel: 'info', traceEnabled: false, includeStack: false });
  });
  it('调试模式包含详细日志、堆栈和追踪', () => {
    expect(runtimeConfig({ APP_MODE: 'debug', LOG_LEVEL: '', LOG_TRACE_ENABLED: '' })).toEqual({ mode: 'debug', logLevel: 'debug', traceEnabled: true, includeStack: true });
  });
  it('日志级别和追踪可以分别覆盖，空值跟随模式', () => {
    expect(runtimeConfig({ APP_MODE: 'production', LOG_LEVEL: 'debug', LOG_TRACE_ENABLED: 'true' })).toMatchObject({ logLevel: 'debug', traceEnabled: true, includeStack: true });
    expect(runtimeConfig({ APP_MODE: 'debug', LOG_LEVEL: 'warn', LOG_TRACE_ENABLED: 'false' })).toMatchObject({ logLevel: 'warn', traceEnabled: false });
  });
  it.each([{ APP_MODE: 'prod' }, { LOG_LEVEL: 'verbose' }, { LOG_TRACE_ENABLED: 'yes' }])('拒绝无效配置 %j', value => {
    expect(() => runtimeConfig(value)).toThrow();
  });
});
