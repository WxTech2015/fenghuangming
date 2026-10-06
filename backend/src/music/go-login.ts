import { diagnostics } from '../core/diagnostics';

// Called only after the managed child has passed its ownership/health check.
// External deployments keep their own credentials and are never updated here.
export async function syncManagedMusicLogin(baseUrl: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const values = Object.fromEntries([['netease', env.NETEASE_COOKIE?.trim()], ['qq', env.QQ_MUSIC_COOKIE?.trim()]].filter((entry): entry is [string, string] => !!entry[1]));
  if (!Object.keys(values).length) return;
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/music' || base.username || base.password) throw new Error('登录态只能同步到本项目托管的本地音源');
  const response = await fetcher(`${base.origin}/music/cookies`, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: JSON.stringify(values) });
  if (!response.ok || (await response.json() as { status?: string }).status !== 'ok') throw new Error(`go-music-dl 登录态同步失败：HTTP ${response.status}`);
  diagnostics.info('gomusicdl.login.synced', '已同步托管音源的平台登录态', { platforms: Object.keys(values), loginProvided: true });
}
