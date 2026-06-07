<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { fetchPulseCommandEvents, fetchPulseCommands, openPulseCommandEventSource, type PulseCommand, type PulseCommandEvent } from '@/service/api';

const loading = ref(false);
const commands = ref<PulseCommand[]>([]);
const selectedCommand = ref<PulseCommand | null>(null);
const commandEvents = ref<PulseCommandEvent[]>([]);
const drawerVisible = ref(false);
let eventSource: EventSource | null = null;

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
  { title: '更新时间', key: 'updatedAt', minWidth: 180 },
  {
    title: '输出',
    key: 'events',
    width: 100,
    render(row: PulseCommand) {
      return h(NButton, { size: 'small', onClick: () => openEvents(row) }, { default: () => '查看' });
    }
  }
]);

const eventLog = computed(() => {
  if (!commandEvents.value.length) return '暂无事件';
  return commandEvents.value
    .map((event) => {
      const prefix = `${event.createdAt || ''} [${event.stream || event.type}]`;
      const payload = event.payload && Object.keys(event.payload).length ? ` ${JSON.stringify(event.payload)}` : '';
      return `${prefix} ${event.message || ''}${payload}`.trim();
    })
    .join('\n');
});

async function loadData() {
  loading.value = true;
  try {
    commands.value = (await fetchPulseCommands()).items;
  } finally {
    loading.value = false;
  }
}

async function openEvents(command: PulseCommand) {
  selectedCommand.value = command;
  drawerVisible.value = true;
  commandEvents.value = (await fetchPulseCommandEvents(command.id)).items;
  connectEventSource(command.id);
}

function connectEventSource(commandId: string) {
  closeEventSource();
  eventSource = openPulseCommandEventSource(commandId);
  const addEvent = (raw: MessageEvent) => {
    const event = JSON.parse(raw.data) as PulseCommandEvent;
    if (!commandEvents.value.some(item => item.id === event.id)) {
      commandEvents.value.push(event);
    }
  };
  for (const type of ['state', 'stdout', 'stderr', 'progress', 'result', 'error']) {
    eventSource.addEventListener(type, addEvent);
  }
  eventSource.onerror = () => {
    closeEventSource();
  };
}

function closeEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function closeDrawer() {
  drawerVisible.value = false;
  closeEventSource();
}

onMounted(loadData);
onBeforeUnmount(closeEventSource);
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="Agent 命令队列" :bordered="false" class="card-wrapper">
      <template #header-extra>
        <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
      </template>
      <NDataTable :columns="columns" :data="commands" :loading="loading" :bordered="false" />
    </NCard>

    <NDrawer :show="drawerVisible" width="720" placement="right" @update:show="value => !value && closeDrawer()">
      <NDrawerContent :title="selectedCommand ? `${selectedCommand.type} 输出` : '命令输出'" closable>
        <NSpace vertical :size="12">
          <NDescriptions v-if="selectedCommand" :column="2" size="small">
            <NDescriptionsItem label="状态">{{ selectedCommand.status }}</NDescriptionsItem>
            <NDescriptionsItem label="节点">{{ selectedCommand.nodeId }}</NDescriptionsItem>
            <NDescriptionsItem label="Agent">{{ selectedCommand.agentId || '-' }}</NDescriptionsItem>
            <NDescriptionsItem label="更新时间">{{ selectedCommand.updatedAt }}</NDescriptionsItem>
          </NDescriptions>
          <pre class="event-log">{{ eventLog }}</pre>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </NSpace>
</template>

<style scoped>
.event-log {
  min-height: 360px;
  max-height: 68vh;
  overflow: auto;
  border: 1px solid var(--n-border-color);
  border-radius: 6px;
  padding: 12px;
  background: var(--n-color);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
