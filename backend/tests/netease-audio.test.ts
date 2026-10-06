import { describe, expect, it, vi } from 'vitest';
import { TrackSchema } from '../src/contracts';
import { resolveNeteaseAudio } from '../src/music/netease-audio';

const track = TrackSchema.parse({ platform: 'netease', externalId: '123', title: '测试曲目' });
const audio = (id = 123, freeTrialInfo: unknown = null) => ({ data: [{ id, url: 'https://m.music.126.net/audio.flac', freeTrialInfo }] });
describe('网易云原 ID 与音质取源', () => {
  it('优先无损，不触发搜索或额外匹配', async () => {
    const call = vi.fn(async () => audio()); expect((await resolveNeteaseAudio(track, call, true)).url).toContain('.flac'); expect(call.mock.calls).toEqual([['song_url_v1', { id: '123', level: 'lossless' }]]);
  });
  it('高档只返回试听时继续按同一 ID 尝试完整的下一档', async () => {
    const call = vi.fn().mockResolvedValueOnce(audio(123, { start: 0, end: 30 })).mockResolvedValueOnce(audio());
    await resolveNeteaseAudio(track, call, false); expect(call.mock.calls.map(([, q]) => q.level)).toEqual(['lossless', 'exhigh']); expect(call.mock.calls.every(([, q]) => q.id === '123')).toBe(true);
  });
  it('拒绝其他歌曲和全部试听，不把预览放进队列', async () => {
    const call = vi.fn(async () => audio(456)); await expect(resolveNeteaseAudio(track, call, false)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    call.mockResolvedValue(audio(123, { start: 0, end: 30 })); await expect(resolveNeteaseAudio(track, call, false)).rejects.toMatchObject({ code: 'AUDIO_PREVIEW', message: expect.stringContaining('未配置 NETEASE_COOKIE') });
  });
  it('仅 v1 请求全部异常时兼容旧原生接口', async () => {
    const call = vi.fn(async method => { if (method === 'song_url_v1') throw new Error('HTTP 503'); return audio(); });
    await resolveNeteaseAudio(track, call, true); expect(call.mock.calls.at(-1)).toEqual(['song_url', { id: '123', br: 320000 }]);
  });
  it('游客空地址不重复调用旧接口，已配置账号的失败提示明确', async () => {
    const call = vi.fn(async () => ({ data: [{ id: 123, url: null }] }));
    await expect(resolveNeteaseAudio(track, call, true)).rejects.toThrow('请核对账号权限'); expect(call).toHaveBeenCalledTimes(3);
  });
});
