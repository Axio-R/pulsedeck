<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NPopconfirm, NTag } from 'naive-ui';
import {
  createPulseNode,
  createPulseNodeProtocol,
  deletePulseNode,
  deletePulseNodeProtocol,
  fetchPulseNodes,
  fetchPulseProtocols,
  queuePulseCommand,
  resetPulseNodeLinks,
  updatePulseNode,
  type PulseNode,
  type PulseProtocolMeta
} from '@/service/api';

const loading = ref(false);
const nodes = ref<PulseNode[]>([]);
const protocolMetas = ref<PulseProtocolMeta[]>([]);
const form = reactive({ name: '', region: '', tags: '' });
const protocolDrafts = reactive<Record<string, { type: string; port: number | null; variant: string }>>({});

const columns = computed(() => [
  { title: '节点', key: 'name', minWidth: 160 },
  {
    title: '区域',
    key: 'region',
    width: 130,
    render(row: PulseNode) {
      return row.displayRegion || row.region || '自动识别中';
    }
  },
  {
    title: 'IP 模式',
    key: 'ipMode',
    width: 150,
    render(row: PulseNode) {
      return ipModeLabel(row.network?.ipMode);
    }
  },
  {
    title: '状态',
    key: 'agentStatus',
    width: 110,
    render(row: PulseNode) {
      return h(
        NTag,
        { type: row.online ? 'success' : row.agentStatus === 'not-installed' ? 'warning' : 'error', size: 'small' },
        { default: () => (row.online ? '在线' : row.agentStatus) }
      );
    }
  },
  {
    title: '协议',
    key: 'protocols',
    width: 90,
    render(row: PulseNode) {
      return `${row.protocols?.length || 0} 个`;
    }
  },
  {
    title: 'CPU',
    key: 'cpu',
    width: 90,
    render(row: PulseNode) {
      return row.metrics?.cpu?.usagePercent == null ? '-' : `${row.metrics.cpu.usagePercent}%`;
    }
  },
  {
    title: '内存',
    key: 'memory',
    width: 90,
    render(row: PulseNode) {
      return row.metrics?.memory?.usagePercent == null ? '-' : `${row.metrics.memory.usagePercent}%`;
    }
  },
  { title: '最后上报', key: 'lastSeenAt', minWidth: 180 },
  {
    title: '操作',
    key: 'actions',
    width: 330,
    render(row: PulseNode) {
      return h('div', { class: 'table-actions' }, [
        h(NButton, { size: 'small', onClick: () => copyInstall(row) }, { default: () => '复制安装' }),
        h(NButton, { size: 'small', onClick: () => queue(row, 'probe') }, { default: () => '探测' }),
        h(NButton, { size: 'small', onClick: () => resetLinks(row) }, { default: () => '重置链接' }),
        h(
          NPopconfirm,
          { onPositiveClick: () => removeNode(row) },
          {
            default: () => `删除节点 ${row.name}？`,
            trigger: () => h(NButton, { size: 'small', type: 'error', secondary: true }, { default: () => '删除' })
          }
        )
      ]);
    }
  }
]);

async function loadData() {
  loading.value = true;
  try {
    const [nodeRes, protocolRes] = await Promise.all([fetchPulseNodes(), fetchPulseProtocols()]);
    nodes.value = nodeRes.items;
    protocolMetas.value = protocolRes.items;
    for (const node of nodes.value) draftFor(node);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const node = await createPulseNode({
    name: form.name || '新节点',
    region: form.region || undefined,
    tags: form.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)
  });
  nodes.value.unshift(node);
  form.name = '';
  form.region = '';
  form.tags = '';
  window.$message?.success('节点已创建');
}

async function copyInstall(node: PulseNode) {
  await navigator.clipboard.writeText(node.installCommand);
  window.$message?.success('安装命令已复制');
}

async function queue(node: PulseNode, type: string) {
  await queuePulseCommand(node.id, type);
  window.$message?.success('命令已下发到队列');
}

async function resetLinks(node: PulseNode) {
  await resetPulseNodeLinks(node.id);
  node.reportedLinks = [];
  window.$message?.success('已下发重置链接命令');
}

function draftFor(node: PulseNode) {
  if (!protocolDrafts[node.id]) {
    const first = protocolMetas.value[0];
    protocolDrafts[node.id] = {
      type: first?.type || 'vless',
      port: first?.defaultPort || 443,
      variant: ''
    };
  }
  return protocolDrafts[node.id];
}

function protocolOptions() {
  return protocolMetas.value.map(item => ({
    label: `${item.name} :${item.defaultPort}`,
    value: item.type
  }));
}

function syncDraftPort(node: PulseNode) {
  const draft = draftFor(node);
  const meta = protocolMetas.value.find(item => item.type === draft.type);
  draft.port = meta?.defaultPort || draft.port || 443;
}

async function addProtocol(node: PulseNode) {
  const draft = draftFor(node);
  const result = await createPulseNodeProtocol(node.id, {
    type: draft.type,
    port: draft.port,
    variant: draft.variant
  });
  node.protocols.push(result.protocol);
  window.$message?.success(`已添加 ${result.protocol.name}，命令已入队`);
}

async function removeProtocol(node: PulseNode, protocolId: string) {
  await deletePulseNodeProtocol(node.id, protocolId);
  node.protocols = node.protocols.filter(item => item.id !== protocolId);
  window.$message?.success('协议删除命令已入队');
}

async function saveRegion(node: PulseNode) {
  const result = await updatePulseNode(node.id, { region: node.region });
  Object.assign(node, result);
  window.$message?.success('区域已保存');
}

function ipModeLabel(value?: string) {
  const labels: Record<string, string> = {
    'ipv4-only': '纯 IPv4',
    'ipv6-only': '纯 IPv6',
    'dual-stack': '双栈',
    'warp-v4-ipv6': 'WARP IPv4 + IPv6',
    'private-dual-stack': '内网双栈',
    'private-ipv4': '内网 IPv4',
    'private-ipv6': '内网 IPv6'
  };
  return labels[value || ''] || '待识别';
}

function formatBytes(value?: number) {
  const number = Number(value) || 0;
  if (number >= 1024 ** 4) return `${(number / 1024 ** 4).toFixed(2)} TB`;
  if (number >= 1024 ** 3) return `${(number / 1024 ** 3).toFixed(2)} GB`;
  if (number >= 1024 ** 2) return `${(number / 1024 ** 2).toFixed(2)} MB`;
  if (number >= 1024) return `${(number / 1024).toFixed(2)} KB`;
  return `${number} B`;
}

async function removeNode(node: PulseNode) {
  const result = await deletePulseNode(node.id);
  nodes.value = nodes.value.filter(item => item.id !== node.id);
  window.$message?.success(`节点已删除，清理 Agent ${result.removedAgents} 个、命令 ${result.removedCommands} 条`);
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="新建 sing-box 节点" :bordered="false" class="card-wrapper">
      <NGrid :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
        <NGi span="24 s:8">
          <NInput v-model:value="form.name" placeholder="节点名称" />
        </NGi>
        <NGi span="24 s:6">
          <NInput v-model:value="form.region" placeholder="区域可留空，Agent 上线后自动识别" />
        </NGi>
        <NGi span="24 s:7">
          <NInput v-model:value="form.tags" placeholder="标签，逗号分隔" />
        </NGi>
        <NGi span="24 s:3">
          <NButton type="primary" block @click="submit">创建</NButton>
        </NGi>
      </NGrid>
    </NCard>

    <NCard title="节点列表" :bordered="false" class="card-wrapper">
      <template #header-extra>
        <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
      </template>
      <NDataTable :columns="columns" :data="nodes" :loading="loading" :bordered="false" />
    </NCard>

    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi v-for="node in nodes" :key="node.id" span="24 m:12 xl:8">
        <NCard :bordered="false" class="card-wrapper">
          <NThing :title="node.name" :description="node.displayRegion || '自动识别中'">
            <template #header-extra>
              <NTag :type="node.online ? 'success' : 'warning'" size="small">{{ node.online ? '在线' : node.agentStatus }}</NTag>
            </template>
          </NThing>
          <NDescriptions :column="2" size="small" class="mt-12px">
            <NDescriptionsItem label="显示区域">{{ node.displayRegion || '自动识别中' }}</NDescriptionsItem>
            <NDescriptionsItem label="IP 模式">{{ ipModeLabel(node.network?.ipMode) }}</NDescriptionsItem>
            <NDescriptionsItem label="IPv4">{{ node.network?.primaryIpv4 || '-' }}</NDescriptionsItem>
            <NDescriptionsItem label="IPv6">{{ node.network?.primaryIpv6 || '-' }}</NDescriptionsItem>
            <NDescriptionsItem label="CPU">{{ node.metrics?.cpu?.usagePercent ?? '-' }}%</NDescriptionsItem>
            <NDescriptionsItem label="内存">{{ node.metrics?.memory?.usagePercent ?? '-' }}%</NDescriptionsItem>
            <NDescriptionsItem label="流量">{{ formatBytes(node.traffic?.totalBytes) }}</NDescriptionsItem>
            <NDescriptionsItem label="订阅">{{ node.subscriptionEnabled ? '启用' : '停用' }}</NDescriptionsItem>
          </NDescriptions>
          <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive class="mt-12px">
            <NGi span="24 s:16">
              <NInput v-model:value="node.region" placeholder="识别错误时手动修正区域" />
            </NGi>
            <NGi span="24 s:8">
              <NButton block secondary @click="saveRegion(node)">保存区域</NButton>
            </NGi>
          </NGrid>
          <NDivider class="my-12px" />
          <NSpace vertical :size="8">
            <NText depth="2">协议端口</NText>
            <NSpace v-if="node.protocols?.length" :size="8">
              <NTag v-for="protocol in node.protocols" :key="protocol.id" closable @close="removeProtocol(node, protocol.id)">
                {{ protocol.name }} :{{ protocol.port }} {{ protocol.variant || '' }}
              </NTag>
            </NSpace>
            <NEmpty v-else size="small" description="暂无协议" />
            <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive>
              <NGi span="24 s:9">
                <NSelect v-model:value="draftFor(node).type" :options="protocolOptions()" @update:value="syncDraftPort(node)" />
              </NGi>
              <NGi span="24 s:6">
                <NInputNumber v-model:value="draftFor(node).port" :min="1" :max="65535" placeholder="端口" class="w-full" />
              </NGi>
              <NGi span="24 s:5">
                <NInput v-model:value="draftFor(node).variant" placeholder="变种" />
              </NGi>
              <NGi span="24 s:4">
                <NButton type="primary" block @click="addProtocol(node)">添加</NButton>
              </NGi>
            </NGrid>
          </NSpace>
          <NInput class="mt-12px" :value="node.installCommand" readonly type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
          <NSpace class="mt-12px">
            <NButton size="small" @click="copyInstall(node)">复制安装</NButton>
            <NButton size="small" @click="queue(node, 'probe')">立即探测</NButton>
            <NButton size="small" @click="queue(node, 'diagnostics')">诊断</NButton>
            <NButton size="small" @click="queue(node, 'sing-box-render')">渲染配置</NButton>
            <NButton size="small" @click="resetLinks(node)">重置链接</NButton>
            <NPopconfirm @positive-click="removeNode(node)">
              <template #trigger>
                <NButton size="small" type="error" secondary>删除</NButton>
              </template>
              删除节点 {{ node.name }}？
            </NPopconfirm>
          </NSpace>
        </NCard>
      </NGi>
    </NGrid>
  </NSpace>
</template>

<style scoped>
.table-actions {
  display: flex;
  gap: 8px;
}
</style>
