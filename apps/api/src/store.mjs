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
    }
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
    region: node.region || '',
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

  return hydrated;
}

export function createNode(input = {}) {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    name: String(input.name || '新节点').trim() || '新节点',
    region: String(input.region || '').trim(),
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
