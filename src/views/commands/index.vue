<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NTag } from 'naive-ui';
import { fetchPulseCommands, type PulseCommand } from '@/service/api';

const loading = ref(false);
const commands = ref<PulseCommand[]>([]);

const columns = computed(() => [
  { title: '命令', key: 'type', width: 170 },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render(row: PulseCommand) {
      const type = row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'error' : 'warning';
      return h(NTag, { type, size: 'small' }, { default: () => row.status });
    }
  },
  { title: '节点', key: 'nodeId', minWidth: 240 },
  { title: '更新时间', key: 'updatedAt', minWidth: 180 }
]);

async function loadData() {
  loading.value = true;
  try {
    commands.value = (await fetchPulseCommands()).items;
  } finally {
    loading.value = false;
  }
}

onMounted(loadData);
</script>

<template>
  <NCard title="Agent 命令队列" :bordered="false" class="card-wrapper">
    <template #header-extra>
      <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
    </template>
    <NDataTable :columns="columns" :data="commands" :loading="loading" :bordered="false" />
  </NCard>
</template>
