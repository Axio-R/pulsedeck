import { localStg } from '@/utils/storage';

const API_BASE = import.meta.env.VITE_SERVICE_BASE_URL || '/api/v1';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function pulseFetch<T>(path: string, options: { method?: HttpMethod; body?: unknown } = {}): Promise<T> {
  const token = localStg.get('token');
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const detail = typeof body === 'object' && body && 'detail' in body ? String(body.detail) : String(body);
    throw new Error(detail || `HTTP ${res.status}`);
  }

  return body as T;
}

export interface PulseHealth {
  status: string;
  name: string;
  version: string;
  agentVersion: string;
  port: number;
  time: string;
}

export interface PulseAgentRuntimeTarget {
  target: string;
  version: string;
  appVersion: string;
  available: boolean;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  updatedAt: string | null;
}

export interface PulseAgentRuntimeManifest {
  appVersion: string;
  agentVersion: string;
  generatedAt: string;
  targets: PulseAgentRuntimeTarget[];
}

export interface PulseNode {
  id: string;
  name: string;
  region: string;
  displayRegion: string;
  regionCode: string;
  regionIcon: string;
  regionOverride: boolean;
  group: string;
  order: number;
  tags: string[];
  installId: string;
  status: string;
  agentStatus: string;
  subscriptionEnabled: boolean;
  lastSeenAt: string | null;
  addresses: Array<{ interface: string; family: string; address: string; cidr?: string; region?: string; countryCode?: string; city?: string; source?: string }>;
  metrics: null | {
    cpu?: { usagePercent?: number | null; cores?: number | null; load?: { one?: number | null } };
    memory?: { usagePercent?: number | null; totalBytes?: number | null; availableBytes?: number | null };
    network?: { interfaces?: Array<{ name: string; rxBytes: number; txBytes: number }> };
  };
  diagnostics: null | { checks?: Array<{ name: string; ok: boolean; detail?: string }> };
  reportedLinks: string[];
  agentUpdate: null | {
    currentVersion: string;
    latestVersion: string;
    target: string;
    available: boolean;
    updateAvailable: boolean;
    status: string;
    message: string;
    checkedAt: string | null;
    updatedAt: string | null;
  };
  agent: {
    id: string | null;
    version: string;
    platform: string;
    arch: string;
    target: string;
    installDir: string;
    serviceMode: string;
    lastSeenAt: string | null;
    latestVersion: string;
    runtimeAvailable: boolean;
    updateAvailable: boolean;
    remoteUpdateSupported: boolean;
    update: {
      currentVersion?: string;
      latestVersion?: string;
      target?: string;
      available?: boolean;
      updateAvailable?: boolean;
      status?: string;
      message?: string;
      checkedAt?: string | null;
      updatedAt?: string | null;
    };
  };
  linkSecret: string;
  protocols: PulseNodeProtocol[];
  singBox: {
    installed: boolean;
    version: string;
    binaryPath: string;
    configPath: string;
    workDir: string;
    serviceMode: string;
    status: string;
    message: string;
    lastRenderAt: string | null;
    lastApplyAt: string | null;
    lastRestartAt: string | null;
    updatedAt: string | null;
  };
  network: {
    primaryIpv4: string | null;
    primaryIpv6: string | null;
    warpIpv4: string | null;
    warpIpv6: string | null;
    ipMode: string;
    publicAddresses: Array<{ interface: string; family: string; address: string; cidr?: string; region?: string; countryCode?: string; city?: string; source?: string }>;
    warpLikely: boolean;
    detectedRegion: string;
    regionSource: string;
    updatedAt: string | null;
  };
  traffic: {
    totalRxBytes: number;
    totalTxBytes: number;
    totalBytes: number;
    lastDeltaRxBytes: number;
    lastDeltaTxBytes: number;
    rxRateBytesPerSecond: number;
    txRateBytesPerSecond: number;
    thresholdBytes: number;
    limitMode: 'total' | 'download' | 'upload';
    warningPercent: number;
    autoDisableSubscription: boolean;
    thresholdExceededAt: string | null;
    resetMode: 'none' | 'daily' | 'weekly' | 'monthly' | 'interval';
    resetDay: number;
    resetIntervalDays: number;
    resetAnchorAt: string | null;
    lastResetAt: string | null;
    updatedAt: string | null;
  };
  alertState: {
    offlineSince: string | null;
    offlineAlertedAt: string | null;
    recoveredAt: string | null;
    trafficThresholdAlertedAt: string | null;
    trafficWarningAlertedAt: string | null;
  };
  installCommand: string;
  online: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PulseProtocolMeta {
  type: string;
  name: string;
  defaultPort: number;
  variants: string[];
}

export interface PulseNodeProtocol {
  id: string;
  type: string;
  name: string;
  port: number;
  listen: string;
  enabled: boolean;
  variant: string;
  transport: string;
  security: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PulseDashboard {
  counts: {
    nodes: number;
    onlineNodes: number;
    warningNodes: number;
    agents: number;
    queuedCommands: number;
    enabledSubscriptions: number;
  };
  averages: {
    cpuUsagePercent: number | null;
    memoryUsagePercent: number | null;
  };
  traffic: {
    totalRxBytes: number;
    totalTxBytes: number;
    totalBytes: number;
    rxRateBytesPerSecond: number;
    txRateBytesPerSecond: number;
  };
  recentNodes: PulseNode[];
  recentCommands: PulseCommand[];
}

export interface PulseCommand {
  id: string;
  nodeId: string;
  agentId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PulseCommandEvent {
  id: string;
  commandId: string;
  nodeId: string;
  agentId: string | null;
  type: string;
  stream: string;
  message: string;
  payload: Record<string, unknown>;
  sequence: number;
  createdAt: string;
}

export interface PulseTrafficNode {
  id: string;
  name: string;
  status: string;
  agentStatus: string;
  online: boolean;
  lastSeenAt: string | null;
  region: string;
  displayRegion: string;
  subscriptionEnabled: boolean;
  metrics: PulseNode['metrics'];
  traffic: PulseNode['traffic'];
  network: PulseNode['network'];
}

export interface PulseTrafficEvent {
  type: 'traffic.snapshot' | 'heartbeat';
  time: string;
  items?: PulseTrafficNode[];
}

export interface PulseTrafficHistoryItem {
  id: string;
  nodeId: string;
  rxBytes: number;
  txBytes: number;
  totalBytes: number;
  rxRateBytesPerSecond: number;
  txRateBytesPerSecond: number;
  totalRxBytes: number;
  totalTxBytes: number;
  cumulativeBytes: number;
  kind: string;
  createdAt: string;
}

export interface PulseTrafficRankItem {
  nodeId: string;
  name: string;
  group: string;
  region: string;
  online: boolean;
  totalRxBytes: number;
  totalTxBytes: number;
  totalBytes: number;
  usageBytes: number;
  limitMode: 'total' | 'download' | 'upload';
  updatedAt: string | null;
}

export interface PulseProfile {
  id: string;
  name: string;
  format: 'raw' | 'clash' | 'v2ray';
  enabled: boolean;
  protected: boolean;
  deletable: boolean;
  description: string;
  filters: {
    nodeIds: string[];
    groups: string[];
    regions: string[];
    tags: string[];
  };
  linkPrefixMode: 'none' | 'region';
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PulseChannels {
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    parseMode: string;
    lastTestAt?: string | null;
  };
  email: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    username: string;
    password: string;
    from: string;
    to: string;
    lastTestAt?: string | null;
  };
}

export interface PulseAlertPolicy {
  offlineAfterSeconds: number;
  offlineChannels: string[];
  trafficChannels: string[];
  autoDisableOnTrafficLimit: boolean;
  trafficLimitAction: 'keep-node' | 'disable-node-subscription' | 'disable-all-subscriptions';
}

export interface PulseAlertEvent {
  id: string;
  nodeId: string;
  type: string;
  level: string;
  message: string;
  channels: string[];
  deliveries: Array<{ channel: string; status: string; detail: string; updatedAt: string }>;
  actions: Array<{ type: string; status: string; detail: string; updatedAt: string; profileIds?: string[] }>;
  dedupeKey: string;
  status: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function fetchPulseDashboard() {
  return pulseFetch<PulseDashboard>('/dashboard');
}

export function fetchPulseHealth() {
  return pulseFetch<PulseHealth>('/health');
}

export function fetchPulseAgentRuntimeManifest() {
  return pulseFetch<PulseAgentRuntimeManifest>('/agents/runtime/manifest');
}

export function fetchPulseNodes() {
  return pulseFetch<{ items: PulseNode[] }>('/nodes');
}

export function fetchPulseProtocols() {
  return pulseFetch<{ items: PulseProtocolMeta[] }>('/protocols');
}

export function createPulseNode(body: { name: string; region?: string; group?: string; tags?: string[] }) {
  return pulseFetch<PulseNode>('/nodes', { method: 'POST', body });
}

export function updatePulseNode(
  id: string,
  body: Partial<Pick<PulseNode, 'name' | 'region' | 'group' | 'order' | 'tags' | 'subscriptionEnabled'>> & { traffic?: Partial<PulseNode['traffic']> }
) {
  return pulseFetch<PulseNode>(`/nodes/${id}`, { method: 'PATCH', body });
}

export function deletePulseNode(id: string) {
  return pulseFetch<{ deleted: boolean; removedNodes: number; removedAgents: number; removedCommands: number; removedAlertEvents: number; removedTrafficHistory: number }>(
    `/nodes/${id}`,
    { method: 'DELETE' }
  );
}

export function reorderPulseNodes(ids: string[]) {
  return pulseFetch<{ updated: boolean; items: PulseNode[] }>('/nodes/reorder', { method: 'POST', body: { ids } });
}

export function batchPulseNodeCommand(nodeIds: string[], type: string, payload: Record<string, unknown> = {}) {
  return pulseFetch<{ queued: number; items: PulseCommand[] }>('/nodes/batch-command', { method: 'POST', body: { nodeIds, type, payload } });
}

export function batchDeletePulseNodes(nodeIds: string[]) {
  return pulseFetch<{ deleted: boolean; removedNodes: number; removedAgents: number; removedCommands: number; removedAlertEvents: number; removedTrafficHistory: number }>(
    '/nodes/batch-delete',
    { method: 'POST', body: { nodeIds } }
  );
}

export function fetchPulseTrafficHistory(params: { nodeId?: string; since?: string; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (params.nodeId) search.set('nodeId', params.nodeId);
  if (params.since) search.set('since', params.since);
  if (params.limit) search.set('limit', String(params.limit));
  const query = search.toString();
  return pulseFetch<{ items: PulseTrafficHistoryItem[] }>(`/traffic/history${query ? `?${query}` : ''}`);
}

export function fetchPulseTrafficRank(mode: 'total' | 'download' | 'upload' = 'total', limit = 20) {
  return pulseFetch<{ mode: 'total' | 'download' | 'upload'; items: PulseTrafficRankItem[] }>(`/traffic/rank?mode=${mode}&limit=${limit}`);
}

export function resetPulseTraffic(nodeIds: string[] = []) {
  return pulseFetch<{ reset: number }>('/traffic/reset', { method: 'POST', body: { nodeIds } });
}

export function resetPulseNodeLinks(id: string) {
  return pulseFetch<PulseCommand>(`/nodes/${id}/links/reset`, { method: 'POST' });
}

export function createPulseNodeProtocol(
  nodeId: string,
  body: { type: string; port?: number | null; listen?: string; variant?: string; name?: string; settings?: Record<string, unknown> }
) {
  return pulseFetch<{ protocol: PulseNodeProtocol; command: PulseCommand }>(`/nodes/${nodeId}/protocols`, { method: 'POST', body });
}

export function deletePulseNodeProtocol(nodeId: string, protocolId: string) {
  return pulseFetch<{ deleted: boolean; protocol: PulseNodeProtocol; command: PulseCommand }>(`/nodes/${nodeId}/protocols/${protocolId}`, { method: 'DELETE' });
}

export function queuePulseCommand(nodeId: string, type: string, payload: Record<string, unknown> = {}) {
  return pulseFetch<PulseCommand>(`/nodes/${nodeId}/commands`, { method: 'POST', body: { type, payload } });
}

export function fetchPulseCommands(limit = 200, status = '') {
  const search = new URLSearchParams();
  if (limit) search.set('limit', String(limit));
  if (status) search.set('status', status);
  const query = search.toString();
  return pulseFetch<{ items: PulseCommand[] }>(`/commands${query ? `?${query}` : ''}`);
}

export function fetchPulseCommandEvents(commandId: string) {
  return pulseFetch<{ items: PulseCommandEvent[] }>(`/commands/${commandId}/events?format=json`);
}

export function openPulseCommandEventSource(commandId: string) {
  const token = localStg.get('token') || '';
  const separator = API_BASE.includes('?') ? '&' : '?';
  return new EventSource(`${API_BASE}/commands/${commandId}/events${separator}token=${encodeURIComponent(token)}`);
}

export function openPulseTrafficSocket() {
  const token = localStg.get('token') || '';
  const base = new URL(API_BASE, window.location.origin);
  const url = new URL(`${base.toString().replace(/\/$/, '')}/traffic/stream`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return new WebSocket(url);
}

export function fetchPulseProfiles() {
  return pulseFetch<{ items: PulseProfile[] }>('/subscription-profiles');
}

export function createPulseProfile(
  body: { name: string; format: PulseProfile['format']; description?: string } & Partial<Pick<PulseProfile, 'filters' | 'linkPrefixMode'>>
) {
  return pulseFetch<PulseProfile>('/subscription-profiles', { method: 'POST', body });
}

export function updatePulseProfile(
  id: string,
  body: Partial<Pick<PulseProfile, 'name' | 'format' | 'enabled' | 'description' | 'filters' | 'linkPrefixMode'>>
) {
  return pulseFetch<PulseProfile>(`/subscription-profiles/${id}`, { method: 'PATCH', body });
}

export function deletePulseProfile(id: string) {
  return pulseFetch<{ deleted: boolean }>(`/subscription-profiles/${id}`, { method: 'DELETE' });
}

export function fetchPulseChannels() {
  return pulseFetch<PulseChannels>('/notification-channels');
}

export function savePulseChannels(body: PulseChannels) {
  return pulseFetch<PulseChannels>('/notification-channels', { method: 'PATCH', body });
}

export function fetchPulseAlertPolicy() {
  return pulseFetch<PulseAlertPolicy>('/alert-policy');
}

export function savePulseAlertPolicy(body: PulseAlertPolicy) {
  return pulseFetch<PulseAlertPolicy>('/alert-policy', { method: 'PATCH', body });
}

export function fetchPulseAlertEvents(limit = 100) {
  return pulseFetch<{ items: PulseAlertEvent[] }>(`/alert-events?limit=${limit}`);
}

export function checkPulseAlerts() {
  return pulseFetch<{ checkedAt: string; offlineNodes: number; recoveredNodes: number; createdEvents: number; items: PulseAlertEvent[] }>('/alerts/check', {
    method: 'POST'
  });
}

export function ackPulseAlertEvent(id: string) {
  return pulseFetch<PulseAlertEvent>(`/alert-events/${id}/ack`, { method: 'POST' });
}

export function deletePulseAlertEvent(id: string) {
  return pulseFetch<{ deleted: boolean }>(`/alert-events/${id}`, { method: 'DELETE' });
}
