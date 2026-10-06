<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton, NInput, NInputNumber, NSelect, NSwitch, NTag, NModal, NForm, NFormItem, NDataTable, NEmpty, NSpin, NRadioGroup, NRadio, NSlider, useMessage, type DataTableColumns } from 'naive-ui';
import { Activity, ArrowUpRight, AudioLines, ChevronRight, Disc3, Headphones, LayoutDashboard, ListMusic, LogOut, Monitor, Pause, Play, Plus, Settings2, ShieldCheck, SkipForward, Volume2, Wifi, X } from 'lucide-vue-next';
import type { AudioEngine, Snapshot, QueueItem, Track, Settings, Playlist } from './contracts';
import { PROJECT_INFO, SettingsSchema, TrackSchema } from './contracts';
import { api, ApiError } from './api';
import GithubDownloadPanel from './components/GithubDownloadPanel.vue';
import PypiDownloadPanel from './components/PypiDownloadPanel.vue';
import DiagnosticsPanel from './components/DiagnosticsPanel.vue';
import PlaybackProgress from './components/PlaybackProgress.vue';
const message = useMessage(); const data = ref<Snapshot>(); const loggedIn = ref(false); const booting = ref(true); const busy = ref(false); const live = ref(false);
const page = ref('overview'); const selectedZone = ref('zone_default'); const search = ref('');
const login = reactive({ username: 'admin', password: '' });
const config = reactive<Settings>(SettingsSchema.parse({})); let configLoaded = false; let stream: EventSource | undefined; let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const nav = [{ key: 'overview', title: '播放总览', icon: LayoutDashboard }, { key: 'devices', title: '群组与设备', icon: Monitor }, { key: 'playlists', title: '我的歌单', icon: ListMusic }, { key: 'policies', title: '播放规则', icon: ShieldCheck }, { key: 'settings', title: '音源与设置', icon: Settings2 }, { key: 'diagnostics', title: '诊断日志', icon: Activity }, { key: 'audit', title: '活动记录', icon: Activity }];
const zone = computed(() => data.value?.zones.find(x => x.id === selectedZone.value));
const device = computed(() => data.value?.agents.find(x => x.zoneId === selectedZone.value));
const current = computed(() => data.value?.queue.find(x => x.id === zone.value?.currentItemId));
const zoneOptions = computed(() => data.value?.zones.map(x => ({ label: x.name, value: x.id })) ?? []);
const waiting = computed(() => (data.value?.queue ?? []).filter(x => x.zoneId === selectedZone.value && ['queued', 'review'].includes(x.status)).sort((a, b) => b.priority - a.priority || (a.promotedAt ?? a.createdAt).localeCompare(b.promotedAt ?? b.createdAt)));
const filteredQueue = computed(() => waiting.value.filter(x => [x.track.title, x.userName, x.userId, ...x.track.artists].join(' ').toLowerCase().includes(search.value.toLowerCase())));
const reviews = computed(() => data.value?.queue.filter(x => x.status === 'review') ?? []);
const onlineCount = computed(() => data.value?.agents.filter(connected).length ?? 0);
const stats = computed(() => [{ title: '等待播放', value: waiting.value.length, suffix: '首', icon: ListMusic, tone: 'violet' }, { title: '已连接设备', value: onlineCount.value, suffix: `/ ${data.value?.agents.length ?? 0} 台`, icon: Monitor, tone: 'mint' }, { title: '每日插队额度', value: data.value?.settings.dailyJumpLimit ?? 0, suffix: '次 / 人', icon: ArrowUpRight, tone: 'peach' }]);
const statusNames: Record<string, string> = { review: '待审核', queued: '待播放', preparing: '准备音源', dispatching: '正在发送', playing: '正在播放', completed: '已播放', failed: '失败', skipped: '已跳过', cancelled: '已移除' };
const engineNames = { gomusicdl: 'go-music-dl', musicdl: 'musicdl', neteaseapi: 'api-enhanced · 网易云', meting: 'Meting', gdstudio: 'GD Studio · GD 音乐台' };
const engineOptions = Object.entries(engineNames).map(([value, label]) => ({ value: value as AudioEngine, label }));
const fallbackOptions = computed(() => engineOptions.filter(x => x.value !== config.audioEngine));
const configuredGo = computed(() => config.audioEngine === 'gomusicdl' || config.fallbackEngines.includes('gomusicdl'));
const configuredGD = computed(() => config.audioEngine === 'gdstudio' || config.fallbackEngines.includes('gdstudio'));
const gdQualities = [{ label: '最高可用音质', value: '999' }, { label: '16bit 无损', value: '740' }, { label: '320kbps', value: '320' }, { label: '192kbps', value: '192' }, { label: '128kbps', value: '128' }];
const runtimeRows = computed(() => engineOptions.map(x => ({ ...x, status: data.value?.musicRuntimes?.[x.value], enabled: data.value?.settings.audioEngine === x.value || !!data.value?.settings.fallbackEngines.includes(x.value) })));
watch(() => config.audioEngine, value => { config.fallbackEngines = config.fallbackEngines.filter(x => x !== value); });
function moveFallback(index: number, direction: number) { const next = [...config.fallbackEngines]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target]!, next[index]!]; config.fallbackEngines = next; }
const musicPhaseNames = { uninstalled: '未安装', stopped: '已安装', installing: '安装中', starting: '启动中', ready: '运行中', external: '外部服务', failed: '失败' };
function connected(a: { lastSeen: string | null }) { return !!a.lastSeen && Date.now() - Date.parse(a.lastSeen) < 45000; }
function online(a: { ready: boolean; lastSeen: string | null }) { return a.ready && connected(a); }
function deviceStatus(a: { ready: boolean; lastSeen: string | null }) { return online(a) ? '就绪' : connected(a) ? '已连接，播放器未就绪' : '离线'; }
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let volumeTimer: ReturnType<typeof setTimeout> | undefined;
function setVolume(value: number) { if (zone.value) zone.value.volume = value; if (volumeTimer) clearTimeout(volumeTimer); volumeTimer = setTimeout(() => void control('volume', value), 350); }
const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
const projectCredit = [PROJECT_INFO.company, PROJECT_INFO.developer && `开发者：${PROJECT_INFO.developer}`].filter(Boolean).join(' · ');
async function refresh() {
  try { const snapshot = await api<Snapshot>('/snapshot'); data.value = snapshot; loggedIn.value = true; if (!configLoaded) { Object.assign(config, structuredClone(snapshot.settings)); configLoaded = true; } if (!snapshot.zones.some(x => x.id === selectedZone.value)) selectedZone.value = snapshot.zones[0]?.id ?? ''; }
  catch (error) { if (error instanceof ApiError && error.status === 401) { loggedIn.value = false; stream?.close(); } else throw error; }
}
function connectEvents() {
  stream?.close(); stream = new EventSource('/api/v1/events');
  stream.onopen = () => { live.value = true; };
  stream.onerror = () => { live.value = false; };
  stream.onmessage = () => { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh().catch(() => { live.value = false; }), 300); };
}
async function run(fn: () => Promise<unknown>, success = '已保存') {
  busy.value = true; try { const result = await fn(); await refresh(); if (success) message.success(success); return result; } catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); return undefined; } finally { busy.value = false; }
}
async function signIn() { await run(async () => { await api('/login', 'POST', login); await refresh(); if (loggedIn.value) connectEvents(); }, '欢迎回来'); }
async function signOut() { await api('/logout', 'POST'); stream?.close(); loggedIn.value = false; data.value = undefined; configLoaded = false; login.password = ''; }
onMounted(async () => { try { await refresh(); if (loggedIn.value) connectEvents(); } catch { message.error('暂时无法连接服务器'); } finally { booting.value = false; } });
onUnmounted(() => { stream?.close(); if (refreshTimer) clearTimeout(refreshTimer); if (volumeTimer) clearTimeout(volumeTimer); });
function control(action: string, volume?: number) { return run(() => api(`/zones/${selectedZone.value}/control`, 'POST', { action, volume }), action === 'volume' ? '' : '已发送控制指令'); }
function button(label: string, action: () => unknown, type: 'default' | 'primary' | 'error' = 'default') { return h(NButton, { size: 'small', secondary: true, type, onClick: action }, { default: () => label }); }
const columns: DataTableColumns<QueueItem> = [
  { title: '音乐', key: 'track', minWidth: 220, render: row => { const preload = data.value?.preloads?.find(value => value.itemId === row.id); return h('div', { class: 'song-cell' }, [h('span', { class: 'mini-art' }, h(Disc3, { size: 19 })), h('div', [h('strong', row.track.title), h('small', row.track.artists.join(' / ') || row.track.platform), row.status === 'queued' && (row.assetId || preload) ? h(NTag, { size: 'small', bordered: false, type: row.assetId || preload?.phase === 'ready' ? 'success' : preload?.phase === 'failed' ? 'warning' : 'info', title: preload?.error ?? '' }, { default: () => row.assetId || preload?.phase === 'ready' ? '已预热' : preload?.phase === 'failed' ? '预热待重试' : '预热中' }) : null])]); } },
  { title: '点歌人', key: 'userName', minWidth: 100, render: row => row.userName || row.userId },
  { title: '状态', key: 'status', minWidth: 100, render: row => h(NTag, { size: 'small', round: true, bordered: false, type: row.status === 'review' ? 'warning' : row.priority ? 'success' : 'default' }, { default: () => row.priority ? '优先播放' : statusNames[row.status] }) },
  { title: '音源', key: 'engine', width: 120, render: row => engineNames[row.engine] },
  { title: '操作', key: 'actions', width: 175, render: row => h('div', { class: 'row-actions' }, [row.status === 'queued' && !row.priority ? button('插队', () => run(() => api(`/queue/${row.id}/promote`, 'POST'), '已加入优先队列')) : row.status === 'review' ? button('审核', () => { page.value = 'policies'; }) : null, button('移除', () => run(() => api(`/queue/${row.id}`, 'DELETE'), '已移除'))]) },
];
const showTrack = ref(false); const trackTarget = ref<'queue' | 'playlist'>('queue'); const trackForm = reactive({ platform: 'netease', externalId: '', title: '', artist: '', durationSeconds: 0, userId: 'admin', userName: '管理员' });
const platforms = [{ label: '网易云音乐', value: 'netease' }, { label: 'QQ 音乐', value: 'qq' }, { label: '酷狗', value: 'kugou' }, { label: '酷我', value: 'kuwo' }, { label: '咪咕', value: 'migu' }];
function openTrack(target: 'queue' | 'playlist') { trackTarget.value = target; Object.assign(trackForm, { externalId: '', title: '', artist: '', durationSeconds: 0 }); showTrack.value = true; }
async function addTrack() {
  await run(async () => {
    const track = TrackSchema.parse({ ...trackForm, artists: trackForm.artist ? trackForm.artist.split('/').map(x => x.trim()) : [] });
    if (trackTarget.value === 'queue') await api('/queue', 'POST', { zoneId: selectedZone.value, userId: trackForm.userId, userName: trackForm.userName, track, requestKey: crypto.randomUUID() });
    else { const p = selectedPlaylist.value; if (!p) throw new Error('请先选择歌单'); await api(`/playlists/${p.id}`, 'PUT', { name: p.name, zoneId: p.zoneId, tracks: [...p.tracks, track] }); }
    showTrack.value = false;
  }, '歌曲已添加');
}
const showZone = ref(false); const editZone = ref<string>(); const zoneForm = reactive({ name: '', volume: 50, enabled: true });
function openZone(zoneId?: string) { editZone.value = zoneId; const old = data.value?.zones.find(x => x.id === zoneId); Object.assign(zoneForm, old ? { name: old.name, volume: old.volume, enabled: old.enabled } : { name: '', volume: 50, enabled: true }); showZone.value = true; }
const showBinding = ref(false); const bindingForm = reactive({ botId: '', groupId: '', zoneId: 'zone_default', enabled: true });
const botOptions = computed(() => (data.value?.bots ?? []).filter(bot => bot.connected).map(bot => ({ label: `${bot.nickname}（${bot.id}）`, value: bot.id })));
const connectedBot = computed(() => data.value?.bots.find(bot => bot.id === bindingForm.botId && bot.connected));
const groupOptions = computed(() => connectedBot.value?.groups.map(group => ({ label: `${group.name}（${group.id}）`, value: group.id })) ?? []);
watch(() => bindingForm.botId, () => { bindingForm.groupId = ''; });
function openBinding() { bindingForm.zoneId = selectedZone.value; if (!botOptions.value.some(bot => bot.value === bindingForm.botId)) bindingForm.botId = botOptions.value[0]?.value ?? ''; bindingForm.groupId = ''; showBinding.value = true; }
const bindingGroupName = (botId: string, groupId: string) => data.value?.bots.find(bot => bot.id === botId)?.groups.find(group => group.id === groupId)?.name ?? `QQ群 ${groupId}`;
const groupFeatures = [{ command: '#menu', detail: '查看菜单，也支持 #菜单、#帮助' }, { command: '#点歌 音乐链接', detail: '支持音乐卡片和分享链接' }, { command: '#正在播放 / #队列', detail: '查看当前播放与排队编号' }, { command: '#我的', detail: '自己的点歌与剩余插队次数' }, { command: '#插队 [编号] / #取消 [编号]', detail: '仅本群自己的歌曲，省略编号取最近一首' }, { command: '#歌单 / #歌单 序号或名称', detail: '查看或播放本区歌单' }, { command: '#切歌 / #暂停 / #继续 / #音量 50', detail: '仅群主、管理员' }];
const showAgent = ref(false); const agentForm = reactive({ name: '', zoneId: 'zone_default' }); const freshAgent = ref<{ agent: { id: string; name: string }; token: string }>();
const deviceConfig = reactive({ serverUrl: import.meta.env.DEV ? `${location.protocol}//${location.hostname}:${__BACKEND_PORT__}` : location.origin, mpvPath: '', dataDir: 'C:\\ProgramData\\QQMusicAgent' });
const customPlayer = ref(false);
async function registerAgent() { const result = await run(() => api<{ agent: { id: string; name: string }; token: string }>('/agents', 'POST', agentForm), '设备已注册'); if (result) { freshAgent.value = result as typeof freshAgent.value; showAgent.value = false; } }
function downloadConfig() { if (customPlayer.value && !deviceConfig.mpvPath.trim()) { message.error('请填写自己的 mpv.exe 路径'); return; } const url = URL.createObjectURL(new Blob([JSON.stringify({ ...deviceConfig, mpvPath: customPlayer.value ? deviceConfig.mpvPath : 'auto', token: freshAgent.value?.token }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'agent.config.json'; a.click(); URL.revokeObjectURL(url); }
const agentInstallCommand = computed(() => {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  let command = `.\\fenghuangming-agent.exe --install --endpoint ${quote(deviceConfig.serverUrl)} --token ${quote(freshAgent.value?.token ?? '')} --data-dir ${quote(deviceConfig.dataDir)}`;
  if (customPlayer.value) command += ` --mpv ${quote(deviceConfig.mpvPath)}`;
  return command;
});
async function copyAgentCommand(event: MouseEvent) {
  try {
    if (customPlayer.value && !deviceConfig.mpvPath.trim()) throw new Error('请填写自己的 mpv.exe 路径');
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(agentInstallCommand.value);
    else {
      const field = document.createElement('textarea'); field.value = agentInstallCommand.value; field.style.cssText = 'position:fixed;opacity:0;'; ((event.currentTarget as HTMLElement | null)?.closest('.form-modal') ?? document.body).appendChild(field);
      try { field.select(); if (!document.execCommand('copy')) throw new Error('请下载配置后使用 --install --config 安装'); }
      finally { field.remove(); }
    }
    message.success('安装命令已复制，请在播放电脑的管理员 PowerShell 中执行');
  } catch (error) { message.error(error instanceof Error ? error.message : '复制失败，请下载配置'); }
}
const showBan = ref(false); const banForm = reactive({ kind: 'user', value: '', scope: 'global', scopeId: '', reason: '管理员禁用' });
const banColumns: DataTableColumns<Snapshot['blacklists'][number]> = [{ title: '类型', key: 'kind', render: r => r.kind === 'user' ? '用户' : '歌曲' }, { title: '对象', key: 'value' }, { title: '范围', key: 'scope', render: r => r.scope === 'global' ? '全局' : `${r.scope === 'zone' ? '播放区' : '群'} / ${r.scopeId}` }, { title: '原因', key: 'reason' }, { title: '', key: 'action', width: 80, render: r => button('解除', () => run(() => api(`/blacklists/${r.id}`, 'DELETE'), '已解除限制')) }];
const playlistId = ref(''); const selectedPlaylist = computed(() => data.value?.playlists.find(p => p.id === playlistId.value)); const showPlaylist = ref(false); const playlistForm = reactive({ name: '', zoneId: 'zone_default' });
async function removeTrack(p: Playlist, index: number) { await run(() => api(`/playlists/${p.id}`, 'PUT', { ...p, tracks: p.tracks.filter((_, i) => i !== index) }), '已从歌单移除'); }
async function saveConfig() { await run(() => api('/settings', 'PUT', config), '设置已保存'); }
const quotaColumns: DataTableColumns<Snapshot['quotas'][number]> = [{ title: '用户 QQ', key: 'userId' }, { title: '日期（上海）', key: 'date' }, { title: '已使用', key: 'used', render: r => `${r.used} / ${data.value?.settings.dailyJumpLimit ?? 0}` }];
const auditColumns: DataTableColumns<Snapshot['audit'][number]> = [{ title: '时间', key: 'createdAt', width: 190, render: r => new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false }) }, { title: '操作', key: 'action', width: 190 }, { title: '详情', key: 'detail' }];
</script>

<template>
  <div class="ambient"><div class="orb orb-a"/><div class="orb orb-b"/><div class="orb orb-c"/></div>
  <div v-if="booting" class="loading-screen"><n-spin size="large"/><p>正在连接{{ PROJECT_INFO.name }}…</p></div>
  <main v-else-if="!loggedIn" class="login-shell">
    <section class="glass login-card"><div class="brand-mark"><AudioLines :size="27"/></div><h1>{{ PROJECT_INFO.name }}</h1><p class="muted">QQ 点歌管理</p>
      <n-form @submit.prevent="signIn"><n-form-item label="用户名"><n-input v-model:value="login.username" autocomplete="username" placeholder="管理员用户名"/></n-form-item><n-form-item label="密码"><n-input v-model:value="login.password" type="password" show-password-on="click" autocomplete="current-password" placeholder="管理员密码" @keydown.enter="signIn"/></n-form-item><n-button type="primary" block size="large" :loading="busy" @click="signIn">进入控制台 <ChevronRight :size="16"/></n-button></n-form>
      <p v-if="projectCredit" class="login-foot">{{ projectCredit }}</p>
    </section>
  </main>
  <div v-else class="app-shell">
    <aside class="sidebar glass"><a class="brand" @click="page = 'overview'"><span class="brand-mark"><AudioLines :size="24"/></span><b>{{ PROJECT_INFO.name }}</b></a>
      <nav><button v-for="item in nav" :key="item.key" :class="{ active: page === item.key }" @click="page = item.key"><component :is="item.icon" :size="19"/><span>{{ item.title }}</span><span v-if="item.key === 'policies' && reviews.length" class="nav-badge">{{ reviews.length }}</span></button></nav>
      <div class="sidebar-bottom"><div class="connection-card"><span :class="['status-dot', { online: data?.botConnected }]"/><span><b>{{ data?.botConnected ? 'NapCat 已连接' : 'NapCat 未连接' }}</b><small v-if="data?.botConnected">{{ data?.bots.find(bot => bot.connected)?.nickname }}</small></span></div><button class="logout" @click="signOut"><LogOut :size="17"/>退出登录</button></div>
    </aside>
    <main class="workspace">
      <header class="topbar"><span>{{ dateLabel }}</span><div class="topbar-right"><span v-if="data?.storageDriver === 'file'" class="demo-pill">本地存储</span><span class="live-pill"><span :class="['status-dot', { online: live }]"/>{{ live ? '实时同步' : '正在重连' }}</span><span class="avatar">管</span></div></header>
      <div class="page-heading"><h1>{{ nav.find(n => n.key === page)?.title }}</h1><n-button v-if="page === 'overview'" type="primary" size="large" @click="openTrack('queue')"><Plus :size="18"/>手动点歌</n-button></div>
      <template v-if="page === 'overview'">
        <div class="zone-switch"><button v-for="z in data?.zones" :key="z.id" :class="{ selected: z.id === selectedZone }" @click="selectedZone = z.id"><Headphones :size="15"/>{{ z.name }}<span v-if="!z.enabled" class="tiny">已停用</span></button><button class="icon-only" aria-label="新增播放区" @click="openZone()"><Plus :size="17"/></button></div>
        <section class="overview-grid"><article class="glass now-playing"><div class="section-label"><span :class="['status-dot', { online: current?.status === 'playing' }]"/>{{ current ? statusNames[current.status] : '暂无播放' }}<n-tag v-if="current" size="small" round :bordered="false">{{ engineNames[current.engine] }}</n-tag></div>
          <div class="player-main"><div class="album-art"><img v-if="current?.track.coverUrl" :src="current.track.coverUrl" alt="专辑封面"/><div v-else class="vinyl"><span/><Disc3 :size="74" :stroke-width="1"/></div><span class="art-spark">✦</span></div><div class="track-info"><h2>{{ current?.track.title || '暂无歌曲' }}</h2><p v-if="!current || current.track.artists.length">{{ current ? current.track.artists.join(' / ') : '在群内分享音乐卡片或链接' }}</p><div class="requester"><span class="requester-icon"><Headphones :size="14"/></span>{{ current ? `由 ${current.userName || current.userId} 点播` : zone?.name }}</div></div></div>
          <playback-progress :zone-id="selectedZone" :item="current" :agent="device" :connected="!!device && connected(device)"/>
          <div class="player-controls"><span :class="['device-note', { connected: device && connected(device) }]"><Monitor :size="15"/>{{ device ? `${device.name} · ${deviceStatus(device)}` : '尚未绑定播放设备' }}</span><div class="transport-controls"><button class="play-button" :disabled="!current || current.status !== 'playing'" :aria-label="device?.paused ? '继续播放' : '暂停'" @click="control(device?.paused ? 'resume' : 'pause')"><Play v-if="device?.paused || !current" :size="23"/><Pause v-else :size="23"/></button><button class="skip-button" :disabled="!current" aria-label="跳过当前歌曲" @click="control('skip')"><SkipForward :size="22"/></button></div><div class="volume"><Volume2 :size="17"/><n-slider :value="zone?.volume ?? 50" :step="1" :tooltip="true" @update:value="setVolume" aria-label="播放音量"/></div></div>
        </article><aside class="insights"><article v-for="s in stats" :key="s.title" :class="['glass stat-card', s.tone]"><span class="stat-icon"><component :is="s.icon" :size="22"/></span><div><p>{{ s.title }}</p><strong>{{ s.value }}</strong><small>{{ s.suffix }}</small></div></article></aside></section>
        <section class="glass panel queue-panel"><div class="panel-heading"><div><h2>播放队列 <span class="count-pill">{{ waiting.length }}</span></h2><p>插队优先排队，不打断当前播放。</p></div><n-input v-model:value="search" placeholder="搜索音乐或点歌人" clearable class="queue-search"/></div><n-data-table :columns="columns" :data="filteredQueue" :bordered="false" :scroll-x="730" :pagination="{ pageSize: 8 }"><template #empty><div class="friendly-empty"><span class="empty-icon"><ListMusic :size="30"/></span><h3>队列为空</h3><p>在绑定群分享音乐，或手动点歌。</p></div></template></n-data-table></section>
        <div v-if="data?.queue.some(x => x.status === 'failed')" class="glass panel failure-panel"><h3>最近播放失败</h3><div v-for="item in data.queue.filter(x => x.status === 'failed').slice(0, 3)" :key="item.id" class="failure-row"><b>{{ item.track.title }}</b><span>{{ item.error }}</span></div></div>
      </template>
      <template v-else-if="page === 'devices'">
        <section class="glass panel"><div class="panel-heading"><div><h2>NapCat 账号</h2></div><n-button secondary :loading="busy" @click="run(() => api('/onebot/refresh', 'POST'), '账号与群列表已同步')">刷新账号与群</n-button></div><n-empty v-if="!data?.bots.length" description="NapCat 未连接"/><div v-for="bot in data?.bots" :key="bot.id" class="entity-row"><span class="entity-icon"><Wifi :size="22"/></span><div class="entity-main"><strong>{{ bot.nickname }} · {{ bot.id }}</strong><small>{{ bot.groups.length }} 个群 · {{ bot.lastSyncedAt ? `同步于 ${new Date(bot.lastSyncedAt).toLocaleTimeString()}` : '正在读取群列表' }}<template v-if="bot.syncError"> · {{ bot.syncError }}</template></small></div><n-tag :type="bot.connected ? 'success' : 'default'" :bordered="false">{{ bot.connected ? '已连接' : '已断开' }}</n-tag></div><p v-if="data?.onebotError" class="help-text">{{ data.onebotError }}</p></section>
        <div class="two-col"><section class="glass panel"><div class="panel-heading"><div><h2>播放区</h2></div><n-button secondary type="primary" @click="openZone()"><Plus :size="16"/>新增</n-button></div><div v-for="z in data?.zones" :key="z.id" class="entity-row"><span class="entity-icon"><Headphones :size="22"/></span><div class="entity-main"><strong>{{ z.name }}</strong><small>{{ z.id }} · 音量 {{ z.volume }}%</small></div><n-tag size="small" :type="z.enabled ? 'success' : 'default'" :bordered="false">{{ z.enabled ? '启用' : '停用' }}</n-tag><n-button text @click="openZone(z.id)">编辑</n-button></div></section>
        <section class="glass panel"><div class="panel-heading"><div><h2>播放设备</h2></div><n-button secondary type="primary" @click="agentForm.zoneId = selectedZone; showAgent = true"><Plus :size="16"/>注册</n-button></div><n-empty v-if="!data?.agents.length" description="暂无设备"/><div v-for="a in data?.agents" :key="a.id" class="entity-row"><span class="entity-icon mint"><Monitor :size="22"/></span><div class="entity-main"><strong>{{ a.name }}</strong><small>{{ data?.zones.find(z => z.id === a.zoneId)?.name }} · {{ a.lastSeen ? `最近连接 ${new Date(a.lastSeen).toLocaleTimeString()}` : '等待首次连接' }}</small></div><n-tag size="small" :type="online(a) ? 'success' : 'default'" :bordered="false">{{ deviceStatus(a) }}</n-tag><n-button text type="error" @click="run(() => api(`/agents/${a.id}`, 'DELETE'), '设备已移除')">移除</n-button></div></section></div>
        <section class="glass panel"><div class="panel-heading"><div><h2>QQ 群绑定</h2><p>仅启用绑定的群可点歌。</p></div><n-button type="primary" secondary :disabled="!botOptions.length" @click="openBinding"><Plus :size="16"/>添加绑定</n-button></div><n-empty v-if="!data?.bindings.length" description="暂无绑定"/><div v-for="b in data?.bindings" :key="b.id" class="entity-row"><span class="entity-icon"><Wifi :size="22"/></span><div class="entity-main"><strong>{{ bindingGroupName(b.botId, b.groupId) }}</strong><small>群 {{ b.groupId }} · 机器人 {{ b.botId }} → {{ data?.zones.find(z => z.id === b.zoneId)?.name }}</small></div><n-switch :value="b.enabled" @update:value="value => run(() => api('/bindings', 'POST', { ...b, enabled: value }))"/><n-button text type="error" @click="run(() => api(`/bindings/${b.id}`, 'DELETE'), '绑定已移除')">移除</n-button></div></section>
        <section class="glass panel"><div class="panel-heading"><div><h2>群内功能菜单</h2><p>在绑定群发送 #menu 查看。</p></div><ListMusic :size="24"/></div><div v-for="feature in groupFeatures" :key="feature.command" class="entity-row"><div class="entity-main"><strong>{{ feature.command }}</strong><small>{{ feature.detail }}</small></div></div></section>
      </template>
      <template v-else-if="page === 'playlists'">
        <div class="playlist-layout"><section class="glass panel"><div class="panel-heading"><h2>音乐收藏</h2><n-button secondary type="primary" @click="playlistForm.zoneId = selectedZone; showPlaylist = true"><Plus :size="16"/>创建</n-button></div><n-empty v-if="!data?.playlists.length" description="暂无歌单"/><button v-for="p in data?.playlists" :key="p.id" :class="['playlist-tile', { selected: playlistId === p.id }]" @click="playlistId = p.id"><span class="playlist-cover"><ListMusic :size="27"/></span><span><b>{{ p.name }}</b><small>{{ p.tracks.length }} 首 · {{ data?.zones.find(z => z.id === p.zoneId)?.name }}</small></span><ChevronRight :size="17"/></button></section>
        <section class="glass panel"><template v-if="selectedPlaylist"><div class="panel-heading"><div><h2>{{ selectedPlaylist.name }}</h2><p>{{ selectedPlaylist.tracks.length }} 首歌曲</p></div><div class="row-actions"><n-button secondary @click="openTrack('playlist')"><Plus :size="16"/>添加歌曲</n-button><n-button type="primary" @click="run(() => api(`/playlists/${selectedPlaylist!.id}/enqueue`, 'POST').then((r: any) => { const failures = r.filter((x: any) => x.error); if (failures.length) message.warning(`${failures.length} 首未入队：${failures[0].error}`); }), '歌单入队已处理')"><Play :size="16"/>加入队列</n-button></div></div><n-empty v-if="!selectedPlaylist.tracks.length" description="暂无歌曲"/><div v-for="(t, i) in selectedPlaylist.tracks" :key="`${t.platform}:${t.externalId}:${i}`" class="entity-row"><span class="track-number">{{ String(i + 1).padStart(2, '0') }}</span><span class="mini-art"><Disc3 :size="22"/></span><div class="entity-main"><strong>{{ t.title }}</strong><small>{{ t.artists.join(' / ') || t.platform }} · {{ t.externalId }}</small></div><n-button text @click="removeTrack(selectedPlaylist, i)"><X :size="17"/></n-button></div><n-button class="delete-playlist" text type="error" @click="run(() => api(`/playlists/${selectedPlaylist!.id}`, 'DELETE'), '歌单已移除')">删除歌单</n-button></template><n-empty v-else description="请选择歌单"/></section></div>
      </template>
      <template v-else-if="page === 'policies'">
        <section class="glass panel"><div class="panel-heading"><div><h2>等待审核 <span class="count-pill">{{ reviews.length }}</span></h2></div></div><n-empty v-if="!reviews.length" description="暂无待审核歌曲"/><div v-for="r in reviews" :key="r.id" class="entity-row"><span class="mini-art"><Disc3 :size="23"/></span><div class="entity-main"><strong>{{ r.track.title }} · {{ r.userName || r.userId }}</strong><small>{{ r.reviewReason }}</small></div><n-button type="primary" secondary @click="run(() => api(`/queue/${r.id}/review`, 'POST', { approve: true }), '已通过审核')">通过</n-button><n-button secondary @click="run(() => api(`/queue/${r.id}/review`, 'POST', { approve: false }), '已拒绝')">拒绝</n-button></div></section>
        <section class="glass panel"><div class="panel-heading"><div><h2>黑名单</h2><p>禁用 QQ 号或平台歌曲 ID。</p></div><n-button type="primary" secondary @click="showBan = true"><Plus :size="16"/>添加限制</n-button></div><n-data-table :columns="banColumns" :data="data?.blacklists ?? []" :bordered="false" :scroll-x="650"/></section>
        <section class="glass panel"><div class="panel-heading"><div><h2>插队使用记录</h2><p>跨群共享，每日北京时间 00:00 重置。</p></div><n-tag :bordered="false" round>{{ data?.settings.dailyJumpLimit }} 次 / 人 / 天</n-tag></div><n-data-table :columns="quotaColumns" :data="data?.quotas ?? []" :bordered="false" :pagination="{ pageSize: 10 }"/></section>
      </template>
      <template v-else-if="page === 'settings'">
        <section class="glass panel settings-panel"><div class="panel-heading"><div><h2>音源配置</h2></div><n-button type="primary" :loading="busy" @click="saveConfig">保存设置</n-button></div>
          <n-form class="settings-grid"><n-form-item label="首选备用音源"><n-select v-model:value="config.audioEngine" :options="engineOptions"/></n-form-item><n-form-item label="继续尝试的音源"><n-select v-model:value="config.fallbackEngines" multiple :options="fallbackOptions" placeholder="可不选择；按下方顺序尝试"/></n-form-item></n-form>
          <div v-for="(engine, index) in config.fallbackEngines" :key="engine" class="fallback-row"><span>{{ index + 1 }}. {{ engineNames[engine] }}</span><n-button size="tiny" secondary :disabled="index === 0" @click="moveFallback(index, -1)">上移</n-button><n-button size="tiny" secondary :disabled="index === config.fallbackEngines.length - 1" @click="moveFallback(index, 1)">下移</n-button></div>
          <div class="search-fallback"><div><strong>按歌名匹配同曲</strong><p>取源失败后尝试匹配同曲。</p></div><n-switch v-model:value="config.searchFallback"/></div>
          <n-form v-if="configuredGo"><n-form-item label="go-music-dl 运行方式"><n-radio-group v-model:value="config.gomusicdl.mode"><n-radio value="managed" label="本地托管"/><n-radio value="external" label="外部服务"/></n-radio-group></n-form-item></n-form>
          <n-form v-if="configuredGo && config.gomusicdl.mode === 'external'" label-placement="top"><n-form-item label="go-music-dl 音乐接口地址"><n-input v-model:value="config.gomusicdl.baseUrl" placeholder="http://127.0.0.1:8080/music"/><template #feedback>接口地址需以 /music 结尾。</template></n-form-item></n-form>
          <n-form v-if="configuredGD" label-placement="top"><n-form-item label="GD Studio 音质"><n-select v-model:value="config.gdstudio.quality" :options="gdQualities"/><template #feedback>由 <a href="https://music.gdstudio.xyz" target="_blank" rel="noopener noreferrer">GD 音乐台</a>提供，保存设置即可使用。支持网易云、QQ 音乐、酷我。</template></n-form-item></n-form>
          <div v-for="runtime in runtimeRows" :key="runtime.value" class="runtime-status">
            <div class="runtime-heading">
              <n-tag round :bordered="false" :type="runtime.status?.phase === 'ready' || runtime.value === 'gdstudio' && runtime.status?.phase === 'external' ? 'success' : runtime.status?.phase === 'failed' ? 'error' : 'default'">{{ runtime.status ? runtime.value === 'gdstudio' && runtime.status.phase === 'external' ? '已启用' : runtime.status.mode === 'external' && runtime.status.phase === 'stopped' ? '未启用' : musicPhaseNames[runtime.status.phase] : '未连接' }}</n-tag>
              <span>{{ runtime.label }} {{ runtime.status?.version }}</span>
              <n-tag v-if="runtime.status?.mode === 'builtin'" size="small" :bordered="false">内置</n-tag>
              <div class="runtime-actions">
                <n-button v-if="runtime.status?.mode === 'managed' && (!runtime.status.installed || runtime.status.phase === 'failed')" size="small" secondary :loading="runtime.status.phase === 'installing'" :disabled="busy || ['installing', 'starting'].includes(runtime.status.phase)" @click="run(() => api('/music/install', 'POST', { engine: runtime.value }), '已提交安装任务')">{{ runtime.status.phase === 'failed' ? runtime.status.installed ? '重新安装' : '重试安装' : '安装' }}</n-button>
                <n-button v-if="runtime.value !== 'gdstudio' && runtime.enabled && runtime.status?.installed && !['external', 'installing'].includes(runtime.status.phase)" size="small" secondary :disabled="busy || runtime.status.phase === 'starting'" @click="run(() => api('/music/restart', 'POST', { engine: runtime.value }), '已提交启动任务')">{{ runtime.status.phase === 'failed' ? '重试启动' : '重启' }}</n-button>
              </div>
            </div>
            <p v-if="runtime.status?.error" class="runtime-error">{{ runtime.status.error }}</p>
          </div>
        </section>
        <GithubDownloadPanel v-model="config.githubDownload" :state="data?.githubDownload" :busy="busy" @test="run(() => api('/music/github-mirrors/test', 'POST'), '已开始测速')"/>
        <PypiDownloadPanel v-model="config.pypiDownload" :state="data?.pypiDownload" :busy="busy" @test="run(() => api('/music/pypi-mirrors/test', 'POST'), '已开始测速')"/>
        <section class="glass panel settings-panel"><h2>歌曲下载与预热</h2><n-form class="settings-grid"><n-form-item label="每个播放区预热后几首"><n-input-number v-model:value="config.downloads.preloadCount" :min="0" :max="10"/><template #feedback>0 表示关闭预热。</template></n-form-item><n-form-item label="同时预热歌曲数"><n-input-number v-model:value="config.downloads.preloadConcurrency" :min="1" :max="4"/></n-form-item><n-form-item label="单曲并行连接数"><n-input-number v-model:value="config.downloads.connections" :min="1" :max="8"/><template #feedback>音源不支持分段时自动使用单连接。</template></n-form-item></n-form></section>
        <section class="glass panel settings-panel"><h2>队列规则</h2><n-form class="settings-grid"><n-form-item label="每人每天插队次数"><n-input-number v-model:value="config.dailyJumpLimit" :min="0" :max="999"/><template #feedback>0 表示关闭插队。</template></n-form-item><n-form-item label="每人最多待播歌曲"><n-input-number v-model:value="config.maxPendingPerUser" :min="1" :max="100"/></n-form-item><n-form-item label="播放区队列上限"><n-input-number v-model:value="config.maxQueueSize" :min="1" :max="1000"/></n-form-item><n-form-item label="歌曲最长时长（秒）"><n-input-number v-model:value="config.maxDurationSeconds" :min="30" :max="7200"/></n-form-item><n-form-item label="服务器缓存上限（MB）"><n-input-number v-model:value="config.cacheMaxMb" :min="100" :max="100000"/></n-form-item></n-form></section>
        <section class="glass panel settings-panel"><div class="panel-heading"><div><h2>AI 歌曲审核</h2><p>审核歌名、歌手和歌词。</p></div><n-switch v-model:value="config.ai.enabled"/></div><n-form class="settings-grid" v-if="config.ai.enabled"><n-form-item label="兼容接口地址"><n-input v-model:value="config.ai.baseUrl" placeholder="https://服务地址/v1"/></n-form-item><n-form-item label="模型名称"><n-input v-model:value="config.ai.model" placeholder="填写你使用的模型"/></n-form-item><n-form-item label="无法审核时"><n-select v-model:value="config.ai.unknownAction" :options="[{ label: '等待人工审核', value: 'review' }, { label: '允许播放', value: 'allow' }]"/></n-form-item><n-form-item class="full-width" label="审核规则"><n-input v-model:value="config.ai.policy" type="textarea" :autosize="{ minRows: 3 }"/></n-form-item></n-form><n-button type="primary" :loading="busy" @click="saveConfig">保存全部设置</n-button></section>
      </template>
      <DiagnosticsPanel v-else-if="page === 'diagnostics'" :queue="data?.queue ?? []" :engines="engineOptions"/>
      <section v-else-if="page === 'audit'" class="glass panel"><div class="panel-heading"><div><h2>最近活动</h2><p>最近 100 条</p></div></div><n-data-table :columns="auditColumns" :data="data?.audit ?? []" :bordered="false" :scroll-x="650" :pagination="{ pageSize: 15 }"/></section>
      <footer class="page-footer"><span>{{ projectCredit || PROJECT_INFO.name }}</span><span>v0.1.0</span></footer>
    </main>
  </div>
  <n-modal v-model:show="showTrack" preset="card" :title="trackTarget === 'queue' ? '手动点歌' : '添加到歌单'" class="form-modal"><n-form label-placement="top" class="modal-grid"><n-form-item label="平台"><n-select v-model:value="trackForm.platform" :options="platforms"/></n-form-item><n-form-item label="歌曲 ID"><n-input v-model:value="trackForm.externalId" placeholder="网易云数字 ID / QQ songmid"/></n-form-item><n-form-item class="full-width" label="歌名"><n-input v-model:value="trackForm.title" placeholder="完整歌名"/></n-form-item><n-form-item label="歌手"><n-input v-model:value="trackForm.artist" placeholder="多位歌手用 / 分隔"/></n-form-item><n-form-item label="时长（秒，未知填 0）"><n-input-number v-model:value="trackForm.durationSeconds" :min="0" :max="14400"/></n-form-item><n-form-item v-if="trackTarget === 'queue'" label="点歌人 QQ / 标识"><n-input v-model:value="trackForm.userId"/></n-form-item><n-form-item v-if="trackTarget === 'queue'" label="显示名称"><n-input v-model:value="trackForm.userName"/></n-form-item></n-form><n-button type="primary" block :loading="busy" @click="addTrack">添加歌曲</n-button></n-modal>
  <n-modal v-model:show="showZone" preset="card" :title="editZone ? '编辑播放区' : '新增播放区'" class="form-modal"><n-form><n-form-item label="名称"><n-input v-model:value="zoneForm.name" placeholder="例如：客厅、办公室"/></n-form-item><n-form-item label="默认音量"><n-input-number v-model:value="zoneForm.volume" :min="0" :max="100"/></n-form-item><n-form-item label="启用播放区"><n-switch v-model:value="zoneForm.enabled"/></n-form-item></n-form><n-button type="primary" block @click="run(async () => { await api(editZone ? `/zones/${editZone}` : '/zones', editZone ? 'PUT' : 'POST', zoneForm); showZone = false; })">保存</n-button></n-modal>
  <n-modal v-model:show="showBinding" preset="card" title="绑定 QQ 群" class="form-modal"><n-form><n-form-item label="NapCat 登录账号"><n-select v-model:value="bindingForm.botId" :options="botOptions" :disabled="botOptions.length === 1" placeholder="先连接 NapCat"/></n-form-item><n-form-item label="QQ 群"><n-select v-model:value="bindingForm.groupId" filterable :options="groupOptions" placeholder="选择 NapCat 所在群"/><template #feedback>群列表缺失时，点击「刷新账号与群」。</template></n-form-item><n-form-item label="播放区"><n-select v-model:value="bindingForm.zoneId" :options="zoneOptions"/></n-form-item></n-form><n-button type="primary" block :disabled="!bindingForm.botId || !bindingForm.groupId" :loading="busy" @click="run(async () => { await api('/bindings', 'POST', bindingForm); showBinding = false; })">保存绑定</n-button></n-modal>
  <n-modal v-model:show="showAgent" preset="card" title="注册播放设备" class="form-modal"><n-form><n-form-item label="设备名称"><n-input v-model:value="agentForm.name" placeholder="例如：办公室电脑"/></n-form-item><n-form-item label="播放区"><n-select v-model:value="agentForm.zoneId" :options="zoneOptions"/></n-form-item></n-form><n-button type="primary" block @click="registerAgent">注册并生成配置</n-button></n-modal>
  <n-modal :show="!!freshAgent" preset="card" title="设备配置已生成" class="form-modal" @update:show="value => { if (!value) freshAgent = undefined; }">
    <p class="help-text">凭证仅显示一次，请下载配置。</p>
    <n-form>
      <n-form-item label="服务器地址"><n-input v-model:value="deviceConfig.serverUrl" placeholder="http://网站地址"/><template #feedback>填写 HTTP / HTTPS 根地址；使用非默认端口时加 :端口。</template></n-form-item>
      <n-form-item label="播放器"><span class="help-text">默认使用安装包内置 mpv，无需另装。</span></n-form-item>
      <n-form-item label="使用自己的播放器"><n-switch v-model:value="customPlayer"/></n-form-item>
      <n-form-item v-if="customPlayer" label="mpv.exe 路径"><n-input v-model:value="deviceConfig.mpvPath" placeholder="填写已安装的 mpv.exe 绝对路径"/></n-form-item>
      <n-form-item label="设备数据目录"><n-input v-model:value="deviceConfig.dataDir"/></n-form-item>
      <n-form-item label="设备凭证"><n-input :value="freshAgent?.token" readonly type="password" show-password-on="click"/></n-form-item>
    </n-form>
    <div class="row-actions"><n-button type="primary" @click="downloadConfig">下载配置</n-button><n-button @click="copyAgentCommand">复制安装命令</n-button></div>
  </n-modal>
  <n-modal v-model:show="showBan" preset="card" title="添加播放限制" class="form-modal"><n-form><n-form-item label="限制类型"><n-select v-model:value="banForm.kind" :options="[{ label: '禁用用户', value: 'user' }, { label: '禁用歌曲', value: 'track' }]"/></n-form-item><n-form-item :label="banForm.kind === 'user' ? '用户 QQ 号' : '平台:歌曲 ID'"><n-input v-model:value="banForm.value" :placeholder="banForm.kind === 'user' ? '123456789' : 'netease:123456 或 qq:003...'"/></n-form-item><n-form-item label="作用范围"><n-select v-model:value="banForm.scope" :options="[{ label: '全局', value: 'global' }, { label: '指定播放区', value: 'zone' }, { label: '指定群', value: 'group' }]"/></n-form-item><n-form-item v-if="banForm.scope !== 'global'" label="范围 ID"><n-select v-if="banForm.scope === 'zone'" v-model:value="banForm.scopeId" :options="zoneOptions"/><n-input v-else v-model:value="banForm.scopeId" placeholder="群号"/></n-form-item><n-form-item label="原因"><n-input v-model:value="banForm.reason"/></n-form-item></n-form><n-button type="primary" block @click="run(async () => { await api('/blacklists', 'POST', banForm); showBan = false; })">保存限制</n-button></n-modal>
  <n-modal v-model:show="showPlaylist" preset="card" title="创建歌单" class="form-modal"><n-form><n-form-item label="歌单名称"><n-input v-model:value="playlistForm.name" placeholder="歌单名称"/></n-form-item><n-form-item label="播放区"><n-select v-model:value="playlistForm.zoneId" :options="zoneOptions"/></n-form-item></n-form><n-button type="primary" block @click="run(async () => { const p = await api<Playlist>('/playlists', 'POST', { ...playlistForm, tracks: [] }); playlistId = p.id; showPlaylist = false; })">创建歌单</n-button></n-modal>
</template>
