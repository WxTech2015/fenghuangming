import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackSchema } from '../src/contracts';
vi.mock('../src/music/network', () => ({ openAudioUrl: vi.fn() }));
import { openAudioUrl } from '../src/music/network';
import { originalSources } from '../src/music/direct';

const track = TrackSchema.parse({ platform: 'qq', externalId: '003mid', title: '测试' });
const song = { mid: '003mid', interval: 240, file: { media_mid: '003file', size_flac: 100, size_320mp3: 80 } };
function respond(body: unknown) { return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Awaited<ReturnType<typeof openAudioUrl>>; }
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(openAudioUrl).mockReset(); });
describe('QQ 原歌曲多档音质', () => {
  it('优先可用无损，凭证只传给平台接口', async () => {
    vi.stubEnv('QQ_MUSIC_COOKIE', 'uin=o1234; qm_keyst=test-secret');
    vi.mocked(openAudioUrl).mockResolvedValueOnce(respond({ data: [song] })).mockResolvedValueOnce(respond({ req_0: { data: { sip: ['https://dl.stream.qqmusic.qq.com/'], midurlinfo: [
      { songmid: '003mid', filename: 'M500003file.mp3', purl: '/128.mp3' },
      { songmid: '003mid', filename: 'F000003file.flac', purl: '/lossless.flac' },
      { songmid: '003mid', filename: 'M800003file.mp3', purl: '/320.mp3' },
    ] } } }));
    const source = (await originalSources(track).next()).value!;
    expect(source.url).toContain('/lossless.flac'); expect(source.headers).toEqual({ Referer: 'https://y.qq.com/' });
    const call = vi.mocked(openAudioUrl).mock.calls[1]!;
    expect(call[3]).toHaveProperty('Cookie', 'uin=o1234; qm_keyst=test-secret');
    expect(JSON.parse(new URL(call[0]).searchParams.get('data')!).req_0.param).toMatchObject({ uin: '1234', filename: ['F000003file.flac', 'M800003file.mp3', 'M500003file.mp3'] });
  });
  it('无损无地址时取可用 320kbps，保持原歌曲 ID', async () => {
    vi.stubEnv('QQ_MUSIC_COOKIE', '');
    vi.mocked(openAudioUrl).mockResolvedValueOnce(respond({ data: [song] })).mockResolvedValueOnce(respond({ req_0: { data: { sip: ['https://dl.stream.qqmusic.qq.com/'], midurlinfo: [
      { songmid: '003mid', filename: 'F000003file.flac', purl: '' }, { songmid: '003mid', filename: 'M800003file.mp3', purl: '/320.mp3' },
    ] } } }));
    const source = (await originalSources(track).next()).value!; expect(source.url).toContain('/320.mp3'); expect(source.track?.externalId).toBe('003mid');
    expect(vi.mocked(openAudioUrl).mock.calls[1]![3]).not.toHaveProperty('Cookie');
  });
  it('其他歌曲即使有有效地址也拒绝', async () => {
    vi.stubEnv('QQ_MUSIC_COOKIE', '');
    vi.mocked(openAudioUrl).mockResolvedValueOnce(respond({ data: [song] })).mockResolvedValueOnce(respond({ req_0: { data: { sip: ['https://dl.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: 'other', filename: 'F000003file.flac', purl: '/other.flac' }] } } }));
    await expect(originalSources(track).next()).rejects.toThrow('未配置 QQ_MUSIC_COOKIE');
  });
});
