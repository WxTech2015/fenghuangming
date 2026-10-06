import type { Track } from '../contracts';
import type { ResolvedSource } from './providers';

type NativeCall = (method: 'song_url_v1' | 'song_url', query: Record<string, unknown>) => Promise<any>;
export async function resolveNeteaseAudio(track: Track, call: NativeCall, loginProvided: boolean): Promise<ResolvedSource> {
  const failures: unknown[] = []; let responded = false; let preview = false;
  const accept = (body: any) => {
    const song = body?.data?.find((entry: any) => String(entry?.id) === track.externalId);
    if (!song) return;
    const trial = song.freeTrialInfo;
    if (trial && trial !== 'null') { preview = true; return; }
    if (typeof song.url !== 'string' || !/^https?:\/\//.test(song.url)) return;
    return { url: song.url, source: 'neteaseapi', headers: { Referer: 'https://music.163.com/' } };
  };
  // Exact platform ID at every level. Do not activate the package's unrelated
  // unblock/matching branch when requesting the native v1 endpoint.
  for (const level of ['lossless', 'exhigh', 'standard']) {
    try { const result = accept(await call('song_url_v1', { id: track.externalId, level })); responded = true; if (result) return result; }
    catch (error) { failures.push(error); }
  }
  if (!responded) {
    try { const result = accept(await call('song_url', { id: track.externalId, br: 320000 })); if (result) return result; }
    catch (error) { failures.push(error); }
  }
  const reason = preview ? '网易云只返回试听片段' : '网易云原歌曲没有可用的完整音频';
  throw Object.assign(new Error(`${reason}${loginProvided ? '；已提供登录态，请核对账号权限、Cookie 有效期或地区限制' : '；未配置 NETEASE_COOKIE，当前按游客取源，可继续尝试已安装的备用音源'}`), { code: preview ? 'AUDIO_PREVIEW' : 'SOURCE_UNAVAILABLE', cause: failures.length ? new AggregateError(failures, '网易云原生取源接口失败') : undefined });
}
