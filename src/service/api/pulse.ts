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

export interface PulseNode {
  id: string;
  name: string;
  region: string;
  displayRegion: string;
  regionOverride: boolean;
  tags: string[];
  installId: string;
  status: string;
  agentStatus: string;
  subscriptionEnabled: boolean;
  lastSeenAt: string | null;
  addresses: Array<{ interface: string; family: string; address: string; cidr?: string }>;
  metrics: null | {
    cpu?: { usagePercent?: number | null; cores?: number | null; load?: { one?: number | null } };
    memory?: { usagePercent?: number | null; totalBytes?: number | null; availableBytes?: number | null };
    network?: { interfaces?: Array<{ name: string; rxBytes: number; txBytes: number }> };
  };
  diagnostics: null | { checks?: Array<{ name: string; ok: boolean; detail?: string }> };
  reportedLinks: string[];
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
    ipMode: string;
    publicAddresses: Array<{ interface: string; family: string; address: string; cidr?: string }>;
    warpLikely: boolean;
    detectedRegion: string;
    regionSource: string;
    updatedAt: string | null;
  };
  traffic: {
    totalRxBytes: number;
    totalTxBytes: number;
    totalBytes: number;
    thresholdBytes: number;
    warningPercent: number;
    autoDisableSubscription: boolean;
    thresholdExceededAt: string | null;
    updatedAt: string | null;
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

export interface PulseProfile {
  id: string;
  name: string;
  format: 'raw' | 'clash' | 'v2ray';
  enabled: boolean;
  protected: boolean;
  deletable: boolean;
  description: string;
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
}

export function fetchPulseDashboard() {
  return pulseFetch<PulseDashboard>('/dashboard');
}

export function fetchPulseNodes() {
  return pulseFetch<{ items: PulseNode[] }>('/nodes');
}

export function fetchPulseProtocols() {
  return pulseFetch<{ items: PulseProtocolMeta[] }>('/protocols');
}

export function createPulseNode(body: { name: string; region?: string; tags?: string[] }) {
  return pulseFetch<PulseNode>('/nodes', { method: 'POST', body });
}

export function updatePulseNode(id: string, body: Partial<Pick<PulseNode, 'name' | 'region' | 'tags' | 'subscriptionEnabled'>> & { traffic?: Partial<PulseNode['traffic']> }) {
  return pulseFetch<PulseNode>(`/nodes/${id}`, { method: 'PATCH', body });
}

export function deletePulseNode(id: string) {
  return pulseFetch<{ deleted: boolean; removedAgents: number; removedCommands: number }>(`/nodes/${id}`, { method: 'DELETE' });
}

export function resetPulseNodeLinks(id: string) {
  return pulseFetch<PulseCommand>(`/nodes/${id}/links/reset`, { method: 'POST' });
}

export function createPulseNodeProtocol(nodeId: string, body: { type: string; port?: number | null; variant?: string; name?: string }) {
  return pulseFetch<{ protocol: PulseNodeProtocol; command: PulseCommand }>(`/nodes/${nodeId}/protocols`, { method: 'POST', body });
}

export function deletePulseNodeProtocol(nodeId: string, protocolId: string) {
  return pulseFetch<{ deleted: boolean; protocol: PulseNodeProtocol; command: PulseCommand }>(`/nodes/${nodeId}/protocols/${protocolId}`, { method: 'DELETE' });
}

export function queuePulseCommand(nodeId: string, type: string, payload: Record<string, unknown> = {}) {
  return pulseFetch<PulseCommand>(`/nodes/${nodeId}/commands`, { method: 'POST', body: { type, payload } });
}

export function fetchPulseCommands() {
  return pulseFetch<{ items: PulseCommand[] }>('/commands');
}

export function fetchPulseProfiles() {
  return pulseFetch<{ items: PulseProfile[] }>('/subscription-profiles');
}

export function createPulseProfile(body: { name: string; format: PulseProfile['format']; description?: string }) {
  return pulseFetch<PulseProfile>('/subscription-profiles', { method: 'POST', body });
}

export function updatePulseProfile(id: string, body: Partial<Pick<PulseProfile, 'name' | 'format' | 'enabled' | 'description'>>) {
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
