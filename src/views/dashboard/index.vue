<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { fetchPulseDashboard, openPulseTrafficSocket, type PulseDashboard, type PulseTrafficEvent } from '@/service/api';
import { compactRegion, formatBeijingTime, formatBytes, formatRate, regionFlagUrl } from '@/utils/pulse-format';

type TrafficSocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';
type TrafficSample = { time: number; rx: number; tx: number; totalRx: number; totalTx: number; total: number };

const loading = ref(false);
const dashboard = ref<PulseDashboard | null>(null);
const trafficHistory = reactive<{ samples: TrafficSample[] }>({ samples: [] });
const trafficSocketState = ref<TrafficSocketState>('connecting');
const trafficHistoryLimit = 72;
let trafficSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let allowReconnect = true;

const dashboardTraffic = computed(() => dashboard.value?.traffic || {
  totalRxBytes: 0,
  totalTxBytes: 0,
  totalBytes: 0,
  rxRateBytesPerSecond: 0,
  txRateBytesPerSecond: 0
});

const latestTraffic = computed(
  () =>
    trafficHistory.samples[trafficHistory.samples.length - 1] || {
      time: 0,
      rx: dashboardTraffic.value.rxRateBytesPerSecond,
      tx: dashboardTraffic.value.txRateBytesPerSecond,
      totalRx: dashboardTraffic.value.totalRxBytes,
      totalTx: dashboardTraffic.value.totalTxBytes,
      total: dashboardTraffic.value.totalBytes
    }
);

async function loadData() {
  loading.value = true;
  try {
    dashboard.value = await fetchPulseDashboard();
  } finally {
    loading.value = false;
  }
}

function trafficPeak() {
  const peak = trafficHistory.samples.reduce((max, sample) => Math.max(max, sample.rx, sample.tx), 0);
  return peak > 0 ? peak : Math.max(dashboardTraffic.value.rxRateBytesPerSecond, dashboardTraffic.value.txRateBytesPerSecond, 1);
}

function trafficPath(direction: 'rx' | 'tx') {
  const samples = trafficHistory.samples;
  if (samples.length < 2) return '';
  const width = 320;
  const height = 74;
  const peak = trafficPeak();
  return samples
    .map((sample, index) => {
      const x = (index / (samples.length - 1)) * width;
      const y = height - (Math.max(0, sample[direction]) / peak) * height;
      return `${x.toFixed(1)},${Math.max(0, Math.min(height, y)).toFixed(1)}`;
    })
    .join(' ');
}

function socketTagType() {
  if (trafficSocketState.value === 'live') return 'success';
  if (trafficSocketState.value === 'connecting' || trafficSocketState.value === 'reconnecting') return 'warning';
  return 'error';
}

function socketLabel() {
  const labels: Record<TrafficSocketState, string> = {
    connecting: '连接中',
    live: '实时',
    reconnecting: '重连中',
    offline: '已断开'
  };
  return labels[trafficSocketState.value];
}

function applyTrafficEvent(event: PulseTrafficEvent) {
  if (event.type !== 'traffic.snapshot' || !event.items?.length) return;
  const sample = event.items.reduce(
    (total, item) => ({
      rx: total.rx + (Number(item.traffic?.rxRateBytesPerSecond) || 0),
      tx: total.tx + (Number(item.traffic?.txRateBytesPerSecond) || 0),
      totalRx: total.totalRx + (Number(item.traffic?.totalRxBytes) || 0),
      totalTx: total.totalTx + (Number(item.traffic?.totalTxBytes) || 0),
      total: total.total + (Number(item.traffic?.totalBytes) || 0)
    }),
    { rx: 0, tx: 0, totalRx: 0, totalTx: 0, total: 0 }
  );
  trafficHistory.samples.push({
    time: event.time ? Date.parse(event.time) || Date.now() : Date.now(),
    ...sample
  });
  if (trafficHistory.samples.length > trafficHistoryLimit) {
    trafficHistory.samples.splice(0, trafficHistory.samples.length - trafficHistoryLimit);
  }
}

function displayRegion(node: PulseDashboard['recentNodes'][number]) {
  return compactRegion(node.displayRegion || node.region || node.network?.detectedRegion || '');
}

function displayRegionFlag(node: PulseDashboard['recentNodes'][number]) {
  return regionFlagUrl(displayRegion(node));
}

function commandLabel(type: string) {
  const labels: Record<string, string> = {
    probe: '探测',
    diagnostics: '诊断',
    restart: '重启 Agent',
    'agent-update-check': '检查 Agent',
    'agent-update': '更新 Agent',
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
  return { queued: '等待 Agent', running: '执行中', succeeded: '成功', failed: '失败' }[status] || status;
}

function commandStatusType(status: string) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'warning';
}

function scheduleTrafficReconnect() {
  if (!allowReconnect || reconnectTimer) return;
  trafficSocketState.value = 'reconnecting';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTrafficStream();
  }, 3000);
}

function connectTrafficStream() {
  if (trafficSocket) trafficSocket.close();
  try {
    trafficSocketState.value = 'connecting';
    trafficSocket = openPulseTrafficSocket();
    trafficSocket.onopen = () => {
      trafficSocketState.value = 'live';
    };
    trafficSocket.onmessage = event => {
      try {
        applyTrafficEvent(JSON.parse(event.data) as PulseTrafficEvent);
      } catch {
        // Ignore partial frames from interrupted connections.
      }
    };
    trafficSocket.onclose = () => {
      trafficSocketState.value = allowReconnect ? 'reconnecting' : 'offline';
      scheduleTrafficReconnect();
    };
    trafficSocket.onerror = () => trafficSocket?.close();
  } catch {
    scheduleTrafficReconnect();
  }
}

onMounted(() => {
  loadData();
  connectTrafficStream();
});

onUnmounted(() => {
  allowReconnect = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (trafficSocket) trafficSocket.close();
});
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :bordered="false" class="card-wrapper">
      <NThing
        title="PulseDeck 工作台"
        :description="`在线 ${dashboard?.counts.onlineNodes ?? 0}/${dashboard?.counts.nodes ?? 0} · 待处理命令 ${dashboard?.counts.queuedCommands ?? 0}`"
      >
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
      <NGi span="24">
        <NCard title="全局实时流量" :bordered="false" class="card-wrapper">
          <template #header-extra>
            <NTag size="small" :type="socketTagType()" round>{{ socketLabel() }}</NTag>
          </template>
          <div class="traffic-summary">
            <div>
              <span>下载速率</span>
              <strong>{{ formatRate(latestTraffic.rx) }}</strong>
            </div>
            <div>
              <span>上传速率</span>
              <strong>{{ formatRate(latestTraffic.tx) }}</strong>
            </div>
            <div>
              <span>下载总量</span>
              <strong>{{ formatBytes(latestTraffic.totalRx) }}</strong>
            </div>
            <div>
              <span>上传总量</span>
              <strong>{{ formatBytes(latestTraffic.totalTx) }}</strong>
            </div>
            <div>
              <span>总流量</span>
              <strong>{{ formatBytes(latestTraffic.total) }}</strong>
            </div>
            <div>
              <span>峰值</span>
              <strong>{{ formatRate(trafficPeak()) }}</strong>
            </div>
          </div>
          <div class="traffic-chart">
            <svg viewBox="0 0 320 74" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1="73.5" x2="320" y2="73.5" class="axis-line" />
              <polyline v-if="trafficPath('rx')" :points="trafficPath('rx')" class="traffic-line rx-line" />
              <polyline v-if="trafficPath('tx')" :points="trafficPath('tx')" class="traffic-line tx-line" />
            </svg>
            <div v-if="trafficHistory.samples.length < 2" class="traffic-empty">等待流量样本</div>
          </div>
        </NCard>
      </NGi>
      <NGi span="24 m:12">
        <NCard title="最近节点" :bordered="false" class="card-wrapper">
          <NEmpty v-if="!dashboard?.recentNodes.length" description="暂无节点" />
          <NSpace v-else vertical>
            <div v-for="node in dashboard.recentNodes" :key="node.id" class="operation-row">
              <div>
                <div class="font-medium">{{ node.name }}</div>
                <div class="recent-node-meta">
                  <span class="region-badge-text">
                    <img class="region-flag-img" :src="displayRegionFlag(node)" alt="" />
                    <span>{{ displayRegion(node) }}</span>
                  </span>
                  <span>{{ formatBeijingTime(node.lastSeenAt) }}</span>
                </div>
              </div>
              <NTag :type="node.lastSeenAt ? 'success' : 'warning'" size="small">
                {{ node.online ? '在线' : node.agentStatus }}
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
                <div class="font-medium">{{ commandLabel(command.type) }}</div>
                <div class="text-12px text-gray-500">{{ formatBeijingTime(command.updatedAt) }}</div>
              </div>
              <NTag size="small" :type="commandStatusType(command.status)">{{ commandStatusLabel(command.status) }}</NTag>
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

.traffic-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.traffic-summary > div {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.06);
}

.traffic-summary span {
  display: block;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 15px;
}

.traffic-summary strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 14px;
  font-weight: 650;
  line-height: 21px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traffic-chart {
  position: relative;
  height: 86px;
  overflow: hidden;
  border: 1px solid rgba(96, 165, 250, 0.18);
  border-radius: 6px;
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.07), rgba(16, 185, 129, 0.04));
}

.traffic-chart svg {
  display: block;
  width: 100%;
  height: 74px;
  margin-top: 6px;
}

.axis-line {
  stroke: rgba(148, 163, 184, 0.34);
  stroke-width: 1;
}

.traffic-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.2;
  vector-effect: non-scaling-stroke;
}

.rx-line {
  stroke: #2563eb;
}

.tx-line {
  stroke: #059669;
}

.traffic-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 12px;
  pointer-events: none;
}

.recent-node-meta,
.region-badge-text {
  display: flex;
  align-items: center;
  min-width: 0;
}

.recent-node-meta {
  gap: 8px;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 12px;
  line-height: 18px;
}

.region-badge-text {
  gap: 6px;
  flex: 0 0 auto;
  color: var(--n-text-color, #1f2937);
  font-weight: 700;
  white-space: nowrap;
}

.region-flag-img {
  display: block;
  width: 20px;
  height: 14px;
  flex: 0 0 auto;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 2px;
  object-fit: cover;
  background: #f8fafc;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

@media (max-width: 640px) {
  .traffic-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
