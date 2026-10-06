import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../core/errors';
import { diagnostics } from '../core/diagnostics';

const blockedV4 = new BlockList(); const blockedV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
blockedV6.addAddress('::', 'ipv6'); blockedV6.addAddress('::1', 'ipv6'); blockedV6.addSubnet('fc00::', 7, 'ipv6'); blockedV6.addSubnet('fe80::', 10, 'ipv6'); blockedV6.addSubnet('ff00::', 8, 'ipv6'); blockedV6.addSubnet('::ffff:0:0', 96, 'ipv6');
export function isPublicIp(address: string) { const family = isIP(address); return family === 4 ? !blockedV4.check(address, 'ipv4') : family === 6 && !blockedV6.check(address, 'ipv6'); }

// Pin the validated address into the actual request to avoid a DNS rebind
// between validation and downloading. Only the configured local engine may
// contact a private address; its redirects must stay on the configured origin.
export interface AudioResponse extends IncomingMessage { sourceUrl: string; sourceHeaders: Record<string, string> }
export async function openAudioUrl(raw: string, trustedOrigin?: string, redirects = 0, headers: Record<string, string> = {}, timeoutMs = 120000, options: { signal?: AbortSignal; allowPartial?: boolean } = {}): Promise<AudioResponse> {
  const started = Date.now();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError('BAD_AUDIO_URL', '音源地址格式不正确');
  const allowPrivate = !!trustedOrigin && url.origin === trustedOrigin;
  let addresses;
  try { addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }); }
  catch (error) { diagnostics.warn('network.dns.failed', '音源 DNS 解析失败', { hostname: url.hostname, error }); throw error; }
  diagnostics.debug('network.dns.resolved', '音源 DNS 解析结果', { hostname: url.hostname, addresses, allowPrivate });
  if (!addresses.length || !allowPrivate && addresses.some(a => !isPublicIp(a.address))) { diagnostics.warn('network.address.rejected', '音源地址不符合访问规则', { url: url.href, addresses, trustedOrigin }); throw new AppError('PRIVATE_AUDIO_URL', '音源返回了不可访问的地址'); }
  const chosen = addresses[0]!;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { 'User-Agent': 'QQMusicBot/0.1', Accept: 'audio/*,application/octet-stream', ...headers },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      ...{ autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, addresses as never);
        else callback(null, chosen.address, chosen.family);
      },
    }, resolve);
    request.on('error', error => { diagnostics.warn('network.request.failed', '音源 HTTP 请求失败', { url: url.href, durationMs: Date.now() - started, error }); reject(error); }); request.end();
  });
  diagnostics.debug('network.response', '收到音源 HTTP 响应', { url: url.href, status: response.statusCode, contentType: response.headers['content-type'], contentLength: response.headers['content-length'], durationMs: Date.now() - started });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (redirects >= 4 || !response.headers.location) throw new AppError('AUDIO_REDIRECT', '音源重定向过多');
    const next = new URL(response.headers.location, url);
    diagnostics.debug('network.redirect', '跟随音源重定向', { from: url.href, to: next.href, redirects: redirects + 1 });
    const forwarded = Object.fromEntries(Object.entries(headers).filter(([key]) => next.origin === url.origin || !['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())));
    return openAudioUrl(next.href, trustedOrigin, redirects + 1, forwarded, timeoutMs, options);
  }
  if (response.statusCode !== 200 && !(options.allowPartial && response.statusCode === 206)) { response.destroy(); throw new AppError('AUDIO_HTTP_ERROR', `音源返回 ${response.statusCode ?? '未知错误'}`); }
  return Object.assign(response, { sourceUrl: url.href, sourceHeaders: headers });
}
