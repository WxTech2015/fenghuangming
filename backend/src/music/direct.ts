import type { Track } from '../contracts';
import { AppError } from '../core/errors';
import { openAudioUrl } from './network';
import type { ResolvedSource } from './providers';
import { diagnostics } from '../core/diagnostics';

export async function platformJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await openAudioUrl(url, undefined, 0, { Accept: 'application/json', ...headers }, 8000);
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of response) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('平台返回内容过大'); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    diagnostics.debug('platform.json.received', '平台 JSON 接口返回', { url, bytes, code: body.code, subCode: body.req_0?.code }); return body;
  } finally { response.destroy(); }
}

// The card's media URL must belong to the same music platform. The downloader
// still pins public DNS addresses and validates redirects and the audio itself.
export function isPlatformAudioUrl(raw: string, platform: Track['platform']) {
  try {
    const url = new URL(raw); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    const domains: Record<Track['platform'], string[]> = { netease: ['music.126.net', 'music.163.com'], qq: ['qq.com', 'qqmusic.qq.com', 'qqmusic.tc.qq.com'], kugou: ['kugou.com', 'kgimg.com'], kuwo: ['kuwo.cn'], migu: ['migu.cn', 'cmvideo.cn'], bodian: ['bodian.com', 'kuwo.cn'] };
    return domains[platform].some(d => url.hostname === d || url.hostname.endsWith('.' + d));
  } catch { return false; }
}

export async function qqSong(track: Track): Promise<any> {
  if (track.platform !== 'qq' || !track.externalId) throw new AppError('SOURCE_UNSUPPORTED', '缺少 QQ 音乐歌曲 ID');
  const numeric = /^\d+$/.test(track.externalId);
  const url = new URL('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg');
  url.search = new URLSearchParams({ [numeric ? 'songid' : 'songmid']: track.externalId, platform: 'yqq', format: 'json' }).toString();
  const body = await platformJson(url.href, { Referer: 'https://y.qq.com/' });
  const song = body.data?.[0];
  if (!song?.mid || (numeric ? String(song.id) !== track.externalId : song.mid !== track.externalId)) throw new AppError('SOURCE_MISMATCH', 'QQ 音乐返回的歌曲与分享 ID 不一致');
  return song;
}

export async function canonicalTrack(track: Track): Promise<Track> {
  if (track.platform !== 'qq' || !/^\d+$/.test(track.externalId)) return track;
  const song = await qqSong(track);
  return { ...track, externalId: song.mid, title: song.name || track.title, artists: song.singer?.map((a: any) => String(a.name)).slice(0, 10) || track.artists, durationSeconds: Number(song.interval) || track.durationSeconds, album: song.album?.title || track.album };
}

export async function* originalSources(track: Track): AsyncGenerator<ResolvedSource> {
  if (track.originalAudioUrl && isPlatformAudioUrl(track.originalAudioUrl, track.platform)) yield { url: track.originalAudioUrl, source: 'direct', match: 'original', track };
  if (!track.externalId) return;
  if (track.platform === 'netease' && /^\d+$/.test(track.externalId)) {
    yield { url: `https://music.163.com/song/media/outer/url?id=${track.externalId}.mp3`, source: 'direct', match: 'original', track, headers: { Referer: 'https://music.163.com/' } };
  } else if (track.platform === 'qq') {
    const song = await qqSong(track);
    const id = song.mid; const guid = String(Math.floor(Math.random() * 10000000000));
    const mediaMid = song.file?.media_mid || id;
    const formats = [
      { size: song.file?.size_flac, filename: `F000${mediaMid}.flac` },
      { size: song.file?.size_320mp3, filename: `M800${mediaMid}.mp3` },
      { size: true, filename: `M500${mediaMid}.mp3` },
    ].filter(format => format.size);
    const cookie = process.env.QQ_MUSIC_COOKIE?.trim() || '';
    const uin = /(?:^|;\s*)(?:uin|p_uin)=o?(\d+)/.exec(cookie)?.[1] || '0';
    const payload = { req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: formats.map(() => id), filename: formats.map(format => format.filename), songtype: formats.map(() => Number(song.type) || 0), uin, loginflag: 1, platform: '20' } } };
    const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg'); url.search = new URLSearchParams({ format: 'json', data: JSON.stringify(payload) }).toString();
    const body = await platformJson(url.href, { Referer: 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) });
    const data = body.req_0?.data;
    const info = formats.map(format => data?.midurlinfo?.find((entry: any) => entry.filename === format.filename && entry.songmid === id && entry.purl)).find(Boolean);
    if (!info?.purl || info.songmid !== id || !data.sip?.[0]) throw new AppError('SOURCE_UNAVAILABLE', `原 QQ 音乐链接暂时无法取得完整音频${cookie ? '，请核对登录态及账号权限' : '；未配置 QQ_MUSIC_COOKIE，当前按游客取源'}`);
    yield { url: new URL(info.purl, data.sip[0]).href, source: 'direct', match: 'original', track: { ...track, externalId: id, durationSeconds: Number(song.interval) || track.durationSeconds }, headers: { Referer: 'https://y.qq.com/' } };
  }
}
