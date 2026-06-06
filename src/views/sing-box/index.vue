<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchPulseNodes, queuePulseCommand, type PulseNode } from '@/service/api';

const nodes = ref<PulseNode[]>([]);
const loading = ref(false);

const protocolTemplates = [
  { name: 'Shadowsocks 2022', status: '首版', desc: '轻量入站，适合基础订阅分发和低资源 VPS。' },
  { name: 'VLESS Reality', status: '计划', desc: '面向真实站点伪装和更强客户端兼容的主力模板。' },
  { name: 'Trojan TLS', status: '计划', desc: '依赖证书路径，适合已有域名与证书的节点。' },
  { name: 'Hysteria2 / TUIC', status: '计划', desc: '面向 UDP/移动网络场景，后续跟随 Agent 能力启用。' }
];

async function loadData() {
  loading.value = true;
  try {
    nodes.value = (await fetchPulseNodes()).items;
  } finally {
    loading.value = false;
  }
}

async function queueRender(node: PulseNode) {
  await queuePulseCommand(node.id, 'sing-box-render', { template: 'default' });
  window.$message?.success('已加入 sing-box 渲染队列');
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :bordered="false" class="card-wrapper">
      <NThing title="sing-box 配置中心" description="这里会沉淀入站模板、端口规划、证书策略、Reality 参数和 Agent 下发状态。" />
    </NCard>

    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi v-for="item in protocolTemplates" :key="item.name" span="24 m:12 xl:6">
        <NCard :bordered="false" class="card-wrapper">
          <NThing :title="item.name" :description="item.desc">
            <template #header-extra>
              <NTag size="small" :type="item.status === '首版' ? 'success' : 'info'">{{ item.status }}</NTag>
            </template>
          </NThing>
        </NCard>
      </NGi>
    </NGrid>

    <NCard title="节点配置下发" :bordered="false" class="card-wrapper">
      <template #header-extra>
        <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
      </template>
      <NSpace vertical>
        <div v-for="node in nodes" :key="node.id" class="operation-row">
          <div>
            <div class="font-medium">{{ node.name }}</div>
            <div class="text-12px text-gray-500">{{ node.region || '未设置区域' }} · {{ node.agentStatus }}</div>
          </div>
          <NSpace>
            <NTag size="small" :type="node.online ? 'success' : 'warning'">{{ node.online ? '在线' : '离线/待安装' }}</NTag>
            <NButton size="small" @click="queueRender(node)">渲染并下发</NButton>
          </NSpace>
        </div>
        <NEmpty v-if="!nodes.length" description="暂无节点" />
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.operation-row {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
