import { TrackSchema, type Track } from '../contracts';
import { openAudioUrl } from '../music/network';
import { isPlatformAudioUrl } from '../music/direct';
import { diagnostics } from '../core/diagnostics';

export function trackFromUrl(raw: string, title = '', artist = '', allowUnresolved = false): Track | null {
  try {
    const url = new URL(raw.replace(/&amp;/g, '&'));
    let platform: Track['platform'] | undefined; let externalId = '';
    const host = url.hostname.toLowerCase();
    if (host === 'music.163.com' || host === 'y.music.163.com') { platform = 'netease'; const hash = url.hash ? new URL(url.hash.slice(1), 'https://music.163.com') : null; externalId = url.searchParams.get('id') ?? hash?.searchParams.get('id') ?? /\/song\/(\d+)/.exec(url.pathname)?.[1] ?? ''; }
    else if (host === 'y.qq.com' || host === 'i.y.qq.com' || host === 'c.y.qq.com') { platform = 'qq'; externalId = url.searchParams.get('songmid') ?? url.searchParams.get('mid') ?? /\/songDetail\/([A-Za-z0-9]+)/i.exec(url.pathname)?.[1] ?? /\/song\/([A-Za-z0-9]+)(?:\.html)?/.exec(url.pathname)?.[1] ?? url.searchParams.get('songid') ?? ''; }
    else if (host === 'www.kugou.com' || host === 'm.kugou.com' || host === 'kugou.com') { platform = 'kugou'; externalId = url.searchParams.get('hash') ?? url.hash.match(/hash=([A-Za-z0-9]+)/)?.[1] ?? ''; }
    else if (host === 'www.kuwo.cn' || host === 'kuwo.cn') { platform = 'kuwo'; externalId = /\/play_detail\/(\d+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('rid') ?? ''; }
    else if (host === 'music.migu.cn' || host === 'm.music.migu.cn') { platform = 'migu'; externalId = /\/song\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('copyrightId') ?? url.searchParams.get('id') ?? ''; }
    else if (host === '163cn.tv') platform = 'netease';
    else if (host === 't1.kugou.com') platform = 'kugou';
    else if (host === 'music.bodian.com' || host === 'www.bodian.com') { platform = 'bodian'; externalId = url.searchParams.get('id') ?? /\/song\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1] ?? ''; }
    if (!platform || !externalId && (!allowUnresolved || !title.trim() || !artist.trim())) return null;
    const parsed = TrackSchema.safeParse({ platform, externalId, title: title.trim() || `${platform} · ${externalId}`, artists: artist ? artist.split(/\s*[／/]\s*/).slice(0, 10) : [], shareUrl: url.href });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function strings(value: unknown, result: string[] = [], depth = 0): string[] {
  if (depth > 10 || result.length > 200) return result;
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, result, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, result, depth + 1);
  return result;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
function attachAudio(track: Track, audio: string): Track { diagnostics.info('card.parse.recognized', '已识别原平台歌曲', { platform: track.platform, externalId: track.externalId, title: track.title, shareUrl: track.shareUrl, hasOriginalAudio: !!audio && isPlatformAudioUrl(audio, track.platform) }); return audio && isPlatformAudioUrl(audio, track.platform) ? { ...track, originalAudioUrl: audio } : track; }
export async function parseMusicCard(message: unknown, expandShortLinks = true): Promise<Track | null> {
  if (!Array.isArray(message)) return null;
  diagnostics.debug('card.parse.start', '识别音乐卡片与分享链接', { segmentTypes: message.slice(0, 50).map(segment => object(segment).type), expandShortLinks });
  for (const segment of message.slice(0, 50)) {
    const s = object(segment); const data = object(s.data); let title = ''; let artist = ''; let audio = ''; let candidates: string[] = []; let unresolved: Track | null = null; let expansions = 0;
    if (s.type === 'music') {
      const platform = data.type === '163' ? 'netease' : data.type === 'qq' ? 'qq' : undefined;
      if (platform && data.id) { const parsed = TrackSchema.safeParse({ platform, externalId: String(data.id), title: String(data.title ?? `${platform} · ${data.id}`), artists: data.content ? [String(data.content)] : [], shareUrl: platform === 'netease' ? `https://music.163.com/song?id=${data.id}` : `https://y.qq.com/n/ryqq/songDetail/${data.id}` }); if (parsed.success) { diagnostics.info('card.parse.recognized', '已识别原平台歌曲', { platform, externalId: parsed.data.externalId, title: parsed.data.title }); return attachAudio(parsed.data, String(data.audio ?? '')); } }
      title = String(data.title ?? ''); artist = String(data.content ?? ''); audio = String(data.audio ?? ''); candidates = strings(data);
    }
    if (s.type === 'json') {
      try {
        const content = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const root = object(content); const meta = object(root.meta);
        const card = object(meta.music ?? meta.news ?? meta.detail_1 ?? Object.values(meta)[0]);
        title = String(card.title ?? card.desc ?? root.prompt ?? '').replace(/^\[分享\]/, '').slice(0, 200);
        artist = String(card.desc ?? card.singer ?? '').slice(0, 300);
        if (artist === title) artist = '';
        audio = String(card.audio ?? card.musicUrl ?? card.audio_url ?? card.playUrl ?? '');
        candidates = strings(content);
      } catch (error) { diagnostics.warn('card.json.invalid', '音乐卡片 JSON 无法解析', { error }); continue; }
    } else if (s.type === 'xml') {
      const xml = String(data.data ?? '');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) continue;
      title = /<title[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i.exec(xml)?.[1] ?? '';
      artist = /<(?:summary|desc)[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i.exec(xml)?.[1] ?? '';
      audio = /(?:musicUrl|audio|audio_url)=["']([^"']+)["']/i.exec(xml)?.[1]?.replace(/&amp;/g, '&') ?? '';
      candidates = [xml];
    } else if (s.type === 'text') candidates = [String(data.text ?? '')];
    for (const candidate of candidates) {
      const urls = candidate.match(/https?:\/\/[^\s"'<>\]]+/g) ?? [];
      for (let raw of urls.slice(0, 10)) {
        const direct = trackFromUrl(raw, title, artist); if (direct) return attachAudio(direct, audio);
        unresolved ??= trackFromUrl(raw, title, artist, true);
        if (!expandShortLinks) continue;
        try {
          const url = new URL(raw);
          if (!['c.y.qq.com', 'y.qq.com', '163cn.tv', 'music.163.com', 'kugou.com', 't1.kugou.com'].includes(url.hostname) || expansions++ >= 3) continue;
          const response = await openAudioUrl(url.href, undefined, 0, {}, 5000);
          // Redirect destination is exposed on IncomingMessage's request URL.
          raw = String((response as unknown as { req: { protocol: string; host: string; path: string } }).req.protocol ?? url.protocol) + '//' + String((response as unknown as { req: { host: string } }).req.host ?? url.host) + String((response as unknown as { req: { path: string } }).req.path ?? url.pathname);
          const expanded = trackFromUrl(raw, title, artist); if (expanded) { response.destroy(); return attachAudio(expanded, audio); }
          let page = ''; try { for await (const chunk of response) { page += chunk.toString(); if (page.length > 2000000) break; } } finally { response.destroy(); }
          // Only trust the page's own canonical target. Other song links on a
          // share page may be recommendations and must never become the song.
          for (const tag of page.match(/<(?:meta|link)\b[^>]*>/gi) ?? []) {
            const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']+)["']/g)].map(m => [m[1]!.toLowerCase(), m[2]!]));
            const link = attributes.property === 'og:url' ? attributes.content : attributes.rel?.toLowerCase() === 'canonical' ? attributes.href : undefined;
            if (link) { const embedded = trackFromUrl(new URL(link, raw).href, title, artist); if (embedded && (!unresolved || embedded.platform === unresolved.platform)) return attachAudio(embedded, audio); }
          }
        } catch (error) { diagnostics.warn('card.shortlink.failed', '音乐短链接展开失败', { url: raw, error }); }
      }
    }
    if (unresolved) return attachAudio(unresolved, audio);
  }
  diagnostics.debug('card.parse.unrecognized', '消息中未识别到受支持的歌曲');
  return null;
}
