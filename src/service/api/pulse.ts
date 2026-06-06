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
  installCommand: string;
  online: boolean;
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

export function fetchPulseDashboard() {
  return pulseFetch<PulseDashboard>('/dashboard');
}

export function fetchPulseNodes() {
  return pulseFetch<{ items: PulseNode[] }>('/nodes');
}

export function createPulseNode(body: { name: string; region?: string; tags?: string[] }) {
  return pulseFetch<PulseNode>('/nodes', { method: 'POST', body });
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
