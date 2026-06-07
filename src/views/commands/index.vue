<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { fetchPulseCommandEvents, fetchPulseCommands, openPulseCommandEventSource, type PulseCommand, type PulseCommandEvent } from '@/service/api';
import { formatBeijingTime } from '@/utils/pulse-format';

const loading = ref(false);
const commands = ref<PulseCommand[]>([]);
const selectedCommand = ref<PulseCommand | null>(null);
const commandEvents = ref<PulseCommandEvent[]>([]);
const drawerVisible = ref(false);
let eventSource: EventSource | null = null;

const columns = computed(() => [
  {
    title: '命令',
    key: 'type',
    width: 170,
    render(row: PulseCommand) {
      return commandLabel(row.type);
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render(row: PulseCommand) {
      return h(NTag, { type: commandStatusTagType(row.status), size: 'small' }, { default: () => commandStatusLabel(row.status) });
    }
  },
  {
    title: '结果',
    key: 'result',
    minWidth: 260,
    render(row: PulseCommand) {
      return commandResultSummary(row);
    }
  },
  {
    title: '节点',
    key: 'nodeId',
    minWidth: 180,
    render(row: PulseCommand) {
      return shortId(row.nodeId);
    }
  },
  {
    title: '更新时间',
    key: 'updatedAt',
    minWidth: 180,
    render(row: PulseCommand) {
      return formatBeijingTime(row.updatedAt);
    }
  },
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
      const prefix = `${formatBeijingTime(event.createdAt)} [${event.stream || event.type}]`;
      const payload = event.payload && Object.keys(event.payload).length ? ` ${JSON.stringify(event.payload)}` : '';
      return `${prefix} ${event.message || ''}${payload}`.trim();
    })
    .join('\n');
});

function commandLabel(type: string) {
  const labels: Record<string, string> = {
    probe: '探测',
    diagnostics: '诊断',
    'sing-box-render': '渲染配置',
    'sing-box-apply': '应用配置',
    'sing-box-restart': '重启 sing-box',
    'sing-box-install': '安装 sing-box',
    'sing-box-reinstall': '更新 sing-box',
    'reset-links': '重置链接',
    'protocol-add': '添加协议',
    'protocol-delete': '删除协议'
  };
  return labels[type] || type;
}

function commandStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: '等待 Agent',
    running: '执行中',
    succeeded: '成功',
    failed: '失败'
  };
  return labels[status] || status;
}

function commandStatusTagType(status: string) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'warning';
}

function resultMessage(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  const record = result as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : null;
  const message = record.message || data?.message || record.error || data?.error;
  if (message) return String(message);
  try {
    return JSON.stringify(result);
  } catch {
    return '';
  }
}

function commandResultSummary(command: PulseCommand) {
  if (command.status === 'queued') return '等待 Agent 拉取';
  if (command.status === 'running') return 'Agent 正在执行';
  return resultMessage(command.result) || (command.status === 'succeeded' ? '已完成' : '无结果详情');
}

function shortId(id: string) {
  if (!id) return '-';
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

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
      <NDrawerContent :title="selectedCommand ? `${commandLabel(selectedCommand.type)} 输出` : '命令输出'" closable>
        <NSpace vertical :size="12">
          <NDescriptions v-if="selectedCommand" :column="2" size="small">
            <NDescriptionsItem label="命令">{{ commandLabel(selectedCommand.type) }}</NDescriptionsItem>
            <NDescriptionsItem label="状态">{{ commandStatusLabel(selectedCommand.status) }}</NDescriptionsItem>
            <NDescriptionsItem label="节点">{{ shortId(selectedCommand.nodeId) }}</NDescriptionsItem>
            <NDescriptionsItem label="Agent">{{ shortId(selectedCommand.agentId || '') }}</NDescriptionsItem>
            <NDescriptionsItem label="更新时间">{{ formatBeijingTime(selectedCommand.updatedAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="结果">{{ commandResultSummary(selectedCommand) }}</NDescriptionsItem>
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
