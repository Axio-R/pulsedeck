<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { NButton, NDropdown, NPopconfirm, NTag, type DataTableColumns } from 'naive-ui';
import {
  batchDeletePulseNodes,
  batchPulseNodeCommand,
  createPulseNode,
  createPulseNodeProtocol,
  deletePulseNode,
  deletePulseNodeProtocol,
  fetchPulseNodes,
  fetchPulseProtocols,
  fetchPulseTrafficHistory,
  fetchPulseTrafficRank,
  openPulseTrafficSocket,
  queuePulseCommand,
  reorderPulseNodes,
  resetPulseTraffic,
  resetPulseNodeLinks,
  updatePulseNode,
  type PulseNode,
  type PulseProtocolMeta,
  type PulseSubscriptionUrl,
  type PulseTrafficEvent,
  type PulseTrafficHistoryItem,
  type PulseTrafficRankItem
} from '@/service/api';
import { copyText } from '@/utils/clipboard';
import { compactRegion, formatBeijingTime, formatBytes, formatRate, regionBadge, regionFlag } from '@/utils/pulse-format';

type ProtocolDraft = { type: string; port: number | null; listen: string; variant: string; settingsJson: string };
type TrafficDraft = {
  thresholdGb: number | null;
  limitMode: 'total' | 'download' | 'upload';
  warningPercent: number;
  autoDisableSubscription: boolean;
  subscriptionEnabled: boolean;
  resetMode: 'none' | 'daily' | 'weekly' | 'monthly' | 'interval';
  resetDay: number;
  resetIntervalDays: number;
};
type NodeIpRow = { label: string; value: string; tone: 'warp' | 'ipv4' | 'ipv6' | 'muted' };
type TrafficSocketState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const defaultSingBoxVersion = '1.11.15';
const loading = ref(false);
const nodes = ref<PulseNode[]>([]);
const protocolMetas = ref<PulseProtocolMeta[]>([]);
const form = reactive({ name: '', region: '', group: '', tags: '' });
const protocolDrafts = reactive<Record<string, ProtocolDraft>>({});
const trafficDrafts = reactive<Record<string, TrafficDraft>>({});
const selectedNodeIds = ref<string[]>([]);
const groupFilter = ref('all');
const rankMode = ref<'total' | 'download' | 'upload'>('total');
const trafficRank = ref<PulseTrafficRankItem[]>([]);
const persistedTrafficHistory = ref<PulseTrafficHistoryItem[]>([]);
const historyNodeId = ref('');
const trafficSocketState = ref<TrafficSocketState>('connecting');
const singBoxDrafts = reactive<Record<string, { version: string; downloadUrl: string; sha256: string }>>({});
const installDrawerVisible = ref(false);
const installDrawerNode = ref<PulseNode | null>(null);
const protocolResultVisible = ref(false);
const protocolResultNode = ref<PulseNode | null>(null);
const protocolResultLinks = ref<string[]>([]);
const protocolResultSubscriptions = ref<PulseSubscriptionUrl[]>([]);
let trafficSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let allowReconnect = true;

const columns = computed<DataTableColumns<PulseNode>>(() => [
  { type: 'selection', width: 44 },
  { title: '节点', key: 'name', minWidth: 160 },
  {
    title: '区域',
    key: 'region',
    width: 118,
    render(row: PulseNode) {
      return h('span', { class: 'region-badge-text', title: displayNodeRegion(row) }, regionBadgeLabel(row));
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
    title: 'Agent',
    key: 'agentVersion',
    width: 150,
    render(row: PulseNode) {
      return h('div', { class: 'agent-version-cell' }, [
        h('strong', agentVersionLabel(row)),
        h(
          NTag,
          { type: row.agent?.updateAvailable ? 'warning' : 'success', size: 'small', bordered: false },
          { default: () => (row.agent?.updateAvailable ? '可更新' : '最新') }
        )
      ]);
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
    width: 270,
    render(row: PulseNode) {
      return h('div', { class: 'table-actions' }, [
        h(NButton, { size: 'small', onClick: () => openInstallDrawer(row) }, { default: () => '安装命令' }),
        h(NButton, { size: 'small', type: 'primary', secondary: true, onClick: () => queue(row, 'sing-box-apply') }, { default: () => '应用配置' }),
        h(
          NDropdown,
          { options: nodeMoreActionOptions(row), trigger: 'click', onSelect: (key: string) => handleNodeAction(row, key) },
          { default: () => h(NButton, { size: 'small' }, { default: () => '更多' }) }
        ),
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

const visibleNodes = computed(() => {
  const group = groupFilter.value;
  return nodes.value.filter(node => group === 'all' || (node.group || '未分组') === group);
});

const groupOptions = computed(() => [
  { label: '全部分组', value: 'all' },
  ...[...new Set(nodes.value.map(node => node.group || '未分组'))]
    .sort((a, b) => a.localeCompare(b))
    .map(group => ({ label: group, value: group }))
]);

const historyNodeOptions = computed(() => nodes.value.map(node => ({ label: node.name, value: node.id })));

function rowKey(row: PulseNode) {
  return row.id;
}

async function loadData() {
  loading.value = true;
  try {
    const [nodeRes, protocolRes] = await Promise.all([fetchPulseNodes(), fetchPulseProtocols()]);
    nodes.value = nodeRes.items;
    protocolMetas.value = protocolRes.items;
    if (!historyNodeId.value && nodes.value[0]) historyNodeId.value = nodes.value[0].id;
    for (const node of nodes.value) {
      draftFor(node);
      trafficDraftFor(node);
    }
    void loadTrafficAnalytics().catch(() => {});
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const node = await createPulseNode({
    name: form.name || '新节点',
    region: form.region || undefined,
    group: form.group || undefined,
    tags: form.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)
  });
  nodes.value.unshift(node);
  form.name = '';
  form.region = '';
  form.group = '';
  form.tags = '';
  if (!historyNodeId.value) historyNodeId.value = node.id;
  await loadTrafficAnalytics();
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

function openInstallDrawer(node: PulseNode) {
  installDrawerNode.value = node;
  installDrawerVisible.value = true;
}

async function queue(node: PulseNode, type: string) {
  const command = await queuePulseCommand(node.id, type);
  window.$message?.success(`${commandLabel(command.type)} 已下发，可在命令队列查看输出`);
}

function nodeMoreActionOptions(node: PulseNode) {
  return [
    { label: '复制安装命令', key: 'copy-install' },
    { label: '复制节点 IP', key: 'copy-ips' },
    { label: '复制上报链接', key: 'copy-links', disabled: !node.reportedLinks?.length },
    { type: 'divider', key: 'divider-copy' },
    { label: '探测节点', key: 'probe' },
    { label: '诊断节点', key: 'diagnostics' },
    { label: '渲染配置', key: 'sing-box-render' },
    { label: '应用配置', key: 'sing-box-apply' },
    { type: 'divider', key: 'divider-agent' },
    { label: '检查 Agent 更新', key: 'agent-update-check', disabled: !canRemoteUpdateAgent(node) },
    { label: '更新 Agent', key: 'agent-update', disabled: !canRemoteUpdateAgent(node) },
    { label: '重启 Agent', key: 'restart' },
    { type: 'divider', key: 'divider-singbox' },
    { label: '安装 sing-box', key: 'sing-box-install' },
    { label: '强制更新 sing-box', key: 'sing-box-reinstall' },
    { label: '重启 sing-box', key: 'sing-box-restart' },
    { label: '重置订阅链接', key: 'reset-links' },
    { type: 'divider', key: 'divider-order' },
    { label: '上移节点', key: 'move-up' },
    { label: '下移节点', key: 'move-down' }
  ];
}

async function handleNodeAction(node: PulseNode, key: string) {
  if (key === 'copy-install') return copyInstall(node);
  if (key === 'copy-ips') return copyNodeIps(node);
  if (key === 'copy-links') return copyReportedLinks(node);
  if (key === 'reset-links') return resetLinks(node);
  if (key === 'move-up') return moveNode(node, -1);
  if (key === 'move-down') return moveNode(node, 1);
  if (key === 'sing-box-install') return queueSingBoxInstall(node, false);
  if (key === 'sing-box-reinstall') return queueSingBoxInstall(node, true);
  return queue(node, key);
}

async function batchQueue(type: string) {
  if (!selectedNodeIds.value.length) {
    window.$message?.warning('请先选择节点');
    return;
  }
  const result = await batchPulseNodeCommand(selectedNodeIds.value, type);
  window.$message?.success(`已批量下发 ${result.queued} 条${commandLabel(type)}命令`);
}

async function batchAgentQueue(type: 'agent-update-check' | 'agent-update') {
  const nodeIds = nodes.value.filter(node => selectedNodeIds.value.includes(node.id) && canRemoteUpdateAgent(node)).map(node => node.id);
  if (!nodeIds.length) {
    window.$message?.warning('所选节点的 Agent 需先本地更新到 0.2.8 后才支持远程更新');
    return;
  }
  const result = await batchPulseNodeCommand(nodeIds, type);
  window.$message?.success(`已批量下发 ${result.queued} 条${commandLabel(type)}命令`);
}

async function batchDelete() {
  if (!selectedNodeIds.value.length) {
    window.$message?.warning('请先选择节点');
    return;
  }
  const result = await batchDeletePulseNodes(selectedNodeIds.value);
  nodes.value = nodes.value.filter(node => !selectedNodeIds.value.includes(node.id));
  selectedNodeIds.value = [];
  await loadTrafficAnalytics();
  window.$message?.success(`已删除 ${result.removedNodes} 个节点`);
}

async function moveNode(node: PulseNode, direction: -1 | 1) {
  const index = nodes.value.findIndex(item => item.id === node.id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= nodes.value.length) return;
  const next = nodes.value.slice();
  const [current] = next.splice(index, 1);
  next.splice(nextIndex, 0, current);
  nodes.value = next;
  const result = await reorderPulseNodes(nodes.value.map(item => item.id));
  nodes.value = result.items;
  window.$message?.success('节点顺序已保存');
}

async function copyNodeIps(node: PulseNode) {
  const text = nodeIpRows(node)
    .map(item => `${item.label}: ${item.value}`)
    .join('\n');
  if (await copyText(text)) window.$message?.success('节点 IP 已复制');
  else window.$message?.error('复制失败');
}

async function copyIpValue(value: string) {
  if (!value || value === '-') return;
  if (await copyText(value)) window.$message?.success('IP 已复制');
  else window.$message?.error('复制失败');
}

function singBoxDraftFor(node: PulseNode) {
  if (!singBoxDrafts[node.id]) {
    singBoxDrafts[node.id] = {
      version: defaultSingBoxVersion,
      downloadUrl: '',
      sha256: ''
    };
  }
  return singBoxDrafts[node.id];
}

async function queueSingBoxInstall(node: PulseNode, reinstall = false) {
  const draft = singBoxDraftFor(node);
  const payload: Record<string, string> = {};
  payload.version = (draft.version.trim() || defaultSingBoxVersion).replace(/^v/, '');
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
  protocolResultNode.value = node;
  protocolResultLinks.value = result.links || [];
  protocolResultSubscriptions.value = result.subscriptionUrls || [];
  protocolResultVisible.value = true;
  window.$message?.success(`已添加并推送 ${result.protocol.name}`);
}

async function copyProtocolResultLinks() {
  if (!protocolResultLinks.value.length) {
    window.$message?.warning('当前没有可复制的节点链接');
    return;
  }
  if (await copyText(protocolResultLinks.value.join('\n'))) window.$message?.success('节点链接已复制');
  else window.$message?.error('复制失败，请手动选中链接');
}

async function copyProtocolResultSubscriptions() {
  if (!protocolResultSubscriptions.value.length) {
    window.$message?.warning('当前没有可复制的订阅 URL');
    return;
  }
  const text = protocolResultSubscriptions.value.map(item => `${item.name} (${item.format}): ${item.publicUrl}`).join('\n');
  if (await copyText(text)) window.$message?.success('订阅 URL 已复制');
  else window.$message?.error('复制失败，请手动选中订阅 URL');
}

async function removeProtocol(node: PulseNode, protocolId: string) {
  await deletePulseNodeProtocol(node.id, protocolId);
  node.protocols = node.protocols.filter(item => item.id !== protocolId);
  window.$message?.success('已删除并推送协议变更');
}

async function saveRegion(node: PulseNode) {
  const result = await updatePulseNode(node.id, { region: node.region, group: node.group });
  Object.assign(node, result);
  window.$message?.success('区域与分组已保存');
}

function trafficDraftFor(node: PulseNode) {
  if (!trafficDrafts[node.id]) {
    const thresholdBytes = Number(node.traffic?.thresholdBytes) || 0;
    trafficDrafts[node.id] = {
      thresholdGb: thresholdBytes > 0 ? Number((thresholdBytes / 1024 ** 3).toFixed(2)) : null,
      limitMode: node.traffic?.limitMode || 'total',
      warningPercent: Number(node.traffic?.warningPercent) || 80,
      autoDisableSubscription: node.traffic?.autoDisableSubscription === true,
      subscriptionEnabled: node.subscriptionEnabled === true,
      resetMode: node.traffic?.resetMode || 'none',
      resetDay: Number(node.traffic?.resetDay) || 1,
      resetIntervalDays: Number(node.traffic?.resetIntervalDays) || 30
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
      autoDisableSubscription: draft.autoDisableSubscription,
      resetMode: draft.resetMode,
      resetDay: draft.resetDay,
      resetIntervalDays: draft.resetIntervalDays
    }
  });
  Object.assign(node, result);
  delete trafficDrafts[node.id];
  trafficDraftFor(node);
  window.$message?.success('流量策略已保存');
}

async function resetNodeTraffic(node: PulseNode) {
  await resetPulseTraffic([node.id]);
  await loadData();
  window.$message?.success('节点流量已清零');
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
  return compactRegion(node.displayRegion || node.region || node.network?.detectedRegion || '');
}

function regionIconLabel(node: PulseNode) {
  return node.regionIcon && node.regionIcon !== 'AUTO' ? node.regionIcon : regionFlag(displayNodeRegion(node));
}

function regionBadgeLabel(node: PulseNode) {
  return regionBadge(displayNodeRegion(node), regionIconLabel(node));
}

function agentVersionLabel(node: PulseNode) {
  return node.agent?.version && node.agent.version !== 'unknown' ? node.agent.version : '-';
}

function agentUpdateLabel(node: PulseNode) {
  const update = node.agent?.update || node.agentUpdate;
  if (node.agent?.updateAvailable || update?.updateAvailable) return `可更新 ${node.agent?.latestVersion || update?.latestVersion || ''}`.trim();
  if (update?.status === 'updated') return '已更新待重启';
  if (update?.status === 'unavailable') return '目标包未发布';
  if (node.agent?.runtimeAvailable === false) return '运行时未发布';
  return node.agent?.version && node.agent.version !== 'unknown' ? '最新' : '待上报';
}

function canRemoteUpdateAgent(node: PulseNode) {
  return node.agent?.remoteUpdateSupported === true;
}

function nodeIpRows(node: PulseNode): NodeIpRow[] {
  const rows: NodeIpRow[] = [];
  const warpAddresses = (node.addresses || [])
    .filter(item => /warp|wgcf|wireguard|^wg/i.test(item.interface || ''))
    .map(item => item.address)
    .filter(address => address && !isPrivateDisplayIp(address))
    .filter(Boolean);
  const warpPublicAddresses = [node.network?.warpIpv4, node.network?.warpIpv6]
    .filter(Boolean);

  if (node.network?.warpLikely || warpPublicAddresses.length || warpAddresses.length) {
    const value = [...new Set([...warpPublicAddresses, ...warpAddresses])].join(' / ') || '已识别';
    rows.push({ label: 'WARP', value, tone: 'warp' });
  }

  rows.push({
    label: 'IPv4',
    value: node.network?.primaryIpv4 || '-',
    tone: node.network?.primaryIpv4 ? 'ipv4' : 'muted'
  });
  rows.push({
    label: 'IPv6',
    value: node.network?.primaryIpv6 || '-',
    tone: node.network?.primaryIpv6 ? 'ipv6' : 'muted'
  });

  return rows;
}

function isPrivateDisplayIp(address: string) {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  const parts = address.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
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

function resetModeOptions() {
  return [
    { label: '不自动重置', value: 'none' },
    { label: '每日', value: 'daily' },
    { label: '每周', value: 'weekly' },
    { label: '每月', value: 'monthly' },
    { label: '间隔天数', value: 'interval' }
  ];
}

async function loadTrafficAnalytics() {
  const [rankRes, historyRes] = await Promise.all([
    fetchPulseTrafficRank(rankMode.value, 12),
    fetchPulseTrafficHistory({ nodeId: historyNodeId.value || undefined, limit: 120 })
  ]);
  trafficRank.value = rankRes.items;
  persistedTrafficHistory.value = historyRes.items.slice().reverse();
}

async function refreshTrafficAnalytics() {
  await loadTrafficAnalytics();
  window.$message?.success('流量分析已刷新');
}

function persistedTrafficPeak() {
  return Math.max(
    1,
    ...persistedTrafficHistory.value.flatMap(item => [Number(item.rxRateBytesPerSecond) || 0, Number(item.txRateBytesPerSecond) || 0])
  );
}

function persistedTrafficPath(direction: 'rx' | 'tx') {
  const samples = persistedTrafficHistory.value;
  if (samples.length < 2) return '';
  const width = 360;
  const height = 72;
  const peak = persistedTrafficPeak();
  return samples
    .map((sample, index) => {
      const value = direction === 'rx' ? sample.rxRateBytesPerSecond : sample.txRateBytesPerSecond;
      const x = (index / (samples.length - 1)) * width;
      const y = height - (Math.max(0, value) / peak) * height;
      return `${x.toFixed(1)},${Math.max(0, Math.min(height, y)).toFixed(1)}`;
    })
    .join(' ');
}

async function resetSelectedTraffic() {
  if (!selectedNodeIds.value.length) {
    window.$message?.warning('请先选择节点');
    return;
  }
  const result = await resetPulseTraffic(selectedNodeIds.value);
  await loadData();
  window.$message?.success(`已清零 ${result.reset} 个节点流量`);
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
  for (const item of event.items) {
    const node = nodes.value.find(current => current.id === item.id);
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
  delete trafficDrafts[node.id];
  delete protocolDrafts[node.id];
  await loadTrafficAnalytics();
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
        <NGi span="24 s:6">
          <NInput v-model:value="form.name" placeholder="节点名称" />
        </NGi>
        <NGi span="24 s:6">
          <NInput v-model:value="form.region" placeholder="区域可留空，Agent 上线后自动识别" />
        </NGi>
        <NGi span="24 s:5">
          <NInput v-model:value="form.group" placeholder="分组，可选" />
        </NGi>
        <NGi span="24 s:5">
          <NInput v-model:value="form.tags" placeholder="标签，逗号分隔" />
        </NGi>
        <NGi span="24 s:2">
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
      <div class="bulk-toolbar">
        <NSelect v-model:value="groupFilter" size="small" :options="groupOptions" class="toolbar-select" />
        <NButton size="small" secondary @click="batchQueue('probe')">批量探测</NButton>
        <NButton size="small" secondary @click="batchQueue('diagnostics')">批量诊断</NButton>
        <NButton size="small" secondary @click="batchAgentQueue('agent-update-check')">批量检查 Agent</NButton>
        <NButton size="small" type="primary" secondary @click="batchAgentQueue('agent-update')">批量更新 Agent</NButton>
        <NButton size="small" type="primary" secondary @click="batchQueue('sing-box-apply')">批量应用</NButton>
        <NButton size="small" secondary @click="resetSelectedTraffic">清零流量</NButton>
        <NPopconfirm @positive-click="batchDelete">
          <template #trigger>
            <NButton size="small" type="error" secondary>批量删除</NButton>
          </template>
          删除已选择的 {{ selectedNodeIds.length }} 个节点？
        </NPopconfirm>
        <NText depth="3">已选 {{ selectedNodeIds.length }} / {{ visibleNodes.length }}</NText>
      </div>
      <NDataTable
        v-model:checked-row-keys="selectedNodeIds"
        :columns="columns"
        :data="visibleNodes"
        :loading="loading"
        :bordered="false"
        :row-key="rowKey"
      />
    </NCard>

    <NGrid :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <NGi span="24 l:9">
        <NCard title="流量排行" :bordered="false" class="card-wrapper compact-card">
          <template #header-extra>
            <NSpace :size="8" align="center">
              <NSelect v-model:value="rankMode" size="small" :options="trafficLimitModeOptions()" class="rank-mode" @update:value="loadTrafficAnalytics" />
              <NButton size="small" secondary @click="refreshTrafficAnalytics">刷新</NButton>
            </NSpace>
          </template>
          <div class="rank-list">
            <div v-for="(item, index) in trafficRank" :key="item.nodeId" class="rank-row">
              <span>{{ index + 1 }}</span>
              <strong>{{ item.name }}</strong>
              <em>{{ formatBytes(item.usageBytes) }}</em>
            </div>
          </div>
          <NEmpty v-if="!trafficRank.length" size="small" description="暂无流量排行" />
        </NCard>
      </NGi>
      <NGi span="24 l:15">
        <NCard title="历史流量" :bordered="false" class="card-wrapper compact-card">
          <template #header-extra>
            <NSpace :size="8" align="center">
              <NSelect
                v-model:value="historyNodeId"
                size="small"
                :options="historyNodeOptions"
                class="history-node-select"
                placeholder="选择节点"
                @update:value="loadTrafficAnalytics"
              />
              <NButton size="small" secondary @click="refreshTrafficAnalytics">刷新</NButton>
            </NSpace>
          </template>
          <div class="history-chart">
            <svg viewBox="0 0 360 72" preserveAspectRatio="none" aria-hidden="true">
              <line x1="0" y1="71.5" x2="360" y2="71.5" class="axis-line" />
              <polyline v-if="persistedTrafficPath('rx')" :points="persistedTrafficPath('rx')" class="traffic-line rx-line" />
              <polyline v-if="persistedTrafficPath('tx')" :points="persistedTrafficPath('tx')" class="traffic-line tx-line" />
            </svg>
            <div v-if="persistedTrafficHistory.length < 2" class="traffic-empty">等待历史样本</div>
          </div>
          <div class="history-meta">
            <span>样本 {{ persistedTrafficHistory.length }}</span>
            <span>峰值 {{ formatRate(persistedTrafficPeak()) }}</span>
          </div>
        </NCard>
      </NGi>
    </NGrid>

    <NGrid :x-gap="10" :y-gap="10" responsive="screen" item-responsive>
      <NGi v-for="node in visibleNodes" :key="node.id" span="24 s:12 l:8 xl:6">
        <NCard :bordered="false" class="card-wrapper node-card">
          <div class="node-head">
            <div class="node-title-block">
              <div class="node-title-row">
                <span class="region-badge-text">{{ regionBadgeLabel(node) }}</span>
                <div class="node-title">{{ node.name }}</div>
              </div>
              <div class="node-subtitle">{{ ipModeLabel(node.network?.ipMode) }}</div>
            </div>
            <NTag :type="node.online ? 'success' : 'warning'" size="small" round>{{ node.online ? '在线' : node.agentStatus }}</NTag>
          </div>

          <div class="node-quickline">
            <span>协议 {{ node.protocols?.length || 0 }}</span>
            <span>上报 {{ formatBeijingTime(node.lastSeenAt) }}</span>
          </div>

          <div class="ip-strip">
            <div
              v-for="item in nodeIpRows(node).filter(row => row.value !== '-')"
              :key="item.label"
              class="ip-pill"
              :class="`ip-pill-${item.tone}`"
              @click="copyIpValue(item.value)"
            >
              <span>{{ item.label }}</span>
              <strong :title="item.value">{{ item.value }}</strong>
            </div>
          </div>

          <div class="metric-grid">
            <div class="metric-item">
              <span>CPU / 内存</span>
              <strong>
                {{ node.metrics?.cpu?.usagePercent == null ? '-' : `${node.metrics.cpu.usagePercent}%` }}
                /
                {{ node.metrics?.memory?.usagePercent == null ? '-' : `${node.metrics.memory.usagePercent}%` }}
              </strong>
            </div>
            <div class="metric-item">
              <span>当前速率</span>
              <strong>↓ {{ formatRate(node.traffic?.rxRateBytesPerSecond) }} · ↑ {{ formatRate(node.traffic?.txRateBytesPerSecond) }}</strong>
            </div>
            <div class="metric-item">
              <span>累计流量</span>
              <strong>↓ {{ formatBytes(node.traffic?.totalRxBytes) }} · ↑ {{ formatBytes(node.traffic?.totalTxBytes) }}</strong>
            </div>
            <div class="metric-item">
              <span>Agent</span>
              <strong>{{ agentVersionLabel(node) }} · {{ agentUpdateLabel(node) }}</strong>
            </div>
          </div>

          <div class="traffic-limit compact-limit">
            <div class="traffic-limit-bar">
              <span :style="{ width: `${trafficUsagePercent(node)}%` }" />
            </div>
            <span>{{ trafficUsageLabel(node) }} · {{ node.subscriptionEnabled ? '订阅启用' : '订阅停用' }}</span>
          </div>

          <div class="node-actions">
            <NButton size="small" @click="openInstallDrawer(node)">安装</NButton>
            <NPopover trigger="click" placement="top-start">
              <template #trigger>
                <NButton size="small" secondary>协议</NButton>
              </template>
              <NSpace vertical :size="8" class="protocol-popover">
                <div class="section-head">
                  <NText strong>协议</NText>
                  <NText depth="3">sing-box {{ node.singBox?.installed ? '已安装' : '未安装' }}</NText>
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
                        <NButton size="tiny" secondary type="error">删除</NButton>
                      </template>
                      删除 {{ protocol.name }} :{{ protocol.port }} 并推送远程配置？
                    </NPopconfirm>
                  </div>
                </div>
                <NEmpty v-else size="small" description="暂无协议" />
                <NDivider class="my-4px" />
                <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive>
                  <NGi span="24 s:10">
                    <NSelect
                      v-model:value="draftFor(node).type"
                      size="small"
                      :options="protocolOptions()"
                      @update:value="syncDraftPort(node)"
                    />
                  </NGi>
                  <NGi span="12 s:6">
                    <NInputNumber v-model:value="draftFor(node).port" size="small" :min="1" :max="65535" placeholder="端口" class="w-full" />
                  </NGi>
                  <NGi span="12 s:8">
                    <NInput v-model:value="draftFor(node).listen" size="small" placeholder="监听" />
                  </NGi>
                  <NGi span="24">
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
                <NButton size="small" type="primary" block @click="addProtocol(node)">添加并推送</NButton>
              </NSpace>
            </NPopover>
            <NPopover trigger="click" placement="top">
              <template #trigger>
                <NButton size="small" secondary>设置</NButton>
              </template>
              <NSpace vertical :size="8" class="settings-popover">
                <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive>
                  <NGi span="12">
                    <NInput v-model:value="node.region" size="small" placeholder="区域，如 HK" />
                  </NGi>
                  <NGi span="12">
                    <NInput v-model:value="node.group" size="small" placeholder="分组" />
                  </NGi>
                </NGrid>
                <NGrid :x-gap="8" :y-gap="8" responsive="screen" item-responsive>
                  <NGi span="12">
                    <NInputNumber
                      v-model:value="trafficDraftFor(node).thresholdGb"
                      size="small"
                      :min="0"
                      :precision="2"
                      placeholder="阈值 GB"
                      class="w-full"
                    />
                  </NGi>
                  <NGi span="12">
                    <NSelect v-model:value="trafficDraftFor(node).limitMode" size="small" :options="trafficLimitModeOptions()" />
                  </NGi>
                  <NGi span="12">
                    <NInputNumber
                      v-model:value="trafficDraftFor(node).warningPercent"
                      size="small"
                      :min="1"
                      :max="100"
                      placeholder="预警 %"
                      class="w-full"
                    />
                  </NGi>
                  <NGi span="12">
                    <NSelect v-model:value="trafficDraftFor(node).resetMode" size="small" :options="resetModeOptions()" />
                  </NGi>
                  <NGi v-if="trafficDraftFor(node).resetMode === 'monthly'" span="12">
                    <NInputNumber v-model:value="trafficDraftFor(node).resetDay" size="small" :min="1" :max="31" placeholder="日期" class="w-full" />
                  </NGi>
                  <NGi v-if="trafficDraftFor(node).resetMode === 'interval'" span="12">
                    <NInputNumber
                      v-model:value="trafficDraftFor(node).resetIntervalDays"
                      size="small"
                      :min="1"
                      :max="365"
                      placeholder="天数"
                      class="w-full"
                    />
                  </NGi>
                  <NGi span="12">
                    <NCheckbox v-model:checked="trafficDraftFor(node).autoDisableSubscription">超限停订阅</NCheckbox>
                  </NGi>
                  <NGi span="12">
                    <NCheckbox v-model:checked="trafficDraftFor(node).subscriptionEnabled">订阅启用</NCheckbox>
                  </NGi>
                </NGrid>
                <NSpace :size="8">
                  <NButton size="small" type="primary" @click="saveRegion(node)">保存区域</NButton>
                  <NButton size="small" type="primary" @click="saveTrafficPolicy(node)">保存</NButton>
                  <NPopconfirm @positive-click="resetNodeTraffic(node)">
                    <template #trigger>
                      <NButton size="small" secondary>清零</NButton>
                    </template>
                    清零 {{ node.name }} 当前流量统计？
                  </NPopconfirm>
                </NSpace>
              </NSpace>
            </NPopover>
            <NDropdown :options="nodeMoreActionOptions(node)" trigger="click" @select="key => handleNodeAction(node, String(key))">
              <template #trigger>
                <NButton size="small">更多</NButton>
              </template>
            </NDropdown>
            <NPopconfirm @positive-click="removeNode(node)">
              <template #trigger>
                <NButton size="small" type="error" secondary>删除</NButton>
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

    <NModal v-model:show="protocolResultVisible" preset="card" class="protocol-result-modal" :title="`${protocolResultNode?.name || '节点'} 订阅信息`">
      <NSpace vertical :size="12">
        <div class="result-note">
          协议已写入面板并下发到 Agent。Agent 应用完成后，上报链接会自动刷新；下面是面板按当前协议生成的可导入链接。
        </div>
        <div>
          <div class="result-section-title">节点链接</div>
          <NInput
            :value="protocolResultLinks.join('\n')"
            readonly
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 7 }"
            placeholder="等待节点地址或协议信息"
          />
        </div>
        <div>
          <div class="result-section-title">订阅 URL</div>
          <div class="subscription-url-list">
            <div v-for="item in protocolResultSubscriptions" :key="item.id" class="subscription-url-row">
              <span>{{ item.name }} · {{ item.format }}</span>
              <strong :title="item.publicUrl">{{ item.publicUrl }}</strong>
            </div>
          </div>
        </div>
        <NSpace>
          <NButton type="primary" @click="copyProtocolResultLinks">复制节点链接</NButton>
          <NButton secondary @click="copyProtocolResultSubscriptions">复制订阅 URL</NButton>
        </NSpace>
      </NSpace>
    </NModal>
  </NSpace>
</template>

<style scoped>
.table-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.region-cell,
.agent-version-cell,
.node-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.region-badge-text {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  min-width: 54px;
  color: var(--n-text-color, #1f2937);
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
  white-space: nowrap;
}

.region-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 22px;
  border: 1px solid rgba(37, 99, 235, 0.18);
  border-radius: 6px;
  background: rgba(37, 99, 235, 0.08);
  color: #1d4ed8;
  font-size: 15px;
  font-weight: 750;
  line-height: 1;
}

.region-name,
.agent-version-cell strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-version-cell {
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.bulk-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.toolbar-select {
  width: 150px;
}

.compact-card :deep(.n-card__content) {
  padding-top: 10px;
}

.rank-mode {
  width: 96px;
}

.history-node-select {
  width: min(220px, 46vw);
}

.rank-list {
  display: grid;
  gap: 7px;
}

.rank-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 5px 7px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.06);
}

.rank-row span {
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
}

.rank-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-row em {
  color: #2563eb;
  font-size: 12px;
  font-style: normal;
  font-weight: 650;
  white-space: nowrap;
}

.history-chart {
  position: relative;
  height: 84px;
  overflow: hidden;
}

.history-chart svg {
  display: block;
  width: 100%;
  height: 72px;
}

.history-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 16px;
}

.node-card :deep(.n-card__content) {
  padding: 10px;
}

.node-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.node-title-block {
  min-width: 0;
}

.node-title {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 13px;
  font-weight: 700;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-subtitle {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-quickline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 6px;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 10px;
  line-height: 15px;
}

.node-quickline span {
  white-space: nowrap;
}

.ip-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 5px;
  margin-top: 7px;
}

.ip-pill {
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.07);
  cursor: pointer;
}

.ip-pill span {
  display: block;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 10px;
  font-weight: 650;
  line-height: 14px;
}

.ip-pill strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 10px;
  font-weight: 650;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ip-pill-warp {
  border-color: rgba(14, 165, 233, 0.26);
  background: rgba(14, 165, 233, 0.08);
}

.ip-pill-ipv4 {
  border-color: rgba(37, 99, 235, 0.24);
  background: rgba(37, 99, 235, 0.07);
}

.ip-pill-ipv6 {
  border-color: rgba(5, 150, 105, 0.24);
  background: rgba(5, 150, 105, 0.07);
}

.ip-pill-muted {
  opacity: 0.72;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin-top: 7px;
}

.metric-item {
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.07);
}

.metric-item span {
  display: block;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 10px;
  line-height: 14px;
}

.metric-item strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color, #1f2937);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traffic-limit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.traffic-limit span:last-child {
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  line-height: 16px;
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
  margin-top: 7px;
}

.compact-limit {
  min-height: 20px;
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
  margin-bottom: 6px;
}

.protocol-list {
  display: grid;
  gap: 6px;
}

.protocol-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 7px;
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
  font-size: 12px;
  font-weight: 650;
  line-height: 18px;
}

.protocol-name span {
  min-width: 0;
  overflow: hidden;
  color: var(--n-text-color-disabled, #64748b);
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.protocol-badges {
  margin-top: 4px;
}

.node-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.node-actions :deep(.n-button) {
  min-width: 0;
}

.protocol-popover {
  width: min(420px, calc(100vw - 48px));
}

.settings-popover {
  width: min(380px, calc(100vw - 48px));
}

:global(.protocol-result-modal) {
  width: min(720px, calc(100vw - 32px));
}

.result-section-title {
  margin-bottom: 6px;
  color: var(--n-text-color, #1f2937);
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
}

.result-note {
  padding: 8px 10px;
  border: 1px solid rgba(5, 150, 105, 0.18);
  border-radius: 6px;
  background: rgba(5, 150, 105, 0.08);
  color: #047857;
  font-size: 12px;
  line-height: 18px;
}

.subscription-url-list {
  display: grid;
  gap: 6px;
}

.subscription-url-row {
  display: grid;
  grid-template-columns: minmax(96px, 140px) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.07);
}

.subscription-url-row span,
.subscription-url-row strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subscription-url-row span {
  color: var(--n-text-color-disabled, #64748b);
  font-weight: 650;
}

.subscription-url-row strong {
  color: var(--n-text-color, #1f2937);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-weight: 600;
}

@media (max-width: 640px) {
  .toolbar-select,
  .history-node-select {
    width: 100%;
  }

  .ip-strip {
    grid-template-columns: minmax(0, 1fr);
  }

  .metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .protocol-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .traffic-limit {
    align-items: flex-start;
    flex-direction: column;
  }

  .subscription-url-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
