import { parentPort, workerData } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Track } from '../contracts';
import { resolveNeteaseAudio } from './netease-audio';

// Load only native NetEase requests; keep matching helpers disabled.
const engine = workerData.engine as 'meting' | 'neteaseapi';
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const parse = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const asArray = (value: any) => Array.isArray(value) ? value : [];
function trackFromSong(song: any, original: Track, meting = false): Track {
  return { ...original, externalId: String(song.id), title: String(song.name), artists: asArray(meting ? song.artist : song.ar ?? song.artists).map((v: any) => String(typeof v === 'string' ? v : v.name)).slice(0, 10), album: String(meting ? song.album || '' : song.al?.name ?? song.album?.name ?? ''), durationSeconds: meting ? Number(song.duration ?? 0) : Number(song.dt ?? song.duration ?? 0) / 1000, originalAudioUrl: undefined };
}
let Meting: any; let request: any; let neteaseBase = '';
async function initialize() {
  if (engine === 'meting') Meting = (await nativeImport('@meting/core')).default;
  else {
    neteaseBase = dirname(require.resolve('@neteasecloudmusicapienhanced/api'));
    const token = resolve(tmpdir(), 'anonymous_token'); if (!existsSync(token)) writeFileSync(token, '', { flag: 'wx', mode: 0o600 });
    request = require(resolve(neteaseBase, 'util/request.js'));
  }
}
function unsupported(): never { throw new Error('此音源不支持该平台或缺少原歌曲 ID'); }
function errorDetail(error: any, depth = 0): any {
  if (depth > 3) return undefined;
  return { name: error?.name, message: String(error?.message ?? error?.body?.message ?? error?.body?.msg ?? error), code: error?.code, status: error?.status, platformCode: error?.body?.code, stack: error?.stack, cause: error?.cause ? errorDetail(error.cause, depth + 1) : undefined };
}
async function netease(method: string, query: Record<string, unknown>) {
  const cookieToJson = require(resolve(neteaseBase, 'util/index.js')).cookieToJson;
  const cookie = { ...cookieToJson(process.env.NETEASE_COOKIE || ''), os: 'pc' };
  const input = { ...query, cookie, timeout: method === 'song_url_v1' || method === 'song_url' ? 6000 : 8000 };
  const result = method === 'song_url_v1'
    ? await request('/api/song/enhance/player/url/v1', { ids: JSON.stringify([query.id]), level: query.level, encodeType: 'flac' }, require(resolve(neteaseBase, 'util/option.js'))(input, 'xeapi'))
    : await require(resolve(neteaseBase, `module/${method}.js`))(input, request);
  if (result.status !== 200 || result.body?.code !== 200) throw Object.assign(new Error(`网易云 ${method} 接口失败：HTTP ${result.status} / code ${result.body?.code} ${result.body?.message ?? result.body?.msg ?? ''}`), { status: result.status, code: result.body?.code }); return result.body;
}
async function call(method: string, track: Track) {
  if (engine === 'neteaseapi') {
    if (track.platform !== 'netease' || method === 'resolve' && !/^\d+$/.test(track.externalId)) unsupported();
    if (method === 'search') {
      const body = await netease('cloudsearch', { keywords: `${track.title} ${track.artists.join(' ')}`, type: 1, limit: 5 });
      return asArray(body.result?.songs).map(song => trackFromSong(song, track));
    }
    return resolveNeteaseAudio(track, netease, !!process.env.NETEASE_COOKIE?.trim());
  }
  const platform = { netease: 'netease', qq: 'tencent', kugou: 'kugou', kuwo: 'kuwo' }[track.platform as 'netease' | 'qq' | 'kugou' | 'kuwo'];
  if (!platform || method === 'resolve' && !track.externalId || track.platform === 'qq' && /^\d+$/.test(track.externalId)) unsupported();
  const client = new Meting(platform).format(true);
  const cookie = track.platform === 'qq' ? process.env.QQ_MUSIC_COOKIE : track.platform === 'netease' ? process.env.NETEASE_COOKIE : '';
  if (cookie) client.cookie(cookie);
  if (method === 'search') return asArray(parse(await client.search(`${track.title} ${track.artists.join(' ')}`, { limit: 5, page: 1 }))).map(song => trackFromSong(song, track, true));
  const songs = asArray(parse(await client.song(track.externalId))); const song = songs.find(s => String(s.id).toLowerCase() === track.externalId.toLowerCase());
  if (!song) throw new Error('Meting 返回的歌曲与分享 ID 不一致');
  const result = parse(await client.url(song.url_id || song.id, 999));
  if (!result?.url) throw new Error('Meting 未取得原歌曲音频');
  return { url: result.url, source: engine, headers: { Referer: track.platform === 'qq' ? 'https://y.qq.com/' : track.platform === 'netease' ? 'https://music.163.com/' : track.platform === 'kuwo' ? 'https://www.kuwo.cn/' : 'https://www.kugou.com/' } };
}
void initialize().then(() => {
  parentPort!.postMessage({ type: 'ready' });
  parentPort!.on('message', async ({ id, method, track }) => {
    try { parentPort!.postMessage({ type: 'result', id, result: await call(method, track) }); }
    catch (error) { parentPort!.postMessage({ type: 'result', id, error: errorDetail(error) }); }
  });
}).catch(error => parentPort!.postMessage({ type: 'failed', error: errorDetail(error) }));
