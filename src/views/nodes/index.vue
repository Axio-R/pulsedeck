<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { NButton, NPopconfirm, NTag } from 'naive-ui';
import {
  createPulseNode,
  createPulseNodeProtocol,
  deletePulseNode,
  deletePulseNodeProtocol,
  fetchPulseNodes,
  fetchPulseProtocols,
  openPulseTrafficSocket,
  queuePulseCommand,
  resetPulseNodeLinks,
  updatePulseNode,
  type PulseNode,
  type PulseProtocolMeta,
  type PulseTrafficEvent,
  type PulseTrafficNode
} from '@/service/api';
import { formatBeijingTime, formatBytes, formatRate } from '@/utils/pulse-format';

type ProtocolDraft = { type: string; port: number | null; listen: string; variant: string; settingsJson: string };
type TrafficDraft = {
  thresholdGb: number | null;
  limitMode: 'total' | 'download' | 'upload';
  warningPercent: number;
  autoDisableSubscription: boolean;
  subscriptionEnabled: boolean;
};
type TrafficSample = { time: number; rx: number; tx: number };
type TrafficSocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const trafficHistoryLimit = 60;
const loading = ref(false);
const nodes = ref<PulseNode[]>([]);
const protocolMetas = ref<PulseProtocolMeta[]>([]);
const form = reactive({ name: '', region: '', tags: '' });
const protocolDrafts = reactive<Record<string, ProtocolDraft>>({});
const trafficDrafts = reactive<Record<string, TrafficDraft>>({});
const trafficHistory = reactive<Record<string, TrafficSample[]>>({});
const trafficSocketState = ref<TrafficSocketState>('connecting');
const singBoxDrafts = reactive<Record<string, { version: string; downloadUrl: string; sha256: string }>>({});
const installDrawerVisible = ref(false);
const installDrawerNode = ref<PulseNode | null>(null);
let trafficSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let allowReconnect = true;

const columns = computed(() => [
  { title: '节点', key: 'name', minWidth: 160 },
  {
    title: '区域',
    key: 'region',
    width: 130,
    render(row: PulseNode) {
      return displayNodeRegion(row);
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
  {
    title: '最后上报',
    key: 'lastSeenAt',
    minWidth: 180,
    render(row: PulseNode) {
      return formatBeijingTime(row.lastSeenAt);
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 390,
    render(row: PulseNode) {
      return h('div', { class: 'table-actions' }, [
        h(NButton, { size: 'small', onClick: () => openInstallDrawer(row) }, { default: () => '安装命令' }),
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
    for (const node of nodes.value) {
      draftFor(node);
      trafficDraftFor(node);
      recordTrafficSample(
        {
          id: node.id,
          name: node.name,
          status: node.status,
          agentStatus: node.agentStatus,
          online: node.online,
          lastSeenAt: node.lastSeenAt,
          region: node.region,
          displayRegion: node.displayRegion,
          subscriptionEnabled: node.subscriptionEnabled,
          metrics: node.metrics,
          traffic: node.traffic,
          network: node.network
        },
        Date.now()
      );
    }
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
  const copied = await copyText(node.installCommand);
  if (copied) {
    window.$message?.success('安装命令已复制');
    return;
  }
  openInstallDrawer(node);
  window.$message?.warning('浏览器阻止剪贴板，已打开安装命令');
}

async function copyReportedLinks(node: PulseNode) {
  if (!node.reportedLinks?.length) {
    window.$message?.warning('节点还没有上报订阅链接');
    return;
  }
  const copied = await copyText(node.reportedLinks.join('\n'));
  if (copied) window.$message?.success('已复制上报链接');
  else window.$message?.error('复制失败，请在命令记录中查看上报链接');
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand for non-secure origins and strict clipboard policies.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

function openInstallDrawer(node: PulseNode) {
  installDrawerNode.value = node;
  installDrawerVisible.value = true;
}

async function queue(node: PulseNode, type: string) {
  const command = await queuePulseCommand(node.id, type);
  window.$message?.success(`${commandLabel(command.type)} 已下发，可在命令队列查看输出`);
}

function singBoxDraftFor(node: PulseNode) {
  if (!singBoxDrafts[node.id]) {
    singBoxDrafts[node.id] = {
      version: '',
      downloadUrl: '',
      sha256: ''
    };
  }
  return singBoxDrafts[node.id];
}

async function queueSingBoxInstall(node: PulseNode, reinstall = false) {
  const draft = singBoxDraftFor(node);
  const payload: Record<string, string> = {};
  if (draft.version.trim()) payload.version = draft.version.trim().replace(/^v/, '');
  if (draft.downloadUrl.trim()) payload.downloadUrl = draft.downloadUrl.trim();
  if (draft.sha256.trim()) payload.sha256 = draft.sha256.trim();
  await queuePulseCommand(node.id, reinstall ? 'sing-box-reinstall' : 'sing-box-install', payload);
  window.$message?.success(reinstall ? '已下发 sing-box 更新命令' : '已下发 sing-box 安装命令');
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
      listen: '0.0.0.0',
      variant: '',
      settingsJson: ''
    };
  }
  return protocolDrafts[node.id];
}

function protocolOptions() {
  return protocolMetas.value.map(item => ({
    label: item.name,
    value: item.type
  }));
}

function protocolVariantOptions(node: PulseNode) {
  const draft = draftFor(node);
  const meta = protocolMetas.value.find(item => item.type === draft.type);
  return (meta?.variants || []).map(variant => ({ label: variant, value: variant }));
}

function syncDraftPort(node: PulseNode) {
  const draft = draftFor(node);
  const meta = protocolMetas.value.find(item => item.type === draft.type);
  draft.port = meta?.defaultPort || draft.port || 443;
  draft.variant = meta?.variants?.[0] || draft.variant || '';
}

async function addProtocol(node: PulseNode) {
  const draft = draftFor(node);
  let settings: Record<string, unknown> = {};
  if (draft.settingsJson.trim()) {
    try {
      const parsed = JSON.parse(draft.settingsJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings must be an object');
      settings = parsed as Record<string, unknown>;
    } catch {
      window.$message?.error('高级设置必须是 JSON 对象');
      return;
    }
  }
  const result = await createPulseNodeProtocol(node.id, {
    type: draft.type,
    port: draft.port,
    listen: draft.listen,
    variant: draft.variant,
    settings
  });
  node.protocols.push(result.protocol);
  draft.settingsJson = '';
  window.$message?.success(`已添加并推送 ${result.protocol.name}`);
}

async function removeProtocol(node: PulseNode, protocolId: string) {
  await deletePulseNodeProtocol(node.id, protocolId);
  node.protocols = node.protocols.filter(item => item.id !== protocolId);
  window.$message?.success('已删除并推送协议变更');
}

async function saveRegion(node: PulseNode) {
  const result = await updatePulseNode(node.id, { region: node.region });
  Object.assign(node, result);
  window.$message?.success('区域已保存');
}

function trafficDraftFor(node: PulseNode) {
  if (!trafficDrafts[node.id]) {
    const thresholdBytes = Number(node.traffic?.thresholdBytes) || 0;
    trafficDrafts[node.id] = {
      thresholdGb: thresholdBytes > 0 ? Number((thresholdBytes / 1024 ** 3).toFixed(2)) : null,
      limitMode: node.traffic?.limitMode || 'total',
      warningPercent: Number(node.traffic?.warningPercent) || 80,
      autoDisableSubscription: node.traffic?.autoDisableSubscription === true,
      subscriptionEnabled: node.subscriptionEnabled === true
    };
  }
  return trafficDrafts[node.id];
}

async function saveTrafficPolicy(node: PulseNode) {
  const draft = trafficDraftFor(node);
  const thresholdGb = Number(draft.thresholdGb) || 0;
  const result = await updatePulseNode(node.id, {
    subscriptionEnabled: draft.subscriptionEnabled,
    traffic: {
      thresholdBytes: thresholdGb > 0 ? Math.round(thresholdGb * 1024 ** 3) : 0,
      limitMode: draft.limitMode,
      warningPercent: draft.warningPercent,
      autoDisableSubscription: draft.autoDisableSubscription
    }
  });
  Object.assign(node, result);
  delete trafficDrafts[node.id];
  trafficDraftFor(node);
  window.$message?.success('流量策略已保存');
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

function displayNodeRegion(node: PulseNode) {
  return node.displayRegion || node.region || '等待 Agent 上报';
}

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

function protocolMode(protocol: PulseNode['protocols'][number]) {
  return [protocol.security, protocol.transport, protocol.variant].filter(Boolean).join(' / ') || 'tcp';
}

function protocolBadges(protocol: PulseNode['protocols'][number]) {
  const settings = protocol.settings || {};
  const textSetting = (key: string) => {
    const value = settings[key];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  };
  const security = protocol.security || textSetting('security') || (['tls', 'reality'].includes(protocol.variant) ? protocol.variant : '');
  const transport =
    protocol.transport ||
    textSetting('transport') ||
    textSetting('network') ||
    (['ws', 'grpc', 'http', 'httpupgrade'].includes(protocol.variant) ? protocol.variant : 'tcp');
  const badges = [
    protocol.enabled ? '启用' : '停用',
    `端口 ${protocol.port}`,
    protocol.listen && protocol.listen !== '0.0.0.0' ? `监听 ${protocol.listen}` : '',
    `传输 ${transport || 'tcp'}`,
    security ? `安全 ${security}` : '明文'
  ].filter(Boolean);
  const sni = textSetting('serverName') || textSetting('sni');
  if (sni) badges.push(`SNI ${sni}`);
  const path = textSetting('path') || textSetting('wsPath') || textSetting('serviceName') || textSetting('service_name');
  if (path) badges.push(path);
  return badges;
}

function recordTrafficSample(item: PulseTrafficNode, time: number) {
  const samples = trafficHistory[item.id] || (trafficHistory[item.id] = []);
  const rx = Number(item.traffic?.rxRateBytesPerSecond) || 0;
  const tx = Number(item.traffic?.txRateBytesPerSecond) || 0;
  const last = samples[samples.length - 1];
  if (last && last.time === time) {
    last.rx = rx;
    last.tx = tx;
  } else {
    samples.push({ time, rx, tx });
  }
  if (samples.length > trafficHistoryLimit) samples.splice(0, samples.length - trafficHistoryLimit);
}

function trafficSamples(node: PulseNode) {
  return trafficHistory[node.id] || [];
}

function trafficPeak(node: PulseNode) {
  const peak = trafficSamples(node).reduce((max, sample) => Math.max(max, sample.rx, sample.tx), 0);
  return peak > 0 ? peak : 1;
}

function trafficPath(node: PulseNode, direction: 'rx' | 'tx') {
  const samples = trafficSamples(node);
  if (samples.length < 2) return '';
  const width = 240;
  const height = 52;
  const peak = trafficPeak(node);
  return samples
    .map((sample, index) => {
      const x = (index / (samples.length - 1)) * width;
      const y = height - (Math.max(0, sample[direction]) / peak) * height;
      return `${x.toFixed(1)},${Math.max(0, Math.min(height, y)).toFixed(1)}`;
    })
    .join(' ');
}

function latestTrafficRate(node: PulseNode, direction: 'rx' | 'tx') {
  return direction === 'rx' ? node.traffic?.rxRateBytesPerSecond : node.traffic?.txRateBytesPerSecond;
}

function trafficUsagePercent(node: PulseNode) {
  const threshold = Number(node.traffic?.thresholdBytes) || 0;
  if (threshold <= 0) return 0;
  return Math.min(100, Math.round((trafficLimitValue(node) / threshold) * 1000) / 10);
}

function trafficUsageLabel(node: PulseNode) {
  const threshold = Number(node.traffic?.thresholdBytes) || 0;
  if (threshold <= 0) return '未设置阈值';
  return `${trafficLimitModeLabel(node.traffic?.limitMode)} ${trafficUsagePercent(node)}% / ${formatBytes(threshold)}`;
}

function trafficLimitValue(node: PulseNode) {
  const mode = node.traffic?.limitMode || 'total';
  if (mode === 'download') return Number(node.traffic?.totalRxBytes) || 0;
  if (mode === 'upload') return Number(node.traffic?.totalTxBytes) || 0;
  return Number(node.traffic?.totalBytes) || 0;
}

function trafficLimitModeLabel(mode?: string) {
  return { total: '总量', download: '下载', upload: '上传' }[mode || 'total'] || '总量';
}

function trafficLimitModeOptions() {
  return [
    { label: '总量', value: 'total' },
    { label: '下载', value: 'download' },
    { label: '上传', value: 'upload' }
  ];
}

function trafficSocketTagType() {
  if (trafficSocketState.value === 'live') return 'success';
  if (trafficSocketState.value === 'connecting' || trafficSocketState.value === 'reconnecting') return 'warning';
  return 'error';
}

function trafficSocketLabel() {
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
  const sampleTime = event.time ? Date.parse(event.time) || Date.now() : Date.now();
  for (const item of event.items) {
    const node = nodes.value.find(current => current.id === item.id);
    recordTrafficSample(item, sampleTime);
    if (!node) continue;
    node.status = item.status;
    node.agentStatus = item.agentStatus;
    node.online = item.online;
    node.lastSeenAt = item.lastSeenAt;
    node.region = item.region;
    node.displayRegion = item.displayRegion;
    node.subscriptionEnabled = item.subscriptionEnabled;
    node.metrics = item.metrics;
    node.traffic = item.traffic;
    node.network = item.network;
  }
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
        // Ignore malformed frames from interrupted connections.
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

async function removeNode(node: PulseNode) {
  const result = await deletePulseNode(node.id);
  nodes.value = nodes.value.filter(item => item.id !== node.id);
  delete trafficHistory[node.id];
  delete trafficDrafts[node.id];
  delete protocolDrafts[node.id];
  window.$message?.success(`节点已删除，清理 Agent ${result.removedAgents} 个、命令 ${result.removedCommands} 条`);
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
        <NSpace :size="8" align="center">
          <NTag size="small" :type="trafficSocketTagType()" round>{{ trafficSocketLabel() }}</NTag>
          <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
        </NSpace>
      </template>
      <NDataTable :columns="columns" :data="nodes" :loading="loading" :bordered="false" />
    </NCard>

    <NGrid :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <NGi v-for="node in nodes" :key="node.id" span="24 l:12 2xl:8">
        <NCard :bordered="false" class="card-wrapper node-card">
          <div class="node-head">
            <div class="min-w-0">
              <div class="node-title">{{ node.name }}</div>
              <div class="node-subtitle">
                {{ displayNodeRegion(node) }} · {{ node.network?.primaryIpv4 || node.network?.primaryIpv6 || '等待 Agent 上报' }}
              </div>
            </div>
            <NTag :type="node.online ? 'success' : 'warning'" size="small" round>{{ node.online ? '在线' : node.agentStatus }}</NTag>
          </div>

          <div class="metric-grid">
            <div class="metric-item">
              <span>IP</span>
              <strong>{{ ipModeLabel(node.network?.ipMode) }}</strong>
            </div>
            <div class="metric-item">
              <span>CPU</span>
              <strong>{{ node.metrics?.cpu?.usagePercent == null ? '-' : `${node.metrics.cpu.usagePercent}%` }}</strong>
            </div>
            <div class="metric-item">
              <span>内存</span>
              <strong>{{ node.metrics?.memory?.usagePercent == null ? '-' : `${node.metrics.memory.usagePercent}%` }}</strong>
            </div>
            <div class="metric-item">
              <span>下载速率</span>
              <strong>{{ formatRate(node.traffic?.rxRateBytesPerSecond) }}</strong>
            </div>
            <div class="metric-item">
              <span>上传速率</span>
              <strong>{{ formatRate(node.traffic?.txRateBytesPerSecond) }}</strong>
            </div>
            <div class="metric-item">
              <span>下载总量</span>
              <strong>{{ formatBytes(node.traffic?.totalRxBytes) }}</strong>
            </div>
            <div class="metric-item">
              <span>上传总量</span>
              <strong>{{ formatBytes(node.traffic?.totalTxBytes) }}</strong>
            </div>
            <div class="metric-item">
              <span>总流量</span>
              <strong>{{ formatBytes(node.traffic?.totalBytes) }}</strong>
            </div>
            <div class="metric-item">
              <span>订阅</span>
              <strong>{{ node.subscriptionEnabled ? '启用' : '停用' }}</strong>
            </div>
            <div class="metric-item">
              <span>最后上报</span>
              <strong>{{ formatBeijingTime(node.lastSeenAt) }}</strong>
            </div>
          </div>

          <div class="traffic-panel">
            <div class="traffic-head">
              <div>
                <div class="traffic-title">实时流量</div>
                <div class="traffic-subtitle">峰值 {{ formatRate(trafficPeak(node)) }} · {{ trafficSamples(node).length }} 个样本</div>
              </div>
              <div class="traffic-rates">
                <span class="rx">下载 {{ formatRate(latestTrafficRate(node, 'rx')) }}</span>
                <span class="tx">上传 {{ formatRate(latestTrafficRate(node, 'tx')) }}</span>
              </div>
            </div>
            <div class="traffic-chart">
              <svg viewBox="0 0 240 52" preserveAspectRatio="none" aria-hidden="true">
                <line x1="0" y1="51.5" x2="240" y2="51.5" class="axis-line" />
                <polyline v-if="trafficPath(node, 'rx')" :points="trafficPath(node, 'rx')" class="traffic-line rx-line" />
                <polyline v-if="trafficPath(node, 'tx')" :points="trafficPath(node, 'tx')" class="traffic-line tx-line" />
              </svg>
              <div v-if="trafficSamples(node).length < 2" class="traffic-empty">等待流量样本</div>
            </div>
            <div class="traffic-limit">
              <div class="traffic-limit-bar">
                <span :style="{ width: `${trafficUsagePercent(node)}%` }" />
              </div>
              <span>{{ trafficUsageLabel(node) }}</span>
            </div>
          </div>

          <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive class="mt-10px">
            <NGi span="24 s:17">
              <NInput v-model:value="node.region" size="small" placeholder="手动修正区域" />
            </NGi>
            <NGi span="24 s:7">
              <NButton size="small" block secondary @click="saveRegion(node)">保存区域</NButton>
            </NGi>
          </NGrid>

          <NDivider class="my-10px" />

          <div class="section-head">
            <NText strong>协议</NText>
            <NText depth="3">{{ node.protocols?.length || 0 }} 个协议</NText>
          </div>
          <div v-if="node.protocols?.length" class="protocol-list">
            <div v-for="protocol in node.protocols" :key="protocol.id" class="protocol-row">
              <div class="protocol-main">
                <div class="protocol-name">
                  {{ protocol.name }}
                  <span>{{ protocolMode(protocol) }}</span>
                </div>
                <NSpace :size="6" class="protocol-badges">
                  <NTag v-for="badge in protocolBadges(protocol)" :key="badge" size="small" :bordered="false">
                    {{ badge }}
                  </NTag>
                </NSpace>
              </div>
              <NPopconfirm @positive-click="removeProtocol(node, protocol.id)">
                <template #trigger>
                  <NButton size="tiny" secondary type="error">删除并推送</NButton>
                </template>
                删除 {{ protocol.name }} :{{ protocol.port }} 并推送远程配置？
              </NPopconfirm>
            </div>
          </div>
          <NEmpty v-else size="small" description="暂无协议" />

          <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive class="mt-10px">
            <NGi span="24 s:8">
              <NSelect
                v-model:value="draftFor(node).type"
                size="small"
                :options="protocolOptions()"
                @update:value="syncDraftPort(node)"
              />
            </NGi>
            <NGi span="12 s:4">
              <NInputNumber v-model:value="draftFor(node).port" size="small" :min="1" :max="65535" placeholder="端口" class="w-full" />
            </NGi>
            <NGi span="12 s:4">
              <NInput v-model:value="draftFor(node).listen" size="small" placeholder="监听" />
            </NGi>
            <NGi span="24 s:5">
              <NSelect
                v-model:value="draftFor(node).variant"
                size="small"
                :options="protocolVariantOptions(node)"
                filterable
                tag
                clearable
                placeholder="变体"
              />
            </NGi>
            <NGi span="24 s:3">
              <NButton size="small" type="primary" block @click="addProtocol(node)">添加并推送</NButton>
            </NGi>
            <NGi span="24">
              <NInput
                v-model:value="draftFor(node).settingsJson"
                size="small"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 3 }"
                placeholder="高级设置 JSON"
              />
            </NGi>
          </NGrid>

          <NDivider class="my-10px" />

          <div class="section-head">
            <NText strong>流量策略</NText>
            <NText depth="3">{{ trafficUsageLabel(node) }}</NText>
          </div>
          <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive>
            <NGi span="12 s:6">
              <NInputNumber
                v-model:value="trafficDraftFor(node).thresholdGb"
                size="small"
                :min="0"
                :precision="2"
                placeholder="阈值 GB"
                class="w-full"
              />
            </NGi>
            <NGi span="12 s:4">
              <NSelect v-model:value="trafficDraftFor(node).limitMode" size="small" :options="trafficLimitModeOptions()" />
            </NGi>
            <NGi span="12 s:4">
              <NInputNumber
                v-model:value="trafficDraftFor(node).warningPercent"
                size="small"
                :min="1"
                :max="100"
                placeholder="预警 %"
                class="w-full"
              />
            </NGi>
            <NGi span="12 s:5">
              <NCheckbox v-model:checked="trafficDraftFor(node).autoDisableSubscription">超限停订阅</NCheckbox>
            </NGi>
            <NGi span="12 s:4">
              <NCheckbox v-model:checked="trafficDraftFor(node).subscriptionEnabled">订阅启用</NCheckbox>
            </NGi>
            <NGi span="24 s:3">
              <NButton size="small" block secondary @click="saveTrafficPolicy(node)">保存</NButton>
            </NGi>
          </NGrid>

          <NDivider class="my-10px" />

          <div class="node-actions">
            <NButton size="small" @click="openInstallDrawer(node)">安装命令</NButton>
            <NButton size="small" @click="copyInstall(node)">复制安装</NButton>
            <NButton size="small" @click="queue(node, 'probe')">探测</NButton>
            <NButton size="small" @click="queue(node, 'diagnostics')">诊断</NButton>
            <NButton size="small" @click="queue(node, 'sing-box-render')">渲染</NButton>
            <NButton size="small" type="primary" secondary @click="queue(node, 'sing-box-apply')">应用配置</NButton>
            <NButton size="small" @click="queue(node, 'sing-box-restart')">重启 sing-box</NButton>
            <NButton size="small" @click="resetLinks(node)">重置链接</NButton>
            <NButton size="small" :disabled="!node.reportedLinks?.length" @click="copyReportedLinks(node)">复制链接</NButton>
            <NPopover trigger="click" placement="top">
              <template #trigger>
                <NButton size="small">安装/更新 sing-box</NButton>
              </template>
              <NSpace vertical :size="8" class="singbox-popover">
                <NInput v-model:value="singBoxDraftFor(node).version" size="small" placeholder="版本，如 1.11.15" />
                <NInput v-model:value="singBoxDraftFor(node).downloadUrl" size="small" placeholder="下载 URL，可选" />
                <NInput v-model:value="singBoxDraftFor(node).sha256" size="small" placeholder="SHA-256，可选" />
                <NSpace :size="8">
                  <NButton size="small" type="primary" @click="queueSingBoxInstall(node, false)">安装</NButton>
                  <NButton size="small" secondary @click="queueSingBoxInstall(node, true)">强制更新</NButton>
                </NSpace>
              </NSpace>
            </NPopover>
            <NPopconfirm @positive-click="removeNode(node)">
              <template #trigger>
                <NButton size="small" type="error" secondary>删除节点</NButton>
              </template>
              删除节点 {{ node.name }}？
            </NPopconfirm>
          </div>
        </NCard>
      </NGi>
    </NGrid>

    <NDrawer v-model:show="installDrawerVisible" :width="560" placement="right">
      <NDrawerContent v-if="installDrawerNode" :title="`${installDrawerNode.name} 安装命令`" closable>
        <NSpace vertical :size="12">
          <NInput
            :value="installDrawerNode.installCommand"
            readonly
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 8 }"
          />
          <NSpace>
            <NButton type="primary" @click="copyInstall(installDrawerNode)">复制安装命令</NButton>
            <NButton secondary @click="queue(installDrawerNode, 'probe')">安装后立即探测</NButton>
          </NSpace>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </NSpace>
</template>

<style scoped>
.table-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-card :deep(.n-card__content) {
  padding-top: 14px;
}

.node-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.node-title {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 16px;
  font-weight: 650;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-subtitle {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.metric-item {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.07);
}

.metric-item span {
  display: block;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 15px;
}

.metric-item strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traffic-panel {
  margin-top: 10px;
  padding: 9px;
  border: 1px solid rgba(96, 165, 250, 0.22);
  border-radius: 6px;
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(16, 185, 129, 0.05));
}

.traffic-head,
.traffic-limit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.traffic-title {
  color: var(--n-text-color, #1f2937);
  font-size: 12px;
  font-weight: 650;
  line-height: 18px;
}

.traffic-subtitle,
.traffic-limit span:last-child {
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 16px;
}

.traffic-rates {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
}

.traffic-rates span {
  white-space: nowrap;
}

.traffic-rates .rx {
  color: #2563eb;
}

.traffic-rates .tx {
  color: #059669;
}

.traffic-chart {
  position: relative;
  height: 62px;
  margin-top: 6px;
  overflow: hidden;
}

.traffic-chart svg {
  display: block;
  width: 100%;
  height: 52px;
}

.axis-line {
  stroke: rgba(148, 163, 184, 0.32);
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

.traffic-limit {
  margin-top: 4px;
}

.traffic-limit-bar {
  flex: 1;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
}

.traffic-limit-bar span {
  display: block;
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2563eb, #059669);
  transition: width 0.2s ease;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.protocol-list {
  display: grid;
  gap: 8px;
}

.protocol-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 6px;
}

.protocol-main {
  min-width: 0;
}

.protocol-name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--n-text-color, #1f2937);
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
}

.protocol-name span {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.protocol-badges {
  margin-top: 5px;
}

.node-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.singbox-popover {
  width: min(320px, calc(100vw - 48px));
}

@media (max-width: 640px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .protocol-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .traffic-head,
  .traffic-limit {
    align-items: flex-start;
    flex-direction: column;
  }

  .traffic-rates {
    justify-content: flex-start;
  }
}
</style>
