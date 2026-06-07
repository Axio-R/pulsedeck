<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  fetchPulseAgentRuntimeManifest,
  fetchPulseHealth,
  type PulseAgentRuntimeManifest,
  type PulseAgentRuntimeTarget,
  type PulseHealth
} from '@/service/api';

const loading = ref(false);
const health = ref<PulseHealth | null>(null);
const runtimeManifest = ref<PulseAgentRuntimeManifest | null>(null);

const runtimeTargets = computed(() => runtimeManifest.value?.targets || []);

function formatBytes(value: number) {
  if (!value) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function shortSha(target: PulseAgentRuntimeTarget) {
  return target.sha256 ? `${target.sha256.slice(0, 12)}...${target.sha256.slice(-8)}` : '-';
}

async function loadData() {
  loading.value = true;
  try {
    const [healthRes, manifestRes] = await Promise.all([fetchPulseHealth(), fetchPulseAgentRuntimeManifest()]);
    health.value = healthRes;
    runtimeManifest.value = manifestRes;
  } finally {
    loading.value = false;
  }
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="12">
    <NCard title="PulseDeck 设置" :bordered="false" class="card-wrapper settings-card">
      <template #header-extra>
        <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
      </template>

      <NDescriptions :column="2" bordered size="small">
        <NDescriptionsItem label="面板版本">{{ health?.version || '-' }}</NDescriptionsItem>
        <NDescriptionsItem label="Agent 版本">{{ health?.agentVersion || runtimeManifest?.agentVersion || '-' }}</NDescriptionsItem>
        <NDescriptionsItem label="默认端口">{{ health?.port || 14770 }}</NDescriptionsItem>
        <NDescriptionsItem label="GHCR 镜像">ghcr.io/axio-r/pulsedeck:latest</NDescriptionsItem>
        <NDescriptionsItem label="项目基础">soybeanjs/soybean-admin</NDescriptionsItem>
        <NDescriptionsItem label="本地命令">PK / pk / RK / rk</NDescriptionsItem>
        <NDescriptionsItem label="部署规则">GitHub Actions -> GHCR -> docker compose pull/up</NDescriptionsItem>
        <NDescriptionsItem label="本地 Docker 构建">禁用</NDescriptionsItem>
      </NDescriptions>

      <NDivider class="my-12px" />

      <div class="runtime-head">
        <NText strong>Agent Runtime</NText>
        <NText depth="3">{{ runtimeManifest?.generatedAt || health?.time || '-' }}</NText>
      </div>

      <div class="runtime-list">
        <div v-for="target in runtimeTargets" :key="target.target" class="runtime-row">
          <div class="runtime-main">
            <strong>{{ target.target }}</strong>
            <span>{{ target.version || '-' }}</span>
          </div>
          <div class="runtime-meta">
            <NTag size="small" :type="target.available ? 'success' : 'warning'" :bordered="false">
              {{ target.available ? '已发布' : '未发布' }}
            </NTag>
            <span>{{ formatBytes(target.sizeBytes) }}</span>
            <code>{{ shortSha(target) }}</code>
          </div>
          <NButton size="tiny" tag="a" :href="target.downloadUrl" target="_blank" :disabled="!target.available">下载</NButton>
        </div>
      </div>
    </NCard>
  </NSpace>
</template>

<style scoped>
.settings-card :deep(.n-card__content) {
  padding-top: 14px;
}

.runtime-head,
.runtime-row,
.runtime-meta {
  display: flex;
  align-items: center;
}

.runtime-head {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.runtime-list {
  display: grid;
  gap: 8px;
}

.runtime-row {
  min-height: 42px;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--n-border-color);
  border-radius: 8px;
}

.runtime-main {
  display: grid;
  min-width: 130px;
  gap: 2px;
}

.runtime-main span {
  color: var(--n-text-color-3);
  font-size: 12px;
}

.runtime-meta {
  flex: 1;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  color: var(--n-text-color-2);
  font-size: 12px;
}

.runtime-meta code {
  overflow: hidden;
  max-width: 190px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .runtime-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .runtime-meta {
    justify-content: flex-start;
    width: 100%;
  }
}
</style>
