<script setup lang="ts">
import { computed, h } from 'vue';
import { NButton, NDataTable, NForm, NFormItem, NSelect, NTag, type DataTableColumns } from 'naive-ui';
import type { PypiDownloadState, PypiMirrorResult, Settings } from '../contracts';
const props = defineProps<{ modelValue: Settings['pypiDownload']; state?: PypiDownloadState; busy: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [Settings['pypiDownload']]; test: [] }>();
const modes = [{ label: '自动测速选择', value: 'auto' }, { label: 'PyPI 官方', value: 'official' }, { label: '指定优先镜像', value: 'mirror' }];
const mirrors = computed(() => (props.state?.nodes ?? []).map(node => ({ label: node.label, value: node.mirror })));
const working = computed(() => ['testing', 'installing'].includes(props.state?.phase ?? ''));
const phase = computed(() => props.state?.phase === 'testing' ? `测速中 ${props.state.nodes.filter(node => node.available !== null).length}/${props.state.nodes.length}` : props.state?.phase === 'installing' ? '安装依赖中' : props.state?.phase === 'ready' ? '安装完成' : props.state?.phase === 'failed' ? '失败' : props.state?.checkedAt ? '已测速' : '未测速');
const selected = computed(() => props.state?.nodes.find(node => node.mirror === props.state?.selected)?.label ?? '尚未选择');
const columns: DataTableColumns<PypiMirrorResult> = [
  { title: '镜像', key: 'label', minWidth: 120 },
  { title: '状态', key: 'available', width: 85, render: row => h(NTag, { size: 'small', bordered: false, type: row.available ? 'success' : row.available === false ? 'error' : 'default' }, { default: () => row.available ? '可用' : row.available === false ? '不可用' : '未测' }) },
  { title: '延迟', key: 'latencyMs', width: 100, render: row => row.latencyMs === null ? '—' : `${row.latencyMs} ms` },
  { title: '下载速度', key: 'speedBytesPerSecond', width: 115, render: row => row.speedBytesPerSecond === null ? '—' : `${(row.speedBytesPerSecond / 1024).toFixed(1)} KB/s` },
  { title: '失败原因', key: 'error', minWidth: 200, render: row => row.error || '—' },
];
</script>

<template>
  <section class="glass panel settings-panel">
    <div class="panel-heading"><div><h2>PyPI 下载加速</h2><p>musicdl 安装前自动测速，失败后切换镜像。</p></div><n-button secondary :loading="state?.phase === 'testing'" :disabled="busy || working" @click="emit('test')">重新测速</n-button></div>
    <n-form class="settings-grid"><n-form-item label="依赖下载方式"><n-select :value="modelValue.mode" :options="modes" @update:value="mode => emit('update:modelValue', { ...modelValue, mode })"/></n-form-item><n-form-item v-if="modelValue.mode === 'mirror'" label="优先镜像"><n-select :value="modelValue.mirror || null" :options="mirrors" placeholder="选择镜像" @update:value="mirror => emit('update:modelValue', { ...modelValue, mirror })"/></n-form-item></n-form>
    <div class="runtime-heading"><n-tag round :bordered="false">{{ phase }}</n-tag><span>当前镜像：{{ selected }}</span></div>
    <p v-if="state?.error" class="runtime-error">{{ state.error }}</p>
    <p class="help-text">{{ state?.checkedAt ? `最近测速：${new Date(state.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '测速由后端服务器执行。' }} · {{ state?.nodes.length ?? 0 }} 个入口 · 64 KB 抽样</p>
    <n-data-table v-if="state" :columns="columns" :data="state.nodes" :row-key="(row: PypiMirrorResult) => row.mirror" :bordered="false" :scroll-x="640" :pagination="{ pageSize: 10 }"/>
  </section>
</template>
