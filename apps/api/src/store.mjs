import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_DATA_FILE = path.join(process.cwd(), '.data', 'pulsedeck.json');

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export const DEFAULT_SUBSCRIPTION_PROFILES = [
  {
    id: 'default-raw',
    name: '默认 Raw',
    format: 'raw',
    enabled: true,
    protected: true,
    description: '通用原始链接订阅'
  },
  {
    id: 'default-clash',
    name: '默认 Clash',
    format: 'clash',
    enabled: true,
    protected: true,
    description: 'Clash provider 输出'
  },
  {
    id: 'default-v2ray',
    name: '默认 V2Ray',
    format: 'v2ray',
    enabled: true,
    protected: true,
    description: 'Base64 链接订阅'
  }
];

export const SUPPORTED_PROXY_PROTOCOLS = [
  { type: 'vmess', name: 'VMess', defaultPort: 10001, variants: ['tcp', 'ws', 'grpc'] },
  { type: 'vless', name: 'VLESS', defaultPort: 443, variants: ['reality', 'tls', 'ws', 'grpc'] },
  { type: 'trojan', name: 'Trojan', defaultPort: 443, variants: ['tls', 'ws', 'grpc'] },
  { type: 'shadowsocks', name: 'Shadowsocks', defaultPort: 8388, variants: ['2022-blake3-aes-128-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305'] },
  { type: 'hysteria2', name: 'Hysteria2', defaultPort: 443, variants: ['udp', 'obfs'] },
  { type: 'tuic', name: 'Tuic', defaultPort: 443, variants: ['v5', 'congestion-bbr'] },
  { type: 'anytls', name: 'AnyTLS', defaultPort: 443, variants: ['tls', 'reality', 'ech'] }
];

const PROTOCOL_TYPE_SET = new Set(SUPPORTED_PROXY_PROTOCOLS.map((protocol) => protocol.type));

export function normalizeProtocolType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  return PROTOCOL_TYPE_SET.has(normalized) ? normalized : 'vless';
}

export function defaultProtocolPort(type) {
  return SUPPORTED_PROXY_PROTOCOLS.find((protocol) => protocol.type === normalizeProtocolType(type))?.defaultPort || 443;
}

function normalizePort(value, fallback = 443) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return fallback;
  return number;
}

function normalizeTraffic(input = {}) {
  return {
    totalRxBytes: Number(input.totalRxBytes) || 0,
    totalTxBytes: Number(input.totalTxBytes) || 0,
    totalBytes: Number(input.totalBytes) || 0,
    lastRxBytes: Number(input.lastRxBytes) || 0,
    lastTxBytes: Number(input.lastTxBytes) || 0,
    thresholdBytes: Number(input.thresholdBytes) || 0,
    warningPercent: Number(input.warningPercent) || 80,
    autoDisableSubscription: input.autoDisableSubscription === true,
    thresholdExceededAt: input.thresholdExceededAt || null,
    updatedAt: input.updatedAt || null
  };
}

function normalizeNetwork(input = {}) {
  return {
    primaryIpv4: input.primaryIpv4 || null,
    primaryIpv6: input.primaryIpv6 || null,
    ipMode: input.ipMode || 'unknown',
    publicAddresses: Array.isArray(input.publicAddresses) ? input.publicAddresses : [],
    warpLikely: input.warpLikely === true,
    detectedRegion: input.detectedRegion || '',
    regionSource: input.regionSource || 'auto-pending',
    updatedAt: input.updatedAt || null
  };
}

function normalizeAlertPolicy(input = {}) {
  return {
    offlineAfterSeconds: Number(input.offlineAfterSeconds) || 180,
    offlineChannels: Array.isArray(input.offlineChannels) ? input.offlineChannels : ['telegram', 'email'],
    trafficChannels: Array.isArray(input.trafficChannels) ? input.trafficChannels : ['telegram', 'email'],
    autoDisableOnTrafficLimit: input.autoDisableOnTrafficLimit === true
  };
}

export function createNodeProtocol(input = {}) {
  const timestamp = nowIso();
  const type = normalizeProtocolType(input.type);
  const port = normalizePort(input.port, defaultProtocolPort(type));
  return {
    id: input.id || randomUUID(),
    type,
    name: String(input.name || SUPPORTED_PROXY_PROTOCOLS.find((protocol) => protocol.type === type)?.name || type).trim(),
    port,
    listen: String(input.listen || '0.0.0.0').trim() || '0.0.0.0',
    enabled: input.enabled !== false,
    variant: String(input.variant || '').trim(),
    transport: String(input.transport || '').trim(),
    security: String(input.security || '').trim(),
    settings: input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {},
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp
  };
}

export function createEmptyData() {
  const timestamp = nowIso();
  return {
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    sessions: [],
    nodes: [],
    agents: [],
    commands: [],
    alertEvents: [],
    subscriptionProfiles: DEFAULT_SUBSCRIPTION_PROFILES.map((profile) => ({
      ...profile,
      token: randomToken(18),
      createdAt: timestamp,
      updatedAt: timestamp
    })),
    notificationChannels: {
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        parseMode: 'HTML',
        lastTestAt: null
      },
      email: {
        enabled: false,
        smtpHost: '',
        smtpPort: 587,
        username: '',
        password: '',
        from: '',
        to: '',
        lastTestAt: null
      }
    },
    alertPolicy: {
      offlineAfterSeconds: 180,
      offlineChannels: ['telegram', 'email'],
      trafficChannels: ['telegram', 'email'],
      autoDisableOnTrafficLimit: true
    }
  };
}

export function hydrateData(input) {
  const data = input && typeof input === 'object' ? input : {};
  const now = nowIso();
  const hydrated = {
    version: 1,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    agents: Array.isArray(data.agents) ? data.agents : [],
    commands: Array.isArray(data.commands) ? data.commands : [],
    alertEvents: Array.isArray(data.alertEvents) ? data.alertEvents : [],
    subscriptionProfiles: Array.isArray(data.subscriptionProfiles) ? data.subscriptionProfiles : [],
    notificationChannels: {
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        parseMode: 'HTML',
        lastTestAt: null,
        ...(data.notificationChannels?.telegram || {})
      },
      email: {
        enabled: false,
        smtpHost: '',
        smtpPort: 587,
        username: '',
        password: '',
        from: '',
        to: '',
        lastTestAt: null,
        ...(data.notificationChannels?.email || {})
      }
    },
    alertPolicy: normalizeAlertPolicy(data.alertPolicy)
  };

  for (const defaultProfile of DEFAULT_SUBSCRIPTION_PROFILES) {
    const existing = hydrated.subscriptionProfiles.find((profile) => profile.id === defaultProfile.id);
    if (existing) {
      Object.assign(existing, {
        ...defaultProfile,
        ...existing,
        protected: true,
        token: existing.token || randomToken(18),
        createdAt: existing.createdAt || now,
        updatedAt: existing.updatedAt || now
      });
    } else {
      hydrated.subscriptionProfiles.push({
        ...defaultProfile,
        token: randomToken(18),
        createdAt: now,
        updatedAt: now
      });
    }
  }

  hydrated.nodes = hydrated.nodes.map((node) => ({
    id: node.id || randomUUID(),
    name: node.name || '未命名节点',
    region: node.region || node.network?.detectedRegion || '',
    regionOverride: node.regionOverride === true || node.network?.regionSource === 'manual',
    tags: Array.isArray(node.tags) ? node.tags : [],
    installId: node.installId || randomToken(24),
    status: node.status || 'pending',
    agentStatus: node.agentStatus || 'not-installed',
    subscriptionEnabled: node.subscriptionEnabled !== false,
    lastSeenAt: node.lastSeenAt || null,
    addresses: Array.isArray(node.addresses) ? node.addresses : [],
    metrics: node.metrics || null,
    diagnostics: node.diagnostics || null,
    reportedLinks: Array.isArray(node.reportedLinks) ? node.reportedLinks : [],
    linkSecret: node.linkSecret || randomToken(18),
    protocols: Array.isArray(node.protocols) ? node.protocols.map(createNodeProtocol) : [],
    network: normalizeNetwork(node.network),
    traffic: normalizeTraffic(node.traffic),
    alertPolicy: normalizeAlertPolicy(node.alertPolicy),
    createdAt: node.createdAt || now,
    updatedAt: node.updatedAt || now
  }));

  hydrated.agents = hydrated.agents.map((agent) => ({
    id: agent.id || randomUUID(),
    nodeId: agent.nodeId || '',
    token: agent.token || randomToken(24),
    version: agent.version || 'unknown',
    platform: agent.platform || 'unknown',
    arch: agent.arch || 'unknown',
    installDir: agent.installDir || '',
    serviceMode: agent.serviceMode || 'unknown',
    lastSeenAt: agent.lastSeenAt || null,
    createdAt: agent.createdAt || now,
    updatedAt: agent.updatedAt || now
  }));

  hydrated.commands = hydrated.commands.map((command) => ({
    id: command.id || randomUUID(),
    nodeId: command.nodeId || '',
    agentId: command.agentId || null,
    type: command.type || 'noop',
    payload: command.payload || {},
    status: command.status || 'queued',
    result: command.result || null,
    createdAt: command.createdAt || now,
    updatedAt: command.updatedAt || now
  }));

  hydrated.alertEvents = hydrated.alertEvents.map((event) => ({
    id: event.id || randomUUID(),
    nodeId: event.nodeId || '',
    type: event.type || 'info',
    level: event.level || 'info',
    message: event.message || '',
    channels: Array.isArray(event.channels) ? event.channels : [],
    status: event.status || 'pending',
    createdAt: event.createdAt || now,
    updatedAt: event.updatedAt || now
  }));

  return hydrated;
}

export function createNode(input = {}) {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    name: String(input.name || '新节点').trim() || '新节点',
    region: String(input.region || '').trim(),
    regionOverride: Boolean(String(input.region || '').trim()),
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
    installId: randomToken(24),
    status: 'pending',
    agentStatus: 'not-installed',
    subscriptionEnabled: input.subscriptionEnabled !== false,
    lastSeenAt: null,
    addresses: [],
    metrics: null,
    diagnostics: null,
    reportedLinks: [],
    linkSecret: randomToken(18),
    protocols: Array.isArray(input.protocols) ? input.protocols.map(createNodeProtocol) : [],
    network: normalizeNetwork({ regionSource: String(input.region || '').trim() ? 'manual' : 'auto-pending' }),
    traffic: normalizeTraffic(input.traffic),
    alertPolicy: normalizeAlertPolicy(input.alertPolicy),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export class JsonStore {
  constructor(file = process.env.PULSEDECK_DATA_FILE || DEFAULT_DATA_FILE) {
    this.file = file;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.file, 'utf8');
      this.data = hydrateData(JSON.parse(content));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = createEmptyData();
      await this.save();
    }
    return this.data;
  }

  async save() {
    if (!this.data) throw new Error('store not loaded');
    this.data.updatedAt = nowIso();
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpFile, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmpFile, this.file);
  }

  async update(mutator) {
    const run = async () => {
      if (!this.data) await this.load();
      const result = await mutator(this.data);
      await this.save();
      return result ?? this.data;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
