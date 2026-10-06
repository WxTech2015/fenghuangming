<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NSelect, NSwitch, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import type { AudioEngine, DiagnosticEntry, DiagnosticResult, QueueItem } from '../contracts';
import { api } from '../api';
const props = defineProps<{ queue: QueueItem[]; engines: { label: string; value: AudioEngine }[] }>();
const message = useMessage(); const logs = ref<DiagnosticResult>(); const loading = ref(false); const testing = ref(false);
const search = ref(''); const traceId = ref(''); const level = ref<string>('all'); const auto = ref(true); const chosen = ref<DiagnosticEntry>();
const itemId = ref('');
const shareUrl = ref(''); const engine = ref<AudioEngine | null>(null); const result = ref<{ ok: boolean; traceId?: string; message?: string; bytes?: number; durationSeconds?: number; source?: { engine: string; match: string }; track?: { title: string } }>();
const failures = computed(() => props.queue.filter(item => item.status === 'failed').slice(0, 12));
let timer: ReturnType<typeof setInterval> | undefined; let disposed = false;
const levels = [{ label: '全部级别', value: 'all' }, { label: 'DEBUG', value: 'debug' }, { label: 'INFO', value: 'info' }, { label: 'WARN', value: 'warn' }, { label: 'ERROR', value: 'error' }];
async function refresh(silent = false) {
  if (loading.value || disposed) return; loading.value = true;
  try {
    const query = new URLSearchParams({ limit: '500' }); if (level.value !== 'all') query.set('level', level.value); if (logs.value?.traceEnabled !== false && traceId.value.trim()) query.set('traceId', traceId.value.trim()); if (itemId.value) query.set('itemId', itemId.value); if (search.value.trim()) query.set('search', search.value.trim());
    const data = await api<DiagnosticResult>(`/diagnostics/logs?${query}`); if (!disposed) logs.value = data;
  } catch (error) { if (!silent) message.error(error instanceof Error ? error.message : '读取日志失败'); } finally { loading.value = false; }
}
async function inspect(item: QueueItem) {
  try { const data = await api<DiagnosticResult & { traceId?: string }>(`/diagnostics/queue/${item.id}`); traceId.value = data.traceId ?? ''; itemId.value = data.traceEnabled === false ? item.id : ''; level.value = 'all'; search.value = ''; logs.value = data; }
  catch (error) { message.error(error instanceof Error ? error.message : '读取失败'); }
}
async function testResolve() {
  if (!shareUrl.value.trim() || testing.value) return; testing.value = true; result.value = undefined;
  try { result.value = await api('/diagnostics/resolve', 'POST', { shareUrl: shareUrl.value.trim(), engine: engine.value ?? undefined }); traceId.value = result.value!.traceId ?? ''; itemId.value = ''; level.value = 'all'; search.value = ''; await refresh(); }
  catch (error) { message.error(error instanceof Error ? error.message : '测试请求失败'); } finally { testing.value = false; }
}
function exportLogs() {
  const entries = [...(logs.value?.entries ?? [])].reverse(); const url = URL.createObjectURL(new Blob([entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'], { type: 'application/x-ndjson;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `fenghuangming-debug-${traceId.value || 'recent'}.jsonl`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyEntry() { if (!chosen.value) return; try { await navigator.clipboard.writeText(JSON.stringify(chosen.value, null, 2)); message.success('已复制日志'); } catch { message.info('可在下方文本框选择并复制日志'); } }
const columns: DataTableColumns<DiagnosticEntry> = [
  { title: '时间（北京时间）', key: 'at', width: 190, render: row => new Date(row.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + '.' + row.at.slice(20, 23) },
  { title: '级别', key: 'level', width: 85, render: row => h(NTag, { size: 'small', bordered: false, type: row.level === 'error' ? 'error' : row.level === 'warn' ? 'warning' : row.level === 'info' ? 'success' : 'default' }, { default: () => row.level.toUpperCase() }) },
  { title: '环节', key: 'event', minWidth: 195 },
  { title: '说明', key: 'message', minWidth: 220 },
  { title: '追踪 ID', key: 'traceId', minWidth: 190, render: row => row.traceId ? h(NButton, { text: true, size: 'small', onClick: () => { traceId.value = row.traceId!; level.value = 'all'; void refresh(); } }, { default: () => row.traceId }) : '—' },
  { title: '详情', key: 'detail', width: 75, render: row => h(NButton, { size: 'small', secondary: true, onClick: () => { chosen.value = row; } }, { default: () => '查看' }) },
];
const visibleColumns = computed(() => logs.value?.traceEnabled === false ? columns.filter(column => !('key' in column) || column.key !== 'traceId') : columns);
onMounted(() => { void refresh(); timer = setInterval(() => { if (auto.value) void refresh(true); }, 3000); });
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); });
</script>

<template>
  <section class="glass panel settings-panel">
    <div class="panel-heading"><div><h2>测试解析</h2><p>检查分享链接、音源下载和完整音频校验，不加入队列或播放。</p></div></div>
    <n-form class="settings-grid"><n-form-item label="音乐分享链接"><n-input v-model:value="shareUrl" placeholder="粘贴解析失败的歌曲分享链接" @keyup.enter="testResolve"/></n-form-item><n-form-item label="首选音源"><n-select v-model:value="engine" clearable :options="engines" placeholder="使用已保存的音源设置"/></n-form-item></n-form>
    <n-button type="primary" :loading="testing" :disabled="!shareUrl.trim()" @click="testResolve">测试解析</n-button>
    <div v-if="result" class="diagnostic-result"><n-tag :type="result.ok ? 'success' : 'error'" :bordered="false">{{ result.ok ? '完整音频校验通过' : '解析失败' }}</n-tag><p>{{ result.ok ? `${result.track?.title ?? ''} · ${result.source?.engine ?? ''} · ${Math.round(result.durationSeconds ?? 0)} 秒 · ${((result.bytes ?? 0) / 1048576).toFixed(2)} MB` : result.message }}</p><small v-if="result.traceId">追踪 ID：{{ result.traceId }}</small></div>
  </section>
  <section v-if="failures.length" class="glass panel"><div class="panel-heading"><h2>最近失败的歌曲</h2></div><div v-for="item in failures" :key="item.id" class="entity-row"><div class="entity-main"><strong>{{ item.track.title }}</strong><small>{{ item.error }}</small></div><n-button secondary size="small" @click="inspect(item)">查看日志</n-button></div></section>
  <section class="glass panel settings-panel">
    <div class="panel-heading"><div><h2>诊断日志</h2><p>{{ logs?.mode === 'debug' ? '调试模式' : '生产模式' }} · {{ logs?.directory ?? '后端日志' }} · {{ logs?.level?.toUpperCase() ?? '—' }}</p></div><div class="row-actions"><n-button secondary :loading="loading" @click="refresh(false)">刷新</n-button><n-button secondary :disabled="!logs?.entries.length" @click="exportLogs">导出当前结果</n-button></div></div>
    <n-form class="diagnostic-filters" :class="{ 'without-trace': logs?.traceEnabled === false }"><n-form-item label="级别"><n-select v-model:value="level" :options="levels" @update:value="refresh(false)"/></n-form-item><n-form-item v-if="logs?.traceEnabled !== false" label="追踪 ID"><n-input v-model:value="traceId" clearable placeholder="留空显示全部" @keyup.enter="refresh(false)"/></n-form-item><n-form-item label="搜索"><n-input v-model:value="search" clearable placeholder="错误、音源或歌曲 ID" @keyup.enter="refresh(false)"/></n-form-item><n-form-item label="自动刷新"><n-switch v-model:value="auto"/></n-form-item></n-form>
    <p v-if="itemId" class="help-text">正在显示选中歌曲的日志。<n-button text size="small" @click="itemId = ''; refresh(false)">取消筛选</n-button></p>
    <p v-if="logs?.diskError" class="runtime-error">日志文件写入失败：{{ logs.diskError }}</p>
    <p class="help-text">显示 {{ logs?.entries.length ?? 0 }} 条，匹配 {{ logs?.matched ?? 0 }} 条。{{ logs?.includeStack ? '详情包含错误堆栈、原因、HTTP 状态和耗时。' : '详情包含错误原因、HTTP 状态和耗时。' }}</p>
    <n-data-table :columns="visibleColumns" :data="logs?.entries ?? []" :row-key="(row: DiagnosticEntry) => row.id" :loading="loading" :bordered="false" :scroll-x="logs?.traceEnabled === false ? 850 : 1040" :pagination="{ pageSize: 20 }"/>
  </section>
  <n-modal :show="!!chosen" preset="card" title="日志详情" class="form-modal diagnostic-modal" @update:show="value => { if (!value) chosen = undefined; }"><n-input :value="JSON.stringify(chosen, null, 2)" readonly type="textarea" :autosize="{ minRows: 14, maxRows: 28 }"/><n-button secondary @click="copyEntry">复制日志</n-button></n-modal>
</template>
