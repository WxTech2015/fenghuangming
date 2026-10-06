<script setup lang="ts">
import { computed, h } from 'vue';
import { NButton, NDataTable, NForm, NFormItem, NSelect, NTag, type DataTableColumns } from 'naive-ui';
import type { GithubDownloadState, GithubMirrorResult, Settings } from '../contracts';
const props = defineProps<{ modelValue: Settings['githubDownload']; state?: GithubDownloadState; busy: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [Settings['githubDownload']]; test: [] }>();
const modes = [{ label: '自动测速选择', value: 'auto' }, { label: 'GitHub 直连', value: 'direct' }, { label: '指定优先节点', value: 'mirror' }];
const mirrors = computed(() => (props.state?.nodes ?? []).filter(node => node.mirror).map(node => ({ label: node.label, value: node.mirror })));
const working = computed(() => ['testing', 'downloading'].includes(props.state?.phase ?? ''));
const selected = computed(() => props.state?.selected === null || props.state?.selected === undefined ? '尚未选择' : props.state.selected ? new URL(props.state.selected).hostname : 'GitHub 直连');
const tested = computed(() => props.state?.nodes.filter(node => node.available !== null).length ?? 0);
const phase = computed(() => props.state?.phase === 'testing' ? `测速中 ${tested.value}/${props.state.nodes.length}` : props.state?.phase === 'downloading' ? '下载中' : props.state?.phase === 'ready' ? '下载完成' : props.state?.phase === 'failed' ? '失败' : props.state?.checkedAt ? '已测速' : '未测速');
const speed = (bytes: number | null) => bytes === null ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB/s` : `${(bytes / 1024).toFixed(1)} KB/s`;
const columns: DataTableColumns<GithubMirrorResult> = [
  { title: '节点', key: 'label', minWidth: 215 },
  { title: '状态', key: 'available', width: 95, render: row => h(NTag, { size: 'small', bordered: false, type: row.available ? 'success' : row.available === false ? 'error' : 'default' }, { default: () => h('span', { title: row.error ?? '' }, row.available ? '可用' : row.available === false ? '不可用' : '待测速') }) },
  { title: '延迟', key: 'latencyMs', width: 100, render: row => row.latencyMs === null ? '—' : `${row.latencyMs} ms` },
  { title: '抽样速度', key: 'speedBytesPerSecond', width: 120, render: row => speed(row.speedBytesPerSecond) },
];
</script>

<template>
  <section class="glass panel settings-panel">
    <div class="panel-heading"><div><h2>GitHub 下载加速</h2><p>安装前自动测速，结果缓存 30 分钟。指定节点失败后自动切换。</p></div><n-button secondary :loading="state?.phase === 'testing'" :disabled="busy || working" @click="emit('test')">重新测速</n-button></div>
    <n-form class="settings-grid">
      <n-form-item label="下载方式"><n-select :value="modelValue.mode" :options="modes" @update:value="mode => emit('update:modelValue', { ...modelValue, mode })"/></n-form-item>
      <n-form-item v-if="modelValue.mode === 'mirror'" label="优先节点"><n-select filterable :value="modelValue.mirror || null" :options="mirrors" placeholder="选择内置加速节点" @update:value="mirror => emit('update:modelValue', { ...modelValue, mirror })"/></n-form-item>
    </n-form>
    <div class="runtime-heading"><n-tag round :bordered="false">{{ phase }}</n-tag><span>当前节点：{{ selected }}</span></div>
    <p v-if="state?.error" class="runtime-error">{{ state.error }}</p>
    <p class="help-text">{{ state?.checkedAt ? `最近测速：${new Date(state.checkedAt).toLocaleString()}` : '点击测速或安装时测试后端服务器到下载节点的连接。' }} · 64 KB 抽样</p>
    <n-data-table v-if="state" :columns="columns" :data="state.nodes" :row-key="(row: GithubMirrorResult) => row.mirror" :bordered="false" :scroll-x="530" :pagination="{ pageSize: 8 }"/>
  </section>
</template>
