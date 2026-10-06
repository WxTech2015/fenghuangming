<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN } from 'naive-ui';
import Console from './Console.vue';
const theme = { common: { primaryColor: '#7465d4', primaryColorHover: '#8c7de9', primaryColorPressed: '#6355bb', borderRadius: '12px', fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif' }, Button: { borderRadiusMedium: '12px' }, Input: { borderRadius: '12px' }, Card: { borderRadius: '22px' } };
</script>
<template><n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="theme"><n-message-provider><n-dialog-provider><Console /></n-dialog-provider></n-message-provider></n-config-provider></template>
