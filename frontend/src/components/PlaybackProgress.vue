<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NButton, NInputNumber, useMessage } from 'naive-ui';
import type { QueueItem, Snapshot } from '../contracts';
import { api } from '../api';
const props = defineProps<{ zoneId: string; item?: QueueItem; agent?: Snapshot['agents'][number]; connected: boolean }>();
const message = useMessage(); const busy = ref(false); const draft = ref<number | null>(null);
const clock = ref(Date.now()); const receivedAt = ref(Date.now()); const optimistic = ref<{ position: number; at: number }>();
const timer = setInterval(() => { clock.value = Date.now(); }, 1000); onUnmounted(() => clearInterval(timer));
const duration = computed(() => props.agent?.durationSeconds || props.item?.track.durationSeconds || 0);
const maximum = computed(() => Math.max(0, Math.floor(duration.value) - 1));
const canSeek = computed(() => props.connected && props.agent?.ready && props.agent.supportsSeek && props.agent.seekable && props.item?.status === 'playing' && props.item.playbackId === props.agent.playbackId && duration.value > 0);
watch(() => [props.agent?.lastSeen, props.agent?.position], () => { receivedAt.value = Date.now(); optimistic.value = undefined; });
watch(() => [props.zoneId, props.item?.playbackId], () => { draft.value = null; optimistic.value = undefined; });
const position = computed(() => {
  if (!props.item) return 0;
  // 心跳间按秒更新显示，下一次实际播放器快照会校正；编辑值独立保存。
  const override = optimistic.value && clock.value - optimistic.value.at < 6000 ? optimistic.value : undefined;
  const base = override?.position ?? props.agent?.position ?? 0;
  const elapsed = props.item?.status === 'playing' && props.connected && props.agent?.ready && !props.agent.paused ? Math.max(0, (clock.value - (override?.at ?? receivedAt.value)) / 1000) : 0;
  return Math.floor(Math.max(0, Math.min(duration.value || 86400, base + elapsed)));
});
const display = computed(() => Math.min(maximum.value, draft.value ?? position.value));
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
async function seek(value: number) {
  if (!canSeek.value || busy.value) return;
  const target = Math.max(0, Math.min(maximum.value, Math.floor(value))); const playbackId = props.item!.playbackId;
  busy.value = true;
  try { await api(`/zones/${props.zoneId}/control`, 'POST', { action: 'seek', position: target, playbackId }); if (props.item?.playbackId === playbackId) optimistic.value = { position: target, at: Date.now() }; draft.value = null; }
  catch (error) { message.error(error instanceof Error ? error.message : '调整进度失败'); draft.value = null; }
  finally { busy.value = false; }
}
function rangeInput(event: Event) { draft.value = Number((event.target as HTMLInputElement).value); }
</script>

<template>
  <div class="playback-progress">
    <input class="seek-range" type="range" min="0" :max="maximum" step="1" :value="display" :disabled="!canSeek || busy" :style="{ '--seek-fill': `${maximum ? display / maximum * 100 : 0}%` }" aria-label="播放进度，按秒调整" @input="rangeInput" @change="seek(Number(($event.target as HTMLInputElement).value))"/>
    <div class="seek-times"><span>{{ time(draft ?? position) }}</span><span>{{ duration ? time(duration) : '—:—' }}</span></div>
    <div class="seek-actions"><n-button size="small" secondary :disabled="!canSeek || busy" @click="seek(position - 1)">−1 秒</n-button><n-button size="small" secondary :disabled="!canSeek || busy" @click="seek(position + 1)">+1 秒</n-button><n-input-number :value="draft ?? Math.min(maximum, position)" :min="0" :max="maximum" :step="1" :precision="0" :disabled="!canSeek || busy" size="small" aria-label="跳转到第几秒" @update:value="value => { draft = value; }" @keydown.enter="seek(draft ?? position)"/><n-button size="small" secondary :loading="busy" :disabled="!canSeek" @click="seek(draft ?? position)">跳转</n-button><small>{{ canSeek ? '按 1 秒调整' : agent && !agent.supportsSeek ? '升级 Agent 后可调整进度' : '播放就绪后可调整进度' }}</small></div>
  </div>
</template>

<style scoped>
.playback-progress{margin:24px 0 18px}.seek-range{appearance:none;display:block;width:100%;height:6px;border-radius:8px;background:linear-gradient(to right,#8579db var(--seek-fill),#dedce9 var(--seek-fill));cursor:pointer}.seek-range::-webkit-slider-thumb{appearance:none;width:16px;height:16px;border-radius:50%;background:#8171d4;box-shadow:0 2px 8px #8171d442;border:3px solid #fff}.seek-range::-moz-range-thumb{width:12px;height:12px;border:3px solid #fff;border-radius:50%;background:#8171d4}.seek-range:disabled{cursor:default;opacity:.6}.seek-times{display:flex;justify-content:space-between;color:#918ba4;font-size:12px;margin:11px 0 14px;font-variant-numeric:tabular-nums}.seek-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.seek-actions :deep(.n-input-number){width:110px}.seek-actions small{color:#918ba4;font-size:11px;margin-left:3px}
</style>
