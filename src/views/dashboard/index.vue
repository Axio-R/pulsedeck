<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchPulseDashboard, type PulseDashboard } from '@/service/api';

const loading = ref(false);
const dashboard = ref<PulseDashboard | null>(null);

async function loadData() {
  loading.value = true;
  try {
    dashboard.value = await fetchPulseDashboard();
  } finally {
    loading.value = false;
  }
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :bordered="false" class="card-wrapper">
      <NThing title="PulseDeck 工作台" description="基于 SoybeanAdmin 的 sing-box 节点管理面板">
        <template #header-extra>
          <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
        </template>
      </NThing>
    </NCard>

    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi span="24 s:12 m:6">
        <NCard :bordered="false" class="card-wrapper">
          <NStatistic label="节点总数" :value="dashboard?.counts.nodes ?? 0" />
        </NCard>
      </NGi>
      <NGi span="24 s:12 m:6">
        <NCard :bordered="false" class="card-wrapper">
          <NStatistic label="在线节点" :value="dashboard?.counts.onlineNodes ?? 0" />
        </NCard>
      </NGi>
      <NGi span="24 s:12 m:6">
        <NCard :bordered="false" class="card-wrapper">
          <NStatistic label="命令队列" :value="dashboard?.counts.queuedCommands ?? 0" />
        </NCard>
      </NGi>
      <NGi span="24 s:12 m:6">
        <NCard :bordered="false" class="card-wrapper">
          <NStatistic label="订阅 Profile" :value="dashboard?.counts.enabledSubscriptions ?? 0" />
        </NCard>
      </NGi>
    </NGrid>

    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi span="24 m:12">
        <NCard title="最近节点" :bordered="false" class="card-wrapper">
          <NEmpty v-if="!dashboard?.recentNodes.length" description="暂无节点" />
          <NSpace v-else vertical>
            <div v-for="node in dashboard.recentNodes" :key="node.id" class="operation-row">
              <div>
                <div class="font-medium">{{ node.name }}</div>
                <div class="text-12px text-gray-500">{{ node.region || '未设置区域' }} · {{ node.lastSeenAt || '未上报' }}</div>
              </div>
              <NTag :type="node.lastSeenAt ? 'success' : 'warning'" size="small">
                {{ node.agentStatus }}
              </NTag>
            </div>
          </NSpace>
        </NCard>
      </NGi>
      <NGi span="24 m:12">
        <NCard title="最近命令" :bordered="false" class="card-wrapper">
          <NEmpty v-if="!dashboard?.recentCommands.length" description="暂无命令" />
          <NSpace v-else vertical>
            <div v-for="command in dashboard.recentCommands" :key="command.id" class="operation-row">
              <div>
                <div class="font-medium">{{ command.type }}</div>
                <div class="text-12px text-gray-500">{{ command.updatedAt }}</div>
              </div>
              <NTag size="small">{{ command.status }}</NTag>
            </div>
          </NSpace>
        </NCard>
      </NGi>
    </NGrid>
  </NSpace>
</template>

<style scoped>
.operation-row {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
