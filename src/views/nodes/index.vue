<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';
import { createPulseNode, fetchPulseNodes, queuePulseCommand, type PulseNode } from '@/service/api';

const loading = ref(false);
const nodes = ref<PulseNode[]>([]);
const form = reactive({ name: '', region: '', tags: '' });

const columns = computed(() => [
  { title: '节点', key: 'name', minWidth: 160 },
  { title: '区域', key: 'region', width: 120 },
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
    width: 190,
    render(row: PulseNode) {
      return h('div', { class: 'table-actions' }, [
        h(NButton, { size: 'small', onClick: () => copyInstall(row) }, { default: () => '复制安装' }),
        h(NButton, { size: 'small', onClick: () => queue(row, 'probe') }, { default: () => '探测' })
      ]);
    }
  }
]);

async function loadData() {
  loading.value = true;
  try {
    nodes.value = (await fetchPulseNodes()).items;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const node = await createPulseNode({
    name: form.name || '新节点',
    region: form.region,
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
          <NInput v-model:value="form.region" placeholder="区域，如 HK / JP / US" />
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
          <NThing :title="node.name" :description="node.region || '未设置区域'">
            <template #header-extra>
              <NTag :type="node.online ? 'success' : 'warning'" size="small">{{ node.online ? '在线' : node.agentStatus }}</NTag>
            </template>
          </NThing>
          <NDescriptions :column="2" size="small" class="mt-12px">
            <NDescriptionsItem label="CPU">{{ node.metrics?.cpu?.usagePercent ?? '-' }}%</NDescriptionsItem>
            <NDescriptionsItem label="内存">{{ node.metrics?.memory?.usagePercent ?? '-' }}%</NDescriptionsItem>
            <NDescriptionsItem label="地址">{{ node.addresses?.length || 0 }}</NDescriptionsItem>
            <NDescriptionsItem label="订阅">{{ node.subscriptionEnabled ? '启用' : '停用' }}</NDescriptionsItem>
          </NDescriptions>
          <NInput class="mt-12px" :value="node.installCommand" readonly type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
          <NSpace class="mt-12px">
            <NButton size="small" @click="copyInstall(node)">复制安装</NButton>
            <NButton size="small" @click="queue(node, 'probe')">立即探测</NButton>
            <NButton size="small" @click="queue(node, 'diagnostics')">诊断</NButton>
            <NButton size="small" @click="queue(node, 'sing-box-render')">渲染配置</NButton>
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
