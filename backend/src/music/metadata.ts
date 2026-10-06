import { TrackSchema, type Track } from '../contracts';
import { qqSong } from './direct';
import { diagnostics } from '../core/diagnostics';
export interface TrackMetadata { enrich(track: Track, lyrics: boolean): Promise<Track> }
export class MetadataService implements TrackMetadata {
  async enrich(track: Track, needLyrics: boolean): Promise<Track> {
    if (track.platform === 'qq' && track.externalId && (!track.durationSeconds || track.title === `qq · ${track.externalId}`)) {
      try {
        const song = await qqSong(track);
        return TrackSchema.parse({ ...track, title: song.name || track.title, artists: song.singer?.map((a: { name: string }) => a.name).slice(0, 10) ?? track.artists, album: song.album?.title ?? track.album, durationSeconds: Number(song.interval) || track.durationSeconds });
      } catch (error) { diagnostics.warn('metadata.qq.failed', 'QQ 音乐资料补全失败，保留卡片信息', { error }); return track; }
    }
    if (track.platform !== 'netease' || !/^\d+$/.test(track.externalId)) return track;
    const enriched = { ...track };
    if (!track.durationSeconds || track.title === `netease · ${track.externalId}`) {
      try {
        const data = await this.json(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${track.externalId}]`)}`) as { songs?: { id: number; name?: string; duration?: number; artists?: { name: string }[]; album?: { name?: string } }[] };
        const song = data.songs?.[0];
        if (song?.name && String(song.id) === track.externalId) { enriched.title = song.name; enriched.artists = song.artists?.map(x => x.name).slice(0, 10) ?? enriched.artists; enriched.album = song.album?.name ?? enriched.album; enriched.durationSeconds = (song.duration ?? 0) / 1000; }
      } catch (error) { diagnostics.warn('metadata.netease.failed', '网易云歌曲资料补全失败，保留卡片信息', { error }); }
    }
    if (needLyrics && !track.lyrics) {
      try { const data = await this.json(`https://music.163.com/api/song/lyric?id=${track.externalId}&lv=-1&kv=-1&tv=-1&rv=-1`) as { lrc?: { lyric?: string } }; enriched.lyrics = data.lrc?.lyric?.slice(0, 30000) ?? ''; } catch (error) { diagnostics.warn('metadata.lyric.failed', '歌词取得失败', { error }); }
    }
    const result = TrackSchema.safeParse(enriched); return result.success ? result.data : track;
  }
  private async json(url: string) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Referer: 'https://music.163.com/', 'User-Agent': 'QQMusicBot/0.1' } });
    diagnostics.debug('metadata.http.response', '收到歌曲资料接口响应', { url, status: response.status });
    if (!response.ok || !response.body) throw new Error(`音乐元数据接口返回 HTTP ${response.status}`);
    let text = ''; const decoder = new TextDecoder(); for await (const chunk of response.body) { text += decoder.decode(chunk, { stream: true }); if (text.length > 2000000) throw new Error('音乐元数据过大'); } text += decoder.decode();
    return JSON.parse(text) as unknown;
  }
}
