import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createNode, createNodeProtocol, JsonStore, nowIso, randomToken, SUPPORTED_PROXY_PROTOCOLS } from './store.mjs';
import { renderAgentInstallScript } from './install-script.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const WEB_DIST_DIR = path.join(ROOT_DIR, 'dist');
const WEB_INDEX_FILE = path.join(WEB_DIST_DIR, 'index.html');
const AGENT_RUNTIME_DIR = path.join(ROOT_DIR, 'agent-dist');
const DEFAULT_GEOIP_FILE = path.join(ROOT_DIR, 'geoip.json');
const DEFAULT_GEOSITE_FILE = path.join(ROOT_DIR, 'geosite.json');
const PORT = Number(process.env.PULSEDECK_PORT || 14770);
const HOST = process.env.PULSEDECK_HOST || '0.0.0.0';
const APP_VERSION = process.env.PULSEDECK_VERSION || '0.2.9';
const AGENT_VERSION = process.env.PULSEDECK_AGENT_VERSION || `${APP_VERSION}-rust`;
const AGENT_RUNTIME_TARGETS = ['linux-x64', 'linux-arm64', 'linux-armv7l'];
const ADMIN_USER = process.env.PULSEDECK_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.PULSEDECK_ADMIN_PASSWORD || 'change-me';
const TRAFFIC_HISTORY_LIMIT = Math.max(Number(process.env.PULSEDECK_TRAFFIC_HISTORY_LIMIT) || 20_000, 1000);

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store'
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendSoy(res, data, msg = 'ok') {
  sendJson(res, 200, {
    code: '0000',
    msg,
    data
  });
}

function sendText(res, status, body, headers = TEXT_HEADERS) {
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { detail: 'not found' });
}

function badRequest(res, detail) {
  sendJson(res, 400, { detail });
}

function forbidden(res, detail = 'forbidden') {
  sendJson(res, 403, { detail });
}

function conflict(res, detail) {
  sendJson(res, 409, { detail });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : '';
}

function publicBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function validAgentRuntimeTarget(target) {
  return /^[a-z0-9_-]+$/i.test(target) && AGENT_RUNTIME_TARGETS.includes(target);
}

function agentRuntimeFile(target) {
  return path.join(AGENT_RUNTIME_DIR, target, 'pulsedeck-agent');
}

function agentRuntimeMetadata(target, req) {
  const base = publicBaseUrl(req);
  const downloadUrl = `${base}/api/v1/agents/runtime/${encodeURIComponent(target)}`;
  const metadata = {
    target,
    version: AGENT_VERSION,
    appVersion: APP_VERSION,
    available: false,
    sizeBytes: 0,
    sha256: '',
    downloadUrl,
    updatedAt: null
  };

  try {
    const runtimeFile = agentRuntimeFile(target);
    const info = statSync(runtimeFile);
    const body = readFileSync(runtimeFile);
    metadata.available = true;
    metadata.sizeBytes = info.size;
    metadata.sha256 = createHash('sha256').update(body).digest('hex');
    metadata.updatedAt = info.mtime.toISOString();
  } catch {
    // Runtime binaries are produced by the GHCR build. Local dev servers can run without them.
  }

  return metadata;
}

function isRecent(iso, maxAgeMs = 180_000) {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

function offlineAfterMs(data) {
  return Math.max(Number(data.alertPolicy?.offlineAfterSeconds) || 180, 1) * 1000;
}

function isNodeOnline(node, data) {
  return isRecent(node.lastSeenAt, offlineAfterMs(data));
}

function requireUser(req, data, url) {
  const token = bearerToken(req) || url?.searchParams?.get('token') || '';
  if (!token) return null;
  const now = Date.now();
  const session = data.sessions.find((item) => item.token === token && Date.parse(item.expiresAt) > now);
  return session || null;
}

function requireAgent(req, data, agentId, url) {
  const token = bearerToken(req) || url.searchParams.get('token') || '';
  if (!token) return null;
  return data.agents.find((agent) => agent.id === agentId && agent.token === token) || null;
}

function maskChannel(channel) {
  return {
    ...channel,
    botToken: channel.botToken ? 'configured' : '',
    password: channel.password ? 'configured' : ''
  };
}

function presentProfile(profile, req) {
  const base = publicBaseUrl(req);
  return {
    ...profile,
    filters: normalizeSubscriptionFilters(profile.filters),
    linkPrefixMode: normalizeLinkPrefixMode(profile.linkPrefixMode),
    deletable: profile.protected !== true,
    publicUrl: `${base}/sub/${profile.token}`
  };
}

function presentNode(node, req, data) {
  const region = compactRegionLabel(node.region);
  const display = displayRegion(node);
  return {
    ...node,
    region,
    online: isNodeOnline(node, data),
    displayRegion: display,
    regionCode: nodeRegionCode(node),
    regionIcon: nodeRegionCode(node) || 'AUTO',
    agent: presentNodeAgent(node, data, req),
    installCommand: `curl -fsSL '${publicBaseUrl(req)}/api/v1/agents/install/${encodeURIComponent(node.installId)}' | sh`
  };
}

function presentNodeAgent(node, data, req) {
  const agent = data.agents.find((item) => item.nodeId === node.id) || null;
  const target = agentRuntimeTargetForAgent(agent);
  const runtime = target ? agentRuntimeMetadata(target, req) : null;
  const currentVersion = agent?.version || '';
  const latestVersion = runtime?.version || AGENT_VERSION;
  const available = runtime?.available === true;
  const updateAvailable = Boolean(currentVersion && currentVersion !== 'unknown' && latestVersion && currentVersion !== latestVersion);
  const remoteUpdateSupported = agentVersionAtLeast(currentVersion, '0.2.8-rust');
  return {
    id: agent?.id || null,
    version: currentVersion || 'unknown',
    platform: agent?.platform || 'unknown',
    arch: agent?.arch || 'unknown',
    target,
    installDir: agent?.installDir || '',
    serviceMode: agent?.serviceMode || 'unknown',
    lastSeenAt: agent?.lastSeenAt || null,
    latestVersion,
    runtimeAvailable: available,
    updateAvailable,
    remoteUpdateSupported,
    update: {
      ...(node.agentUpdate || {}),
      currentVersion: node.agentUpdate?.currentVersion || currentVersion || '',
      latestVersion: node.agentUpdate?.latestVersion || latestVersion || '',
      target: node.agentUpdate?.target || target || '',
      updateAvailable: node.agentUpdate?.updateAvailable ?? updateAvailable,
      available: node.agentUpdate?.available ?? available
    }
  };
}

function agentVersionAtLeast(current, minimum) {
  const currentParts = agentVersionParts(current);
  const minimumParts = agentVersionParts(minimum);
  if (!currentParts || !minimumParts) return false;
  for (let index = 0; index < Math.max(currentParts.length, minimumParts.length); index += 1) {
    const left = currentParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function agentVersionParts(input) {
  const match = String(input || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map((item) => Number(item)) : null;
}

function agentRuntimeTargetForAgent(agent) {
  const arch = String(agent?.arch || '').trim().toLowerCase();
  if (['x86_64', 'amd64', 'x64', 'linux-x64', 'linux-amd64'].includes(arch)) return 'linux-x64';
  if (['aarch64', 'arm64', 'linux-arm64'].includes(arch)) return 'linux-arm64';
  if (['arm', 'armv7', 'armv7l', 'linux-armv7', 'linux-armv7l'].includes(arch)) return 'linux-armv7l';
  return '';
}

function displayRegion(node) {
  if (node.region) return compactRegionLabel(node.region);
  if (node.network?.detectedRegion) return compactRegionLabel(node.network.detectedRegion);
  const source = node.network?.regionSource || '';
  if (source === 'geoip-empty') return 'GeoIP 未配置';
  if (source === 'geoip-miss') return 'GeoIP 未命中';
  if (node.network?.primaryIpv4 || node.network?.primaryIpv6) return '待手动设置区域';
  return '等待 Agent 上报';
}

function nodeRegionCode(node) {
  const fromRegion = firstRegionCode(node.region) || firstRegionCode(node.network?.detectedRegion);
  if (fromRegion) return fromRegion;
  const publicAddresses = Array.isArray(node.network?.publicAddresses) ? node.network.publicAddresses : [];
  const geo = publicAddresses.find((item) => item.countryCode);
  return firstRegionCode(geo?.countryCode);
}

function firstRegionCode(input) {
  const value = String(input || '').trim();
  const match = /(?:^|\b)([A-Z]{2})(?:\b|$)/.exec(value);
  return match ? match[1] : '';
}

function agentNodeSnapshot(node) {
  return {
    id: node.id,
    name: node.name,
    region: node.region,
    linkSecret: node.linkSecret,
    subscriptionEnabled: node.subscriptionEnabled,
    protocols: Array.isArray(node.protocols) ? node.protocols : [],
    network: node.network || {},
    addresses: Array.isArray(node.addresses) ? node.addresses : [],
    singBox: node.singBox || {}
  };
}

function presentAgentCommand(command, node) {
  return {
    ...command,
    node: agentNodeSnapshot(node)
  };
}

function dashboard(data) {
  const onlineNodes = data.nodes.filter((node) => isNodeOnline(node, data));
  const warningNodes = data.nodes.filter((node) => node.status === 'warning' || node.agentStatus === 'degraded');
  const queuedCommands = data.commands.filter((command) => ['queued', 'running'].includes(command.status));
  const traffic = trafficSummary(data.nodes);
  const cpuValues = onlineNodes
    .map((node) => Number(node.metrics?.cpu?.usagePercent))
    .filter((value) => Number.isFinite(value));
  const memoryValues = onlineNodes
    .map((node) => Number(node.metrics?.memory?.usagePercent))
    .filter((value) => Number.isFinite(value));

  return {
    counts: {
      nodes: data.nodes.length,
      onlineNodes: onlineNodes.length,
      warningNodes: warningNodes.length,
      agents: data.agents.length,
      queuedCommands: queuedCommands.length,
      enabledSubscriptions: data.subscriptionProfiles.filter((profile) => profile.enabled).length
    },
    averages: {
      cpuUsagePercent: average(cpuValues),
      memoryUsagePercent: average(memoryValues)
    },
    traffic,
    recentNodes: data.nodes
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 6),
    recentCommands: data.commands
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 6)
  };
}

function orderedNodes(nodes = []) {
  return nodes.slice().sort((a, b) => {
    const order = (Number(a.order) || 0) - (Number(b.order) || 0);
    if (order !== 0) return order;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function trafficSummary(nodes = []) {
  return nodes.reduce(
    (total, node) => {
      const traffic = node.traffic || {};
      total.totalRxBytes += Number(traffic.totalRxBytes) || 0;
      total.totalTxBytes += Number(traffic.totalTxBytes) || 0;
      total.totalBytes += Number(traffic.totalBytes) || 0;
      total.rxRateBytesPerSecond += Number(traffic.rxRateBytesPerSecond) || 0;
      total.txRateBytesPerSecond += Number(traffic.txRateBytesPerSecond) || 0;
      return total;
    },
    {
      totalRxBytes: 0,
      totalTxBytes: 0,
      totalBytes: 0,
      rxRateBytesPerSecond: 0,
      txRateBytesPerSecond: 0
    }
  );
}

function trafficModeValue(traffic = {}, mode = 'total') {
  const normalized = trafficLimitMode(mode);
  if (normalized === 'download') return Number(traffic.totalRxBytes) || 0;
  if (normalized === 'upload') return Number(traffic.totalTxBytes) || 0;
  return Number(traffic.totalBytes) || 0;
}

function addTrafficHistorySample(data, node, traffic, deltaRx, deltaTx, kind = 'sample') {
  data.trafficHistory ||= [];
  const rxBytes = Math.max(Number(deltaRx) || 0, 0);
  const txBytes = Math.max(Number(deltaTx) || 0, 0);
  data.trafficHistory.push({
    id: randomUUID(),
    nodeId: node.id,
    rxBytes,
    txBytes,
    totalBytes: rxBytes + txBytes,
    rxRateBytesPerSecond: Number(traffic.rxRateBytesPerSecond) || 0,
    txRateBytesPerSecond: Number(traffic.txRateBytesPerSecond) || 0,
    totalRxBytes: Number(traffic.totalRxBytes) || 0,
    totalTxBytes: Number(traffic.totalTxBytes) || 0,
    cumulativeBytes: Number(traffic.totalBytes) || 0,
    kind,
    createdAt: nowIso()
  });
  if (data.trafficHistory.length > TRAFFIC_HISTORY_LIMIT) {
    data.trafficHistory = data.trafficHistory.slice(data.trafficHistory.length - TRAFFIC_HISTORY_LIMIT);
  }
}

function resetNodeTraffic(data, node, kind = 'manual-reset') {
  const traffic = node.traffic || {};
  addTrafficHistorySample(data, node, traffic, 0, 0, kind);
  node.traffic = {
    ...traffic,
    totalRxBytes: 0,
    totalTxBytes: 0,
    totalBytes: 0,
    lastRxBytes: 0,
    lastTxBytes: 0,
    lastDeltaRxBytes: 0,
    lastDeltaTxBytes: 0,
    rxRateBytesPerSecond: 0,
    txRateBytesPerSecond: 0,
    thresholdExceededAt: null,
    lastResetAt: nowIso(),
    resetAnchorAt: traffic.resetAnchorAt || nowIso(),
    updatedAt: nowIso()
  };
  node.alertState ||= {};
  node.alertState.trafficThresholdAlertedAt = null;
  node.alertState.trafficWarningAlertedAt = null;
  if (node.status === 'warning') node.status = 'online';
  node.updatedAt = nowIso();
}

function beijingDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(value instanceof Date ? value : new Date(value))
    .reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function beijingMonthKey(value = new Date()) {
  return beijingDateKey(value).slice(0, 7);
}

function shouldResetTrafficCycle(traffic = {}) {
  const mode = traffic.resetMode || 'none';
  if (mode === 'none') return false;
  const now = new Date();
  if (!traffic.resetAnchorAt && !traffic.lastResetAt) {
    traffic.resetAnchorAt = nowIso();
    return false;
  }
  const lastResetAt = traffic.lastResetAt || traffic.resetAnchorAt;
  if (!lastResetAt) return false;
  if (mode === 'daily') return beijingDateKey(lastResetAt) !== beijingDateKey(now);
  if (mode === 'weekly') return Date.now() - Date.parse(lastResetAt) >= 7 * 24 * 60 * 60 * 1000;
  if (mode === 'interval') {
    const days = Math.min(Math.max(Number(traffic.resetIntervalDays) || 30, 1), 365);
    return Date.now() - Date.parse(lastResetAt) >= days * 24 * 60 * 60 * 1000;
  }
  if (mode === 'monthly') {
    const day = Math.min(Math.max(Number(traffic.resetDay) || 1, 1), 31);
    const currentDay = Number(beijingDateKey(now).slice(-2));
    return currentDay >= day && beijingMonthKey(lastResetAt) !== beijingMonthKey(now);
  }
  return false;
}

function trafficHistoryItems(data, options = {}) {
  const nodeId = String(options.nodeId || '').trim();
  const limit = Math.min(Math.max(Number(options.limit) || 240, 1), 2000);
  const since = options.since ? Date.parse(options.since) : 0;
  return (data.trafficHistory || [])
    .filter((item) => (!nodeId || item.nodeId === nodeId) && (!since || Date.parse(item.createdAt) >= since))
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function trafficRank(data, options = {}) {
  const mode = trafficLimitMode(options.mode || 'total');
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 200);
  return data.nodes
    .map((node) => ({
      nodeId: node.id,
      name: node.name,
      group: node.group || '',
      region: displayRegion(node),
      online: isNodeOnline(node, data),
      totalRxBytes: Number(node.traffic?.totalRxBytes) || 0,
      totalTxBytes: Number(node.traffic?.totalTxBytes) || 0,
      totalBytes: Number(node.traffic?.totalBytes) || 0,
      usageBytes: trafficModeValue(node.traffic, mode),
      limitMode: mode,
      updatedAt: node.traffic?.updatedAt || node.updatedAt
    }))
    .sort((a, b) => b.usageBytes - a.usageBytes)
    .slice(0, limit);
}

function average(values) {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function formatBeijingTime(value) {
  if (!value) return '-';
  const date = /^\d{10}$/.test(String(value)) ? new Date(Number(value) * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(date)
    .reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function clientAddress(req) {
  const raw = String(
    req.headers['cf-connecting-ip'] ||
      req.headers['x-real-ip'] ||
      req.headers['x-client-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      ''
  )
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, '');
  return net.isIP(raw) ? raw : '';
}

function normalizeAddressItem(item) {
  if (!item || typeof item !== 'object') return null;
  const address = String(item.address || item.ip || '').split('/')[0].trim();
  if (!net.isIP(address)) return null;
  const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
  return {
    interface: String(item.interface || item.name || item.iface || '').trim(),
    family,
    address,
    cidr: item.cidr ? String(item.cidr).trim() : '',
    region: String(item.region || item.regionName || '').trim(),
    countryCode: String(item.countryCode || item.country || '').trim(),
    city: String(item.city || '').trim(),
    source: String(item.source || '').trim()
  };
}

function addressesFromAgent(input, req) {
  const items = Array.isArray(input) ? input.map(normalizeAddressItem).filter(Boolean) : [];
  const remote = clientAddress(req);
  if (remote) {
    items.push({
      interface: 'remote',
      family: net.isIP(remote) === 6 ? 'ipv6' : 'ipv4',
      address: remote,
      cidr: '',
      source: 'panel-remote'
    });
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.interface}:${item.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('2001:db8:');
}

function isPublicAddress(item) {
  if (item.family === 'ipv4') return !isPrivateIpv4(item.address);
  if (item.family === 'ipv6') return !isPrivateIpv6(item.address);
  return false;
}

function isWarpAddress(item) {
  return /warp|wgcf|cloudflare|wireguard|^wg/i.test(item.interface || '') || /warp/i.test(item.source || '');
}

function isRemoteAddress(item) {
  return item.interface === 'remote' || item.source === 'panel-remote';
}

function isPublicLookupAddress(item) {
  return /^public-lookup/i.test(item.interface || '') || /^agent-public/i.test(item.source || '');
}

function compactRegionLabel(...parts) {
  const values = [];
  for (const part of parts.flatMap((item) => String(item || '').split(/\s*·\s*/))) {
    const value = part.trim();
    if (!value) continue;
    const normalized = value.toLowerCase().replace(/\s+/g, ' ');
    if (values.some((item) => item.normalized === normalized)) continue;
    values.push({ value, normalized });
  }
  return values.map((item) => item.value).join(' · ');
}

function normalizeStringList(input) {
  return Array.isArray(input) ? [...new Set(input.map((item) => String(item).trim()).filter(Boolean))] : [];
}

function normalizeSubscriptionFilters(input = {}) {
  const filters = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    nodeIds: normalizeStringList(filters.nodeIds),
    groups: normalizeStringList(filters.groups),
    regions: normalizeStringList(filters.regions),
    tags: normalizeStringList(filters.tags)
  };
}

function normalizeLinkPrefixMode(value) {
  return ['none', 'region'].includes(value) ? value : 'region';
}

const geoIpCache = { file: '', mtimeMs: 0, entries: [] };
const geositeCache = { file: '', mtimeMs: 0, entries: [] };

function geoIpFilePath() {
  return process.env.PULSEDECK_GEOIP_FILE || DEFAULT_GEOIP_FILE;
}

function geositeFilePath() {
  return process.env.PULSEDECK_GEOSITE_FILE || DEFAULT_GEOSITE_FILE;
}

function loadJsonEntries(file, cache) {
  try {
    const info = statSync(file);
    if (cache.file === file && cache.mtimeMs === info.mtimeMs) return cache.entries;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw.items) ? raw.items : [];
    cache.file = file;
    cache.mtimeMs = info.mtimeMs;
    cache.entries = entries.filter((item) => item && typeof item === 'object');
    return cache.entries;
  } catch {
    cache.file = file;
    cache.mtimeMs = 0;
    cache.entries = [];
    return [];
  }
}

function ipToBigInt(ip) {
  if (net.isIP(ip) === 4) {
    return ip.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
  }
  if (net.isIP(ip) !== 6) return null;
  const [headRaw, tailRaw = ''] = ip.toLowerCase().split('::');
  const head = headRaw ? headRaw.split(':') : [];
  const tail = tailRaw ? tailRaw.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = [...head, ...Array(missing).fill('0'), ...tail];
  return parts.reduce((value, part) => {
    const parsed = Number.parseInt(part || '0', 16);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffff) return value;
    return (value << 16n) + BigInt(parsed);
  }, 0n);
}

function cidrContains(cidr, ip) {
  const [base, prefixRaw] = String(cidr || '').split('/');
  const family = net.isIP(ip);
  if (!family || net.isIP(base) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw ?? bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const target = ipToBigInt(ip);
  const start = ipToBigInt(base);
  if (target == null || start == null) return false;
  const shift = BigInt(bits - prefix);
  return (target >> shift) === (start >> shift);
}

function detectGeoRegion(ip) {
  if (!net.isIP(ip)) return { region: '', countryCode: '', city: '', source: 'geoip-invalid' };
  const entries = loadJsonEntries(geoIpFilePath(), geoIpCache);
  const match = entries.find((entry) => {
    if (entry.cidr && cidrContains(entry.cidr, ip)) return true;
    if (Array.isArray(entry.cidrs) && entry.cidrs.some((cidr) => cidrContains(cidr, ip))) return true;
    return false;
  });
  if (!match) return { region: '', countryCode: '', city: '', source: entries.length ? 'geoip-miss' : 'geoip-empty' };
  return {
    region: String(match.region || match.name || match.countryCode || '').trim(),
    countryCode: String(match.countryCode || match.country || '').trim(),
    city: String(match.city || '').trim(),
    source: `geoip-file:${path.basename(geoIpFilePath())}`
  };
}

function lookupGeosite(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes('.')) {
    return { domain: normalized, matched: false, groups: [], source: 'geosite-invalid' };
  }
  const entries = loadJsonEntries(geositeFilePath(), geositeCache);
  const groups = entries
    .filter((entry) => {
      const exact = String(entry.domain || entry.exact || '').toLowerCase();
      const suffix = String(entry.suffix || '').toLowerCase();
      const keyword = String(entry.keyword || '').toLowerCase();
      if (exact && normalized === exact) return true;
      if (suffix && (normalized === suffix || normalized.endsWith(`.${suffix}`))) return true;
      if (keyword && normalized.includes(keyword)) return true;
      return false;
    })
    .map((entry) => ({
      code: String(entry.code || entry.group || entry.category || '').trim(),
      name: String(entry.name || entry.description || '').trim()
    }));
  return {
    domain: normalized,
    matched: groups.length > 0,
    groups,
    source: entries.length ? `geosite-file:${path.basename(geositeFilePath())}` : 'geosite-empty'
  };
}

function analyzeAddresses(addresses = []) {
  const normalized = addresses.map(normalizeAddressItem).filter(Boolean);
  const publicAddresses = normalized.filter(isPublicAddress);
  const nativePublicIpv4 = publicAddresses.find((item) => item.family === 'ipv4' && !isWarpAddress(item) && !isRemoteAddress(item) && !isPublicLookupAddress(item)) || null;
  const nativePublicIpv6 = publicAddresses.find((item) => item.family === 'ipv6' && !isWarpAddress(item) && !isRemoteAddress(item) && !isPublicLookupAddress(item)) || null;
  const remoteIpv4 = publicAddresses.find((item) => item.family === 'ipv4' && isRemoteAddress(item)) || null;
  const remoteIpv6 = publicAddresses.find((item) => item.family === 'ipv6' && isRemoteAddress(item)) || null;
  const lookupIpv4 = publicAddresses.find((item) => item.family === 'ipv4' && isPublicLookupAddress(item)) || null;
  const lookupIpv6 = publicAddresses.find((item) => item.family === 'ipv6' && isPublicLookupAddress(item)) || null;
  const publicWarpIpv4 = publicAddresses.find((item) => item.family === 'ipv4' && isWarpAddress(item)) || null;
  const publicWarpIpv6 = publicAddresses.find((item) => item.family === 'ipv6' && isWarpAddress(item)) || null;
  const publicIpv4 = nativePublicIpv4 || lookupIpv4 || remoteIpv4 || publicWarpIpv4 || publicAddresses.find((item) => item.family === 'ipv4') || null;
  const publicIpv6 = nativePublicIpv6 || lookupIpv6 || remoteIpv6 || publicWarpIpv6 || publicAddresses.find((item) => item.family === 'ipv6') || null;
  const anyIpv4 = normalized.find((item) => item.family === 'ipv4') || null;
  const anyIpv6 = normalized.find((item) => item.family === 'ipv6') || null;
  const privateWarpIpv4 = normalized.find((item) => item.family === 'ipv4' && isWarpAddress(item) && !isPublicAddress(item)) || null;
  const hasWarpInterface = normalized.some(isWarpAddress);
  const warpLikely = hasWarpInterface || (!nativePublicIpv4 && nativePublicIpv6 && Boolean(remoteIpv4 || lookupIpv4));
  const warpIpv4 = warpLikely ? publicWarpIpv4?.address || remoteIpv4?.address || lookupIpv4?.address || null : null;
  const warpIpv6 = warpLikely ? publicWarpIpv6?.address || null : null;
  const primaryIpv4 = nativePublicIpv4?.address || (!warpLikely ? publicIpv4?.address || anyIpv4?.address || null : null);
  const primaryIpv6 = nativePublicIpv6?.address || (!warpLikely ? publicIpv6?.address || anyIpv6?.address || null : publicIpv6?.address || anyIpv6?.address || null);
  let ipMode = 'unknown';
  if (warpLikely && (warpIpv4 || privateWarpIpv4) && primaryIpv6) ipMode = 'warp-v4-ipv6';
  else if (primaryIpv4 && primaryIpv6) ipMode = 'dual-stack';
  else if (primaryIpv4) ipMode = 'ipv4-only';
  else if (primaryIpv6) ipMode = 'ipv6-only';
  else if (anyIpv4 && anyIpv6) ipMode = 'private-dual-stack';
  else if (anyIpv4) ipMode = 'private-ipv4';
  else if (anyIpv6) ipMode = 'private-ipv6';

  const lookupIp = primaryIpv4 || primaryIpv6 || warpIpv4 || publicIpv4?.address || publicIpv6?.address || '';
  let geo = lookupIp ? detectGeoRegion(lookupIp) : { region: '', countryCode: '', city: '', source: 'auto-pending' };
  const agentGeo = publicAddresses.find((item) => item.region || item.countryCode || item.city);
  if (!geo.region && agentGeo) {
    geo = {
      region: agentRegionLabel(agentGeo),
      countryCode: agentGeo.countryCode || '',
      city: agentGeo.city || '',
      source: agentGeo.source || 'agent-public-lookup'
    };
  }
  return {
    primaryIpv4,
    primaryIpv6,
    warpIpv4,
    warpIpv6,
    ipMode,
    publicAddresses,
    warpLikely,
    detectedRegion: geo.region,
    regionSource: geo.source,
    updatedAt: nowIso()
  };
}

function agentRegionLabel(item) {
  return compactRegionLabel(item.countryCode, item.region, item.city) || item.region || item.countryCode || item.city || '';
}

function applyNetworkDiscovery(node, addresses) {
  if (!Array.isArray(addresses)) return;
  const normalized = addresses.map(normalizeAddressItem).filter(Boolean);
  node.addresses = normalized;
  const analysis = analyzeAddresses(normalized);
  node.network = { ...(node.network || {}), ...analysis };
  if (!node.regionOverride && analysis.detectedRegion) {
    node.region = compactRegionLabel(analysis.detectedRegion);
  }
}

function metricsTraffic(metrics) {
  const interfaces = Array.isArray(metrics?.network?.interfaces) ? metrics.network.interfaces : [];
  return interfaces.reduce(
    (total, item) => ({
      rx: total.rx + (Number(item.rxBytes) || 0),
      tx: total.tx + (Number(item.txBytes) || 0)
    }),
    { rx: 0, tx: 0 }
  );
}

function trafficSnapshot(data) {
  return {
    type: 'traffic.snapshot',
    time: nowIso(),
    items: data.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      agentStatus: node.agentStatus,
      online: isNodeOnline(node, data),
      lastSeenAt: node.lastSeenAt,
      region: node.region,
      displayRegion: displayRegion(node),
      subscriptionEnabled: node.subscriptionEnabled,
      metrics: node.metrics || null,
      traffic: node.traffic || {},
      network: node.network || {}
    }))
  };
}

function addAlertEvent(data, event) {
  data.alertEvents ||= [];
  const channels = [...new Set((Array.isArray(event.channels) ? event.channels : []).map((item) => String(item)).filter(Boolean))];
  if (event.dedupeKey && data.alertEvents.some((item) => item.dedupeKey === event.dedupeKey)) {
    return data.alertEvents.find((item) => item.dedupeKey === event.dedupeKey);
  }
  const alert = {
    id: randomUUID(),
    status: 'pending',
    channels,
    deliveries: channels.map((channel) => deliveryPlan(data, channel)),
    actions: Array.isArray(event.actions) ? event.actions : [],
    acknowledgedAt: null,
    resolvedAt: event.resolvedAt || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...event
  };
  alert.channels = channels;
  refreshAlertStatus(alert);
  data.alertEvents.push(alert);
  if (data.alertEvents.length > 1000) data.alertEvents = data.alertEvents.slice(-1000);
  return alert;
}

function deliveryPlan(data, channelName) {
  const channel = String(channelName || '').trim();
  const timestamp = nowIso();
  if (channel === 'telegram') {
    const config = data.notificationChannels?.telegram || {};
    const ready = config.enabled === true && Boolean(config.botToken) && Boolean(config.chatId);
    return {
      channel,
      status: ready ? 'pending' : 'skipped',
      detail: ready ? 'Telegram 渠道已配置' : 'Telegram 渠道未启用或配置不完整',
      updatedAt: timestamp
    };
  }
  if (channel === 'email') {
    const config = data.notificationChannels?.email || {};
    const ready = config.enabled === true && Boolean(config.smtpHost) && Boolean(config.from) && Boolean(config.to);
    return {
      channel,
      status: ready ? 'pending' : 'skipped',
      detail: ready ? 'SMTP 渠道已配置' : '邮件渠道未启用或配置不完整',
      updatedAt: timestamp
    };
  }
  return {
    channel,
    status: 'skipped',
    detail: '未知通知渠道',
    updatedAt: timestamp
  };
}

function refreshAlertStatus(event) {
  const deliveries = Array.isArray(event.deliveries) ? event.deliveries : [];
  if (event.acknowledgedAt) {
    event.status = 'acknowledged';
    return event.status;
  }
  if (!deliveries.length || deliveries.every((delivery) => delivery.status === 'skipped')) {
    event.status = 'skipped';
    return event.status;
  }
  if (deliveries.some((delivery) => delivery.status === 'pending')) {
    event.status = 'pending';
    return event.status;
  }
  if (deliveries.some((delivery) => delivery.status === 'delivered')) {
    event.status = 'delivered';
    return event.status;
  }
  event.status = deliveries.some((delivery) => delivery.status === 'failed') ? 'failed' : 'skipped';
  return event.status;
}

function alertSubject(event) {
  const level = event.level === 'critical' ? '严重' : event.level === 'warning' ? '警告' : '信息';
  return `[PulseDeck] ${level} ${event.type || 'alert'}`;
}

function alertBody(event) {
  return [
    alertSubject(event),
    '',
    event.message || '',
    event.nodeId ? `Node: ${event.nodeId}` : '',
    event.createdAt ? `时间: ${formatBeijingTime(event.createdAt)}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverAlert(event, delivery, channels) {
  if (delivery.channel === 'telegram') {
    const config = channels.telegram || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: config.chatId,
          text: alertBody(event),
          parse_mode: config.parseMode || 'HTML',
          disable_web_page_preview: true
        })
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Telegram API ${response.status}`);
      return 'Telegram message delivered';
    } finally {
      clearTimeout(timer);
    }
  }

  if (delivery.channel === 'email') {
    await sendSmtpMail(channels.email || {}, alertSubject(event), alertBody(event));
    return 'SMTP message delivered';
  }

  throw new Error('unknown notification channel');
}

function smtpEncodeHeader(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function smtpRecipients(value) {
  return String(value || '')
    .split(',')
    .map((item) => smtpAddress(item))
    .filter(Boolean);
}

function smtpAddress(value) {
  return String(value || '')
    .replace(/[\r\n<>]/g, '')
    .trim();
}

function waitForSocket(socket, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onEvent);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP socket timed out'));
    };
    socket.once(event, onEvent);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP response timed out'));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP response timed out'));
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      const match = /^(\d{3})\s/.exec(last);
      if (!match) return;
      cleanup();
      resolve({ code: Number(match[1]), text: lines.join('\n') });
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

async function smtpCommand(socket, command, expected = [250]) {
  socket.write(`${command}\r\n`);
  const response = await readSmtpResponse(socket);
  if (!expected.includes(response.code)) throw new Error(`SMTP command failed (${response.code}): ${response.text}`);
  return response;
}

async function sendSmtpMail(config, subject, body) {
  const host = String(config.smtpHost || '').trim();
  const port = Number(config.smtpPort) || 587;
  const recipients = smtpRecipients(config.to);
  const from = smtpAddress(config.from);
  if (!host || !from || recipients.length === 0) throw new Error('SMTP channel is incomplete');
  let socket = port === 465 ? tls.connect({ host, port, servername: host, timeout: 5000 }) : net.createConnection({ host, port, timeout: 5000 });
  socket.setEncoding('utf8');
  await waitForSocket(socket, port === 465 ? 'secureConnect' : 'connect');
  let response = await readSmtpResponse(socket);
  if (response.code !== 220) throw new Error(`SMTP banner failed (${response.code}): ${response.text}`);

  response = await smtpCommand(socket, 'EHLO pulsedeck.local');
  if (port !== 465 && /STARTTLS/im.test(response.text)) {
    await smtpCommand(socket, 'STARTTLS', [220]);
    socket = tls.connect({ socket, servername: host, timeout: 5000 });
    socket.setEncoding('utf8');
    await waitForSocket(socket, 'secureConnect');
    await smtpCommand(socket, 'EHLO pulsedeck.local');
  }

  if (config.username && config.password) {
    await smtpCommand(socket, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, Buffer.from(String(config.username), 'utf8').toString('base64'), [334]);
    await smtpCommand(socket, Buffer.from(String(config.password), 'utf8').toString('base64'), [235]);
  }

  await smtpCommand(socket, `MAIL FROM:<${from}>`);
  for (const recipient of recipients) await smtpCommand(socket, `RCPT TO:<${recipient}>`, [250, 251]);
  await smtpCommand(socket, 'DATA', [354]);
  const message = [
    `From: ${smtpEncodeHeader(from)}`,
    `To: ${smtpEncodeHeader(recipients.join(', '))}`,
    `Subject: ${smtpEncodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body.replace(/^\./gm, '..')
  ].join('\r\n');
  socket.write(`${message}\r\n.\r\n`);
  response = await readSmtpResponse(socket);
  if (response.code !== 250) throw new Error(`SMTP DATA failed (${response.code}): ${response.text}`);
  socket.write('QUIT\r\n');
  socket.end();
}

async function dispatchPendingAlertEvents(store) {
  if (!(store.data.alertEvents || []).some((event) => (event.deliveries || []).some((delivery) => delivery.status === 'pending'))) return;
  await store.update(async (draft) => {
    for (const event of draft.alertEvents || []) {
      for (const delivery of event.deliveries || []) {
        if (delivery.status !== 'pending') continue;
        try {
          delivery.detail = await deliverAlert(event, delivery, draft.notificationChannels || {});
          delivery.status = 'delivered';
        } catch (error) {
          delivery.status = 'failed';
          delivery.detail = error.message || 'delivery failed';
        }
        delivery.updatedAt = nowIso();
        event.updatedAt = delivery.updatedAt;
      }
      refreshAlertStatus(event);
    }
  });
}

function trafficLimitAction(data, node, traffic) {
  if (traffic.autoDisableSubscription || node.alertPolicy?.autoDisableOnTrafficLimit) return 'disable-node-subscription';
  const policy = data.alertPolicy || {};
  if (policy.autoDisableOnTrafficLimit !== true) return 'keep-node';
  return policy.trafficLimitAction || 'disable-node-subscription';
}

function applyTrafficLimitAction(data, node, action) {
  const timestamp = nowIso();
  if (action === 'disable-node-subscription') {
    const changed = node.subscriptionEnabled !== false;
    node.subscriptionEnabled = false;
    return [
      {
        type: 'disable-node-subscription',
        status: changed ? 'completed' : 'skipped',
        detail: changed ? '节点订阅输出已禁用' : '节点订阅输出此前已禁用',
        updatedAt: timestamp
      }
    ];
  }
  if (action === 'disable-all-subscriptions') {
    const disabledProfiles = [];
    for (const profile of data.subscriptionProfiles || []) {
      if (profile.enabled) {
        profile.enabled = false;
        profile.updatedAt = timestamp;
        disabledProfiles.push(profile.id);
      }
    }
    node.subscriptionEnabled = false;
    return [
      {
        type: 'disable-node-subscription',
        status: 'completed',
        detail: '节点订阅输出已禁用',
        updatedAt: timestamp
      },
      {
        type: 'disable-all-subscriptions',
        status: disabledProfiles.length ? 'completed' : 'skipped',
        detail: disabledProfiles.length ? `已禁用 ${disabledProfiles.length} 个订阅 Profile` : '所有订阅 Profile 此前已禁用',
        profileIds: disabledProfiles,
        updatedAt: timestamp
      }
    ];
  }
  return [
    {
      type: 'keep-node',
      status: 'skipped',
      detail: '流量超限动作已关闭',
      updatedAt: timestamp
    }
  ];
}

function updateTrafficAccounting(data, node, metrics) {
  const current = metricsTraffic(metrics);
  if (!current.rx && !current.tx) return;
  node.traffic ||= {};
  if (shouldResetTrafficCycle(node.traffic)) resetNodeTraffic(data, node, 'cycle-reset');
  const traffic = node.traffic || {};
  const previousUpdatedAt = traffic.updatedAt ? Date.parse(traffic.updatedAt) : 0;
  const currentUpdatedAt = Date.now();
  const lastRx = Number(traffic.lastRxBytes) || 0;
  const lastTx = Number(traffic.lastTxBytes) || 0;
  const deltaRx = lastRx > 0 && current.rx >= lastRx ? current.rx - lastRx : 0;
  const deltaTx = lastTx > 0 && current.tx >= lastTx ? current.tx - lastTx : 0;
  const elapsedSeconds = previousUpdatedAt > 0 ? Math.max((currentUpdatedAt - previousUpdatedAt) / 1000, 1) : 0;
  traffic.totalRxBytes = (Number(traffic.totalRxBytes) || 0) + deltaRx;
  traffic.totalTxBytes = (Number(traffic.totalTxBytes) || 0) + deltaTx;
  traffic.totalBytes = traffic.totalRxBytes + traffic.totalTxBytes;
  traffic.lastRxBytes = current.rx;
  traffic.lastTxBytes = current.tx;
  traffic.lastDeltaRxBytes = deltaRx;
  traffic.lastDeltaTxBytes = deltaTx;
  traffic.rxRateBytesPerSecond = elapsedSeconds ? Math.round(deltaRx / elapsedSeconds) : 0;
  traffic.txRateBytesPerSecond = elapsedSeconds ? Math.round(deltaTx / elapsedSeconds) : 0;
  traffic.updatedAt = nowIso();
  addTrafficHistorySample(data, node, traffic, deltaRx, deltaTx, 'sample');
  const threshold = Number(traffic.thresholdBytes) || 0;
  traffic.limitMode = trafficLimitMode(traffic.limitMode);
  node.alertState ||= {};
  const warningPercent = Math.min(Math.max(Number(traffic.warningPercent) || 80, 1), 100);
  const warningBytes = threshold > 0 ? Math.floor((threshold * warningPercent) / 100) : 0;
  const usageBytes = trafficLimitUsage(traffic);
  if (warningBytes > 0 && usageBytes >= warningBytes && !node.alertState.trafficWarningAlertedAt && !traffic.thresholdExceededAt) {
    node.alertState.trafficWarningAlertedAt = nowIso();
    addAlertEvent(data, {
      nodeId: node.id,
      type: 'traffic-warning',
      level: 'warning',
      message: `节点 ${node.name} 已达到${trafficLimitModeLabel(traffic.limitMode)}流量阈值的 ${warningPercent}%`,
      channels: node.alertPolicy?.trafficChannels || data.alertPolicy?.trafficChannels || [],
      dedupeKey: `traffic-warning:${node.id}:${threshold}`
    });
  }
  if (threshold > 0 && usageBytes >= threshold && !traffic.thresholdExceededAt) {
    traffic.thresholdExceededAt = nowIso();
    node.alertState.trafficThresholdAlertedAt = traffic.thresholdExceededAt;
    node.status = 'warning';
    const action = trafficLimitAction(data, node, traffic);
    const actions = applyTrafficLimitAction(data, node, action);
    addAlertEvent(data, {
      nodeId: node.id,
      type: 'traffic-threshold',
      level: 'warning',
      message: `节点 ${node.name} 已超过${trafficLimitModeLabel(traffic.limitMode)}流量阈值`,
      channels: node.alertPolicy?.trafficChannels || data.alertPolicy?.trafficChannels || [],
      actions,
      dedupeKey: `traffic-threshold:${node.id}:${threshold}`
    });
  }
  node.traffic = traffic;
}

function trafficLimitMode(value) {
  return ['total', 'download', 'upload'].includes(value) ? value : 'total';
}

function trafficLimitUsage(traffic = {}) {
  const mode = trafficLimitMode(traffic.limitMode);
  if (mode === 'download') return Number(traffic.totalRxBytes) || 0;
  if (mode === 'upload') return Number(traffic.totalTxBytes) || 0;
  return Number(traffic.totalBytes) || 0;
}

function trafficLimitModeLabel(mode) {
  return { total: '总量', download: '下载', upload: '上传' }[trafficLimitMode(mode)] || '总量';
}

function evaluateOfflineAlerts(data) {
  const checkedAt = nowIso();
  const maxAgeMs = offlineAfterMs(data);
  const summary = {
    checkedAt,
    offlineNodes: 0,
    recoveredNodes: 0,
    createdEvents: 0
  };

  for (const node of data.nodes || []) {
    node.alertState ||= {};
    if (!node.lastSeenAt || node.agentStatus === 'not-installed') continue;
    const online = isRecent(node.lastSeenAt, maxAgeMs);
    if (!online) {
      summary.offlineNodes += 1;
      if (!node.alertState.offlineSince) node.alertState.offlineSince = node.lastSeenAt;
      node.status = 'offline';
      node.agentStatus = 'offline';
      if (!node.alertState.offlineAlertedAt) {
        node.alertState.offlineAlertedAt = checkedAt;
        addAlertEvent(data, {
          nodeId: node.id,
          type: 'node-offline',
          level: 'critical',
          message: `节点 ${node.name} 离线超过 ${Math.round(maxAgeMs / 1000)} 秒`,
          channels: node.alertPolicy?.offlineChannels || data.alertPolicy?.offlineChannels || [],
          dedupeKey: `node-offline:${node.id}:${node.alertState.offlineSince}`
        });
        summary.createdEvents += 1;
      }
      node.updatedAt = checkedAt;
      continue;
    }

    if (node.alertState.offlineSince) {
      node.alertState.recoveredAt = checkedAt;
      node.alertState.offlineSince = null;
      node.alertState.offlineAlertedAt = null;
      node.status = 'online';
      node.agentStatus = node.agentStatus === 'offline' ? 'online' : node.agentStatus;
      addAlertEvent(data, {
        nodeId: node.id,
        type: 'node-recovered',
        level: 'info',
        message: `节点 ${node.name} 已恢复在线`,
        channels: node.alertPolicy?.offlineChannels || data.alertPolicy?.offlineChannels || [],
        resolvedAt: checkedAt,
        dedupeKey: `node-recovered:${node.id}:${checkedAt}`
      });
      summary.recoveredNodes += 1;
      summary.createdEvents += 1;
      node.updatedAt = checkedAt;
    }
  }

  return summary;
}

function subscriptionLinks(data, profile = {}) {
  return data.nodes
    .filter((node) => node.subscriptionEnabled && isRecent(node.lastSeenAt, 24 * 60 * 60 * 1000))
    .filter((node) => profileMatchesNode(profile, node))
    .flatMap((node) => {
      if (Array.isArray(node.reportedLinks) && node.reportedLinks.length > 0) {
        return node.reportedLinks.map((link) => decorateSubscriptionLink(link, node, profile));
      }
      return [];
    })
    .filter(Boolean);
}

function renderSubscription(data, profile) {
  const links = subscriptionLinks(data, profile);
  if (!profile.enabled) return '# PulseDeck subscription is disabled\n';
  if (links.length === 0) return '# PulseDeck: no active node links reported yet\n';

  if (profile.format === 'v2ray') {
    return `${Buffer.from(links.join('\n'), 'utf8').toString('base64')}\n`;
  }

  if (profile.format === 'clash') {
    const proxies = links.map((link, index) => {
      const safeName = `PulseDeck-${index + 1}`;
      return `  - name: ${JSON.stringify(safeName)}\n    type: ss\n    server: 127.0.0.1\n    port: 1\n    cipher: aes-128-gcm\n    password: ${JSON.stringify(link)}`;
    });
    return `proxies:\n${proxies.join('\n')}\nproxy-groups:\n  - name: PulseDeck\n    type: select\n    proxies:\n${links.map((_, index) => `      - PulseDeck-${index + 1}`).join('\n')}\nrules:\n  - MATCH,PulseDeck\n`;
  }

  return `${links.join('\n')}\n`;
}

function profileMatchesNode(profile, node) {
  const filters = normalizeSubscriptionFilters(profile.filters);
  if (filters.nodeIds.length && !filters.nodeIds.includes(node.id)) return false;
  if (filters.groups.length && !filters.groups.includes(node.group || '未分组')) return false;
  const region = compactRegionLabel(node.region || node.network?.detectedRegion || '');
  if (filters.regions.length && !filters.regions.some((item) => region.includes(item) || item.includes(region))) return false;
  if (filters.tags.length) {
    const nodeTags = new Set(Array.isArray(node.tags) ? node.tags : []);
    if (!filters.tags.some((tag) => nodeTags.has(tag))) return false;
  }
  return true;
}

function decorateSubscriptionLink(link, node, profile) {
  const raw = String(link || '').trim();
  if (!raw || normalizeLinkPrefixMode(profile.linkPrefixMode) === 'none') return raw;
  const prefix = subscriptionNodePrefix(node);
  if (!prefix) return raw;
  if (/^vmess:\/\//i.test(raw)) return decorateVmessLink(raw, node, prefix);
  return decorateFragmentLink(raw, node, prefix);
}

function subscriptionNodePrefix(node) {
  const region = compactRegionLabel(node.region || node.network?.detectedRegion || '');
  const code = nodeRegionCode(node);
  return compactRegionLabel(code, region) || code || region;
}

function prefixedSubscriptionName(currentName, node, prefix) {
  const name = String(currentName || node.name || 'PulseDeck').trim();
  if (!prefix || name.startsWith(prefix) || name.startsWith(`[${prefix}]`)) return name;
  return `${prefix} ${name}`.trim();
}

function decorateFragmentLink(raw, node, prefix) {
  const hashIndex = raw.indexOf('#');
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
  let currentName = fragment || node.name;
  try {
    currentName = decodeURIComponent(currentName);
  } catch {
    // Keep the raw fragment when it is not percent-encoded.
  }
  return `${base}#${encodeURIComponent(prefixedSubscriptionName(currentName, node, prefix))}`;
}

function decorateVmessLink(raw, node, prefix) {
  const encoded = raw.slice('vmess://'.length).trim();
  try {
    const json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    json.ps = prefixedSubscriptionName(json.ps, node, prefix);
    return `vmess://${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`;
  } catch {
    return decorateFragmentLink(raw, node, prefix);
  }
}

function updateNodeFromAgent(data, node, agent, patch = {}) {
  const timestamp = nowIso();
  const wasOffline = Boolean(node.alertState?.offlineSince) || node.status === 'offline' || node.agentStatus === 'offline';
  node.status = patch.status || 'online';
  node.agentStatus = patch.agentStatus || 'online';
  node.lastSeenAt = timestamp;
  node.updatedAt = timestamp;
  if (Array.isArray(patch.addresses)) applyNetworkDiscovery(node, patch.addresses);
  if (patch.metrics) {
    node.metrics = patch.metrics;
    updateTrafficAccounting(data, node, patch.metrics);
  }
  if (patch.diagnostics) node.diagnostics = patch.diagnostics;
  if (Array.isArray(patch.reportedLinks)) node.reportedLinks = patch.reportedLinks;
  if (wasOffline) {
    node.alertState ||= {};
    node.alertState.recoveredAt = timestamp;
    node.alertState.offlineSince = null;
    node.alertState.offlineAlertedAt = null;
    addAlertEvent(data, {
      nodeId: node.id,
      type: 'node-recovered',
      level: 'info',
      message: `节点 ${node.name} 已恢复在线`,
      channels: node.alertPolicy?.offlineChannels || data.alertPolicy?.offlineChannels || [],
      resolvedAt: timestamp,
      dedupeKey: `node-recovered:${node.id}:${timestamp}`
    });
  }

  agent.lastSeenAt = timestamp;
  agent.updatedAt = timestamp;
  if (patch.version) agent.version = patch.version;
  if (patch.platform) agent.platform = patch.platform;
  if (patch.arch) agent.arch = patch.arch;
  if (patch.installDir) agent.installDir = patch.installDir;
  if (patch.serviceMode) agent.serviceMode = patch.serviceMode;
  if (patch.version && node.agentUpdate) {
    node.agentUpdate.currentVersion = patch.version;
    node.agentUpdate.updateAvailable = Boolean(node.agentUpdate.latestVersion && node.agentUpdate.latestVersion !== patch.version);
    node.agentUpdate.updatedAt = timestamp;
  }
}

function resultData(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

function commandEvents(data, commandId) {
  return (data.commandEvents || [])
    .filter((event) => event.commandId === commandId)
    .slice()
    .sort((a, b) => {
      const seq = (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
      if (seq !== 0) return seq;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

function appendCommandEvent(draft, command, input = {}) {
  draft.commandEvents ||= [];
  const event = {
    id: randomUUID(),
    commandId: command.id,
    nodeId: command.nodeId,
    agentId: input.agentId ?? command.agentId ?? null,
    type: String(input.type || 'state').trim() || 'state',
    stream: String(input.stream || input.type || 'state').trim() || 'state',
    message: String(input.message || '').slice(0, 16_000),
    payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {},
    sequence: Number(input.sequence) || draft.commandEvents.filter((event) => event.commandId === command.id).length + 1,
    createdAt: input.createdAt || nowIso()
  };
  draft.commandEvents.push(event);
  const related = draft.commandEvents.filter((item) => item.commandId === command.id);
  if (related.length > 500) {
    const remove = new Set(related.slice(0, related.length - 500).map((item) => item.id));
    draft.commandEvents = draft.commandEvents.filter((item) => !remove.has(item.id));
  }
  return event;
}

function createCommand(draft, nodeId, type, payload = {}) {
  const command = {
    id: randomUUID(),
    nodeId,
    agentId: null,
    type,
    payload,
    status: 'queued',
    result: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  draft.commands.push(command);
  appendCommandEvent(draft, command, {
    type: 'state',
    stream: 'state',
    message: `已入队 ${type}`,
    payload: { status: 'queued', type }
  });
  return command;
}

function applyCommandResultSideEffects(draft, command, result) {
  const node = draft.nodes.find((item) => item.id === command.nodeId);
  if (!node) return;
  const data = resultData(result);
  const timestamp = nowIso();

  if (Array.isArray(data.reportedLinks)) {
    node.reportedLinks = data.reportedLinks.map((link) => String(link).trim()).filter(Boolean);
    node.updatedAt = timestamp;
  }

  if (data.singBox && typeof data.singBox === 'object' && !Array.isArray(data.singBox)) {
    node.singBox = {
      ...(node.singBox || {}),
      ...data.singBox,
      updatedAt: data.singBox.updatedAt || timestamp
    };
    node.updatedAt = timestamp;
  }

  if (data.agentUpdate && typeof data.agentUpdate === 'object' && !Array.isArray(data.agentUpdate)) {
    node.agentUpdate = {
      currentVersion: String(data.agentUpdate.currentVersion || ''),
      latestVersion: String(data.agentUpdate.latestVersion || ''),
      target: String(data.agentUpdate.target || ''),
      available: data.agentUpdate.available === true,
      updateAvailable: data.agentUpdate.updateAvailable === true,
      status: String(data.agentUpdate.status || ''),
      message: String(data.agentUpdate.message || data.message || ''),
      checkedAt: data.agentUpdate.checkedAt || timestamp,
      updatedAt: data.agentUpdate.updatedAt || timestamp
    };
    const agent = draft.agents.find((item) => item.nodeId === node.id);
    if (agent && data.agentUpdate.currentVersion) agent.version = String(data.agentUpdate.currentVersion);
    node.updatedAt = timestamp;
  }
}

function commandResultMessage(result) {
  const data = resultData(result);
  const message = String(data.message || result?.message || '').trim();
  return message || 'command failed';
}

function purgeNodes(draft, nodeIds) {
  const removeIds = new Set(nodeIds);
  const agentIds = new Set(draft.agents.filter((agent) => removeIds.has(agent.nodeId)).map((agent) => agent.id));
  const beforeNodes = draft.nodes.length;
  const beforeAgents = draft.agents.length;
  const beforeCommands = draft.commands.length;
  const beforeAlertEvents = (draft.alertEvents || []).length;
  const beforeTrafficHistory = (draft.trafficHistory || []).length;
  const removedCommandIds = new Set(
    draft.commands.filter((command) => removeIds.has(command.nodeId) || agentIds.has(command.agentId)).map((command) => command.id)
  );
  draft.nodes = draft.nodes.filter((item) => !removeIds.has(item.id));
  draft.agents = draft.agents.filter((agent) => !removeIds.has(agent.nodeId));
  draft.commands = draft.commands.filter((command) => !removeIds.has(command.nodeId) && !agentIds.has(command.agentId));
  draft.commandEvents = (draft.commandEvents || []).filter((event) => !removedCommandIds.has(event.commandId));
  draft.alertEvents = (draft.alertEvents || []).filter((event) => !removeIds.has(event.nodeId));
  draft.trafficHistory = (draft.trafficHistory || []).filter((item) => !removeIds.has(item.nodeId));
  return {
    removedNodes: beforeNodes - draft.nodes.length,
    removedAgents: beforeAgents - draft.agents.length,
    removedCommands: beforeCommands - draft.commands.length,
    removedAlertEvents: beforeAlertEvents - draft.alertEvents.length,
    removedTrafficHistory: beforeTrafficHistory - draft.trafficHistory.length
  };
}

function sendSseEvent(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendCommandEventsSse(req, res, store, commandId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  });

  let lastCount = 0;
  const sendNewEvents = () => {
    const events = commandEvents(store.data, commandId);
    for (const event of events.slice(lastCount)) {
      sendSseEvent(res, event.type || 'message', event);
    }
    lastCount = events.length;
  };

  sendNewEvents();
  const timer = setInterval(() => {
    try {
      sendNewEvents();
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(timer);
    }
  }, 1000);
  req.on('close', () => clearInterval(timer));
}

function websocketAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function websocketFrame(payload) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function websocketControlFrame(opcode, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function writeWebSocket(socket, payload) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(websocketFrame(payload));
}

function readWebSocketFrames(socket, chunk, onText) {
  socket.pulseDeckBuffer = socket.pulseDeckBuffer ? Buffer.concat([socket.pulseDeckBuffer, chunk]) : Buffer.from(chunk);
  let buffer = socket.pulseDeckBuffer;
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) break;
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        socket.destroy();
        return;
      }
      length = Number(bigLength);
      offset += 8;
    }
    let mask;
    if (masked) {
      if (buffer.length < offset + 4) break;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    buffer = buffer.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 0x8) {
      socket.end(websocketControlFrame(0x8));
      return;
    }
    if (opcode === 0x9) {
      socket.write(websocketControlFrame(0xa, payload));
      continue;
    }
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
  socket.pulseDeckBuffer = buffer;
}

function closeUpgrade(socket, status = 401, detail = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${status} ${detail}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function createTrafficHub(store) {
  const clients = new Set();
  let heartbeatTimer = null;

  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const socket of clients) writeWebSocket(socket, { type: 'heartbeat', time: nowIso() });
    }, 15_000);
  };

  const stopHeartbeat = () => {
    if (clients.size > 0 || !heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  return {
    add(socket) {
      clients.add(socket);
      startHeartbeat();
      writeWebSocket(socket, trafficSnapshot(store.data));
      socket.on('close', () => {
        clients.delete(socket);
        stopHeartbeat();
      });
      socket.on('error', () => {
        clients.delete(socket);
        stopHeartbeat();
      });
      socket.on('data', (chunk) => {
        if (chunk[0] === 0x88) socket.end();
      });
    },
    broadcast() {
      if (!clients.size) return;
      const payload = trafficSnapshot(store.data);
      for (const socket of clients) writeWebSocket(socket, payload);
    },
    close() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      for (const socket of clients) socket.destroy();
      clients.clear();
    }
  };
}

function createAgentControlHub(store, realtime = {}) {
  const sockets = new Map();

  const markRunningAndSend = async (agentId, commandId) => {
    const socket = sockets.get(agentId);
    if (!socket || socket.destroyed || socket.writableEnded) return false;
    let outgoing = null;
    await store.update((draft) => {
      const command = draft.commands.find((item) => item.id === commandId && item.status === 'queued');
      const agent = draft.agents.find((item) => item.id === agentId);
      const node = draft.nodes.find((item) => item.id === command?.nodeId && item.id === agent?.nodeId);
      if (!command || !agent || !node) return;
      command.status = 'running';
      command.agentId = agentId;
      command.updatedAt = nowIso();
      appendCommandEvent(draft, command, {
        type: 'state',
        stream: 'state',
        agentId,
        message: `已通过控制通道推送 ${command.type}`,
        payload: { status: 'running', type: command.type, transport: 'websocket' }
      });
      outgoing = presentAgentCommand(command, node);
    });
    if (!outgoing) return false;
    writeWebSocket(socket, { type: 'command', command: outgoing, time: nowIso() });
    return true;
  };

  const flushQueued = async (agentId) => {
    const agent = store.data.agents.find((item) => item.id === agentId);
    if (!agent) return;
    const commandIds = store.data.commands
      .filter((command) => command.nodeId === agent.nodeId && command.status === 'queued')
      .map((command) => command.id);
    for (const commandId of commandIds) await markRunningAndSend(agentId, commandId);
  };

  const handleMessage = async (agentId, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const type = String(message.type || '').trim();
    if (type === 'hello' || type === 'heartbeat') {
      await store.update((draft) => {
        const agent = draft.agents.find((item) => item.id === agentId);
        const node = draft.nodes.find((item) => item.id === agent?.nodeId);
        if (!agent || !node) return;
        updateNodeFromAgent(draft, node, agent, {
          version: message.version,
          platform: message.platform,
          arch: message.arch,
          installDir: message.installDir,
          serviceMode: message.serviceMode,
          addresses: message.addresses
        });
      });
      realtime.broadcastTraffic?.();
      return;
    }

    if (type === 'command.event' || type === 'event') {
      const commandId = String(message.commandId || '').trim();
      if (!commandId) return;
      await store.update((draft) => {
        const command = draft.commands.find((item) => item.id === commandId && item.agentId === agentId);
        if (!command) return;
        appendCommandEvent(draft, command, {
          agentId,
          type: message.event?.type || message.stream || message.kind || 'progress',
          stream: message.event?.stream || message.stream || message.kind || 'progress',
          message: message.event?.message || message.message || '',
          payload: message.event?.payload || message.payload || {},
          sequence: message.event?.sequence || message.sequence
        });
        command.updatedAt = nowIso();
      });
      return;
    }

    if (type === 'command.result' || type === 'result') {
      const commandId = String(message.commandId || '').trim();
      if (!commandId) return;
      await store.update((draft) => {
        const command = draft.commands.find((item) => item.id === commandId && item.agentId === agentId);
        if (!command) return;
        command.status = message.status === 'failed' ? 'failed' : 'succeeded';
        command.result = message.result || message;
        applyCommandResultSideEffects(draft, command, command.result);
        appendCommandEvent(draft, command, {
          type: command.status === 'failed' ? 'error' : 'result',
          stream: command.status === 'failed' ? 'stderr' : 'result',
          agentId,
          message: command.status === 'failed' ? commandResultMessage(command.result) : '命令执行成功',
          payload: { status: command.status, result: command.result, transport: 'websocket' }
        });
        appendCommandEvent(draft, command, {
          type: 'state',
          stream: 'state',
          agentId,
          message: command.status,
          payload: { status: command.status, transport: 'websocket' }
        });
        command.updatedAt = nowIso();
      });
      realtime.broadcastTraffic?.();
    }
  };

  return {
    add(agent, socket) {
      sockets.set(agent.id, socket);
      writeWebSocket(socket, { type: 'hello', transport: 'websocket', time: nowIso() });
      flushQueued(agent.id);
      socket.on('data', (chunk) => {
        readWebSocketFrames(socket, chunk, (text) => {
          void handleMessage(agent.id, text);
        });
      });
      socket.on('close', () => {
        if (sockets.get(agent.id) === socket) sockets.delete(agent.id);
      });
      socket.on('error', () => {
        if (sockets.get(agent.id) === socket) sockets.delete(agent.id);
      });
    },
    async dispatchCommand(commandId) {
      const command = store.data.commands.find((item) => item.id === commandId && item.status === 'queued');
      if (!command) return false;
      const agent = store.data.agents.find((item) => item.nodeId === command.nodeId && sockets.has(item.id));
      if (!agent) return false;
      return markRunningAndSend(agent.id, command.id);
    },
    onlineAgentIds() {
      return [...sockets.keys()];
    },
    close() {
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
    }
  };
}

function handleTrafficUpgrade(req, socket, store, trafficHub) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  if (url.pathname !== '/api/v1/traffic/stream') return closeUpgrade(socket, 404, 'Not Found');
  if (!requireUser(req, store.data, url)) return closeUpgrade(socket, 403, 'Forbidden');
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return closeUpgrade(socket, 400, 'Bad Request');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '\r\n'
    ].join('\r\n')
  );
  trafficHub.add(socket);
}

function handleAgentControlUpgrade(req, socket, store, agentControlHub) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  const segments = url.pathname.split('/').filter(Boolean);
  if (!(segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3] && segments[4] === 'control' && segments[5] === 'stream')) {
    return closeUpgrade(socket, 404, 'Not Found');
  }
  const agentId = segments[3];
  const agent = requireAgent(req, store.data, agentId, url);
  if (!agent) return closeUpgrade(socket, 403, 'Forbidden');
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return closeUpgrade(socket, 400, 'Bad Request');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '\r\n'
    ].join('\r\n')
  );
  agentControlHub.add(agent, socket);
}

function handleWebSocketUpgrade(req, socket, store, trafficHub, agentControlHub) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  if (url.pathname === '/api/v1/traffic/stream') return handleTrafficUpgrade(req, socket, store, trafficHub);
  if (/^\/api\/v1\/agents\/[^/]+\/control\/stream$/.test(url.pathname)) return handleAgentControlUpgrade(req, socket, store, agentControlHub);
  return closeUpgrade(socket, 404, 'Not Found');
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.normalize(path.join(WEB_DIST_DIR, rel));
  if (!target.startsWith(WEB_DIST_DIR)) return forbidden(res);

  try {
    const info = await stat(target);
    if (info.isDirectory()) return notFound(res);
    const type = mimeType(target);
    res.writeHead(200, { 'content-type': type, 'cache-control': type.includes('html') ? 'no-store' : 'public, max-age=31536000, immutable' });
    createReadStream(target).pipe(res);
  } catch (error) {
    if (pathname.startsWith('/assets/')) return notFound(res);
    try {
      const html = await readFile(WEB_INDEX_FILE, 'utf8');
      sendText(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    } catch {
      sendText(res, 200, '<!doctype html><title>PulseDeck</title><body>PulseDeck web build is not available.</body>', {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
    }
  }
}

function mimeType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function handleApi(req, res, store, url, realtime = {}) {
  const data = store.data;
  const method = req.method || 'GET';
  const segments = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && url.pathname === '/api/v1/health') {
    return sendJson(res, 200, {
      status: 'ok',
      name: 'PulseDeck',
      version: APP_VERSION,
      agentVersion: AGENT_VERSION,
      port: PORT,
      time: nowIso()
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/auth/login') {
    const body = await readJson(req);
    const username = body.username ?? body.userName;
    if (username !== ADMIN_USER || body.password !== ADMIN_PASSWORD) {
      return forbidden(res, 'invalid username or password');
    }
    const token = randomToken(32);
    const refreshToken = randomToken(32);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await store.update((draft) => {
      draft.sessions = draft.sessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
      draft.sessions.push({ token, refreshToken, user: ADMIN_USER, createdAt: nowIso(), expiresAt });
    });
    if (body.userName !== undefined) {
      return sendSoy(res, { token, refreshToken });
    }
    return sendJson(res, 200, { token, expiresAt, user: { username: ADMIN_USER } });
  }

  if (method === 'GET' && url.pathname === '/api/v1/auth/getUserInfo') {
    const session = requireUser(req, data, url);
    if (!session) return sendJson(res, 200, { code: '8888', msg: 'authentication required', data: null });
    return sendSoy(res, {
      userId: 'admin',
      userName: session.user || ADMIN_USER,
      roles: ['R_SUPER'],
      buttons: ['*']
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/auth/refreshToken') {
    const body = await readJson(req);
    const session = data.sessions.find((item) => item.refreshToken === body.refreshToken);
    if (!session) return sendJson(res, 200, { code: '8888', msg: 'invalid refresh token', data: null });
    const token = randomToken(32);
    const refreshToken = randomToken(32);
    await store.update((draft) => {
      const draftSession = draft.sessions.find((item) => item.refreshToken === body.refreshToken);
      if (!draftSession) return;
      draftSession.token = token;
      draftSession.refreshToken = refreshToken;
      draftSession.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    });
    return sendSoy(res, { token, refreshToken });
  }

  if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3] === 'runtime' && segments[4] === 'manifest') {
    const target = segments[5] ? decodeURIComponent(segments[5]) : '';
    if (target) {
      if (!validAgentRuntimeTarget(target)) return badRequest(res, 'invalid agent target');
      return sendJson(res, 200, agentRuntimeMetadata(target, req));
    }
    return sendJson(res, 200, {
      appVersion: APP_VERSION,
      agentVersion: AGENT_VERSION,
      generatedAt: nowIso(),
      targets: AGENT_RUNTIME_TARGETS.map((item) => agentRuntimeMetadata(item, req))
    });
  }

  if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3] === 'runtime' && segments[4]) {
    const target = decodeURIComponent(segments[4]);
    if (!validAgentRuntimeTarget(target)) return badRequest(res, 'invalid agent target');
    const runtimeFile = agentRuntimeFile(target);
    const metadata = agentRuntimeMetadata(target, req);
    try {
      await stat(runtimeFile);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(metadata.sizeBytes),
      'x-pulsedeck-agent-version': metadata.version,
      'x-pulsedeck-agent-sha256': metadata.sha256
    });
    createReadStream(runtimeFile).pipe(res);
    return;
  }

  if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3] === 'install' && segments[4]) {
    const installId = decodeURIComponent(segments[4]);
    const node = data.nodes.find((item) => item.installId === installId);
    if (!node) return notFound(res);
    return sendText(res, 200, renderAgentInstallScript({ baseUrl: publicBaseUrl(req), installId }), {
      'content-type': 'application/x-sh; charset=utf-8',
      'cache-control': 'no-store'
    });
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3] === 'enroll' && segments[4]) {
    const installId = decodeURIComponent(segments[4]);
    const body = await readJson(req);
    let response;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.installId === installId);
      if (!node) return;
      let agent = draft.agents.find((item) => item.nodeId === node.id);
      if (!agent) {
        agent = {
          id: randomUUID(),
          nodeId: node.id,
          token: randomToken(32),
          version: body.version || 'unknown',
          platform: body.platform || 'unknown',
          arch: body.arch || 'unknown',
          installDir: body.installDir || '',
          serviceMode: body.serviceMode || 'unknown',
          lastSeenAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        draft.agents.push(agent);
      }
      updateNodeFromAgent(draft, node, agent, {
        version: body.version,
        platform: body.platform,
        arch: body.arch,
        installDir: body.installDir,
        serviceMode: body.serviceMode,
        addresses: addressesFromAgent(body.addresses, req)
      });
      response = {
        agentId: agent.id,
        token: agent.token,
        node: { id: node.id, name: node.name, region: node.region },
        endpoints: {
          heartbeat: `/api/v1/agents/${agent.id}/heartbeat`,
          metrics: `/api/v1/agents/${agent.id}/metrics`,
          diagnostics: `/api/v1/agents/${agent.id}/diagnostics`,
          commands: `/api/v1/agents/${agent.id}/commands`,
          controlStream: `/api/v1/agents/${agent.id}/control/stream`
        }
      };
    });
    if (!response) return notFound(res);
    await dispatchPendingAlertEvents(store);
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, response);
  }

  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'agents' && segments[3]) {
    const agentId = segments[3];
    const agent = requireAgent(req, data, agentId, url);
    if (!agent) return forbidden(res, 'invalid agent token');
    const node = data.nodes.find((item) => item.id === agent.nodeId);
    if (!node) return notFound(res);

    if (method === 'POST' && segments[4] === 'heartbeat') {
      const body = await readJson(req);
      await store.update((draft) => {
        const draftAgent = draft.agents.find((item) => item.id === agentId);
        const draftNode = draft.nodes.find((item) => item.id === draftAgent?.nodeId);
        if (draftAgent && draftNode) {
          updateNodeFromAgent(draft, draftNode, draftAgent, {
            ...body,
            addresses: addressesFromAgent(body.addresses, req)
          });
        }
      });
      await dispatchPendingAlertEvents(store);
      realtime.broadcastTraffic?.();
      return sendJson(res, 200, { accepted: true, time: nowIso() });
    }

    if (method === 'POST' && segments[4] === 'metrics') {
      const body = await readJson(req);
      await store.update((draft) => {
        const draftAgent = draft.agents.find((item) => item.id === agentId);
        const draftNode = draft.nodes.find((item) => item.id === draftAgent?.nodeId);
        if (draftAgent && draftNode) {
          updateNodeFromAgent(draft, draftNode, draftAgent, {
            metrics: body.metrics || body,
            addresses: addressesFromAgent(body.addresses, req),
            reportedLinks: body.reportedLinks
          });
        }
      });
      await dispatchPendingAlertEvents(store);
      realtime.broadcastTraffic?.();
      return sendJson(res, 200, { accepted: true });
    }

    if (method === 'POST' && segments[4] === 'diagnostics') {
      const body = await readJson(req);
      await store.update((draft) => {
        const draftAgent = draft.agents.find((item) => item.id === agentId);
        const draftNode = draft.nodes.find((item) => item.id === draftAgent?.nodeId);
        if (draftAgent && draftNode) updateNodeFromAgent(draft, draftNode, draftAgent, { diagnostics: body });
      });
      await dispatchPendingAlertEvents(store);
      realtime.broadcastTraffic?.();
      return sendJson(res, 200, { accepted: true });
    }

    if (method === 'GET' && segments[4] === 'commands') {
      const commands = data.commands.filter((command) => command.nodeId === node.id && command.status === 'queued');
      await store.update((draft) => {
        for (const command of draft.commands) {
          if (commands.some((item) => item.id === command.id)) {
            command.status = 'running';
            command.agentId = agentId;
            command.updatedAt = nowIso();
            appendCommandEvent(draft, command, {
              type: 'state',
              stream: 'state',
              agentId,
              message: `执行中 ${command.type}`,
              payload: { status: 'running', type: command.type }
            });
          }
        }
      });
      return sendJson(res, 200, { items: commands.map((command) => presentAgentCommand(command, node)) });
    }

    if (method === 'POST' && segments[4] === 'commands' && segments[5] && segments[6] === 'events') {
      const commandId = segments[5];
      const body = await readJson(req);
      let found = false;
      let event;
      await store.update((draft) => {
        const command = draft.commands.find((item) => item.id === commandId && item.agentId === agentId);
        if (!command) return;
        found = true;
        event = appendCommandEvent(draft, command, {
          agentId,
          type: body.type || body.stream || 'progress',
          stream: body.stream || body.type || 'progress',
          message: body.message || '',
          payload: body.payload || {},
          sequence: body.sequence
        });
        command.updatedAt = nowIso();
      });
      if (!found) return notFound(res);
      return sendJson(res, 202, { accepted: true, event });
    }

    if (method === 'POST' && segments[4] === 'commands' && segments[5] && segments[6] === 'result') {
      const commandId = segments[5];
      const body = await readJson(req);
      let found = false;
      await store.update((draft) => {
        const command = draft.commands.find((item) => item.id === commandId && item.agentId === agentId);
        if (!command) return;
        found = true;
        command.status = body.status === 'failed' ? 'failed' : 'succeeded';
        command.result = body.result || body;
        applyCommandResultSideEffects(draft, command, command.result);
        appendCommandEvent(draft, command, {
          type: command.status === 'failed' ? 'error' : 'result',
          stream: command.status === 'failed' ? 'stderr' : 'result',
          agentId,
          message: command.status === 'failed' ? commandResultMessage(command.result) : '命令执行成功',
          payload: { status: command.status, result: command.result }
        });
        appendCommandEvent(draft, command, {
          type: 'state',
          stream: 'state',
          agentId,
          message: command.status,
          payload: { status: command.status }
        });
        command.updatedAt = nowIso();
      });
      if (!found) return notFound(res);
      return sendJson(res, 200, { accepted: true });
    }
  }

  if (segments[0] === 'sub' && segments[1] && method === 'GET') {
    const profile = data.subscriptionProfiles.find((item) => item.token === segments[1]);
    if (!profile) return notFound(res);
    return sendText(res, 200, renderSubscription(data, profile), TEXT_HEADERS);
  }

  const session = requireUser(req, data, url);
  if (!session) return forbidden(res, 'authentication required');

  if (method === 'GET' && url.pathname === '/api/v1/dashboard') {
    return sendJson(res, 200, dashboard(data));
  }

  if (method === 'GET' && url.pathname === '/api/v1/protocols') {
    return sendJson(res, 200, { items: SUPPORTED_PROXY_PROTOCOLS });
  }

  if (method === 'GET' && url.pathname === '/api/v1/geoip/lookup') {
    const ip = String(url.searchParams.get('ip') || '').trim();
    if (!net.isIP(ip)) return badRequest(res, 'invalid ip');
    return sendJson(res, 200, { ip, ...detectGeoRegion(ip) });
  }

  if (method === 'GET' && url.pathname === '/api/v1/geosite/lookup') {
    const domain = String(url.searchParams.get('domain') || '').trim();
    const result = lookupGeosite(domain);
    if (result.source === 'geosite-invalid') return badRequest(res, 'invalid domain');
    return sendJson(res, 200, result);
  }

  if (method === 'GET' && url.pathname === '/api/v1/nodes') {
    return sendJson(res, 200, {
      items: orderedNodes(data.nodes).map((node) => presentNode(node, req, data))
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes') {
    const body = await readJson(req);
    let node;
    await store.update((draft) => {
      node = createNode(body);
      node.order = Math.max(0, ...draft.nodes.map((item) => Number(item.order) || 0)) + 1;
      draft.nodes.push(node);
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 201, presentNode(node, req, store.data));
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes/reorder') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)).filter(Boolean) : [];
    if (!ids.length) return badRequest(res, 'ids is required');
    await store.update((draft) => {
      const order = new Map(ids.map((id, index) => [id, index + 1]));
      for (const node of draft.nodes) {
        if (order.has(node.id)) node.order = order.get(node.id);
      }
    });
    return sendJson(res, 200, { updated: true, items: orderedNodes(store.data.nodes).map((node) => presentNode(node, req, store.data)) });
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes/batch-command') {
    const body = await readJson(req);
    const nodeIds = Array.isArray(body.nodeIds) ? [...new Set(body.nodeIds.map((id) => String(id)).filter(Boolean))] : [];
    const type = String(body.type || 'probe').trim() || 'probe';
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
    if (!nodeIds.length) return badRequest(res, 'nodeIds is required');
    const commands = [];
    await store.update((draft) => {
      for (const nodeId of nodeIds) {
        if (!draft.nodes.some((node) => node.id === nodeId)) continue;
        commands.push(createCommand(draft, nodeId, type, payload));
      }
    });
    for (const command of commands) await realtime.dispatchCommand?.(command.id);
    return sendJson(res, 201, { queued: commands.length, items: commands });
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes/batch-delete') {
    const body = await readJson(req);
    const nodeIds = Array.isArray(body.nodeIds) ? [...new Set(body.nodeIds.map((id) => String(id)).filter(Boolean))] : [];
    if (!nodeIds.length) return badRequest(res, 'nodeIds is required');
    let summary;
    await store.update((draft) => {
      summary = purgeNodes(draft, nodeIds);
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, { deleted: true, ...summary });
  }

  if (method === 'GET' && url.pathname === '/api/v1/traffic/history') {
    return sendJson(res, 200, {
      items: trafficHistoryItems(data, {
        nodeId: url.searchParams.get('nodeId'),
        since: url.searchParams.get('since'),
        limit: url.searchParams.get('limit')
      })
    });
  }

  if (method === 'GET' && url.pathname === '/api/v1/traffic/rank') {
    return sendJson(res, 200, {
      mode: trafficLimitMode(url.searchParams.get('mode') || 'total'),
      items: trafficRank(data, {
        mode: url.searchParams.get('mode'),
        limit: url.searchParams.get('limit')
      })
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/traffic/reset') {
    const body = await readJson(req);
    const nodeIds = Array.isArray(body.nodeIds) ? [...new Set(body.nodeIds.map((id) => String(id)).filter(Boolean))] : [];
    let reset = 0;
    await store.update((draft) => {
      for (const node of draft.nodes) {
        if (nodeIds.length && !nodeIds.includes(node.id)) continue;
        resetNodeTraffic(draft, node, 'manual-reset');
        reset += 1;
      }
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, { reset });
  }

  if ((method === 'PUT' || method === 'PATCH') && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && !segments[4]) {
    const nodeId = segments[3];
    const body = await readJson(req);
    let node;
    await store.update((draft) => {
      node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      if (body.name !== undefined) node.name = String(body.name).trim() || node.name;
      if (body.region !== undefined) {
        node.region = String(body.region).trim();
        node.regionOverride = Boolean(node.region);
        node.network = { ...(node.network || {}), regionSource: node.region ? 'manual' : 'auto-pending' };
      }
      if (body.group !== undefined) node.group = String(body.group).trim();
      if (body.order !== undefined && Number.isFinite(Number(body.order))) node.order = Number(body.order);
      if (Array.isArray(body.tags)) node.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean);
      if (body.subscriptionEnabled !== undefined) node.subscriptionEnabled = body.subscriptionEnabled === true;
      if (body.traffic && typeof body.traffic === 'object') {
        node.traffic = {
          ...(node.traffic || {}),
          ...(body.traffic.thresholdBytes !== undefined ? { thresholdBytes: Number(body.traffic.thresholdBytes) || 0 } : {}),
          ...(body.traffic.limitMode !== undefined ? { limitMode: trafficLimitMode(body.traffic.limitMode) } : {}),
          ...(body.traffic.warningPercent !== undefined ? { warningPercent: Number(body.traffic.warningPercent) || 80 } : {}),
          ...(body.traffic.autoDisableSubscription !== undefined ? { autoDisableSubscription: body.traffic.autoDisableSubscription === true } : {}),
          ...(body.traffic.resetMode !== undefined && ['none', 'daily', 'weekly', 'monthly', 'interval'].includes(body.traffic.resetMode)
            ? { resetMode: body.traffic.resetMode }
            : {}),
          ...(body.traffic.resetDay !== undefined ? { resetDay: Math.min(Math.max(Number(body.traffic.resetDay) || 1, 1), 31) } : {}),
          ...(body.traffic.resetIntervalDays !== undefined
            ? { resetIntervalDays: Math.min(Math.max(Number(body.traffic.resetIntervalDays) || 30, 1), 365) }
            : {}),
          ...(body.traffic.resetAnchorAt !== undefined ? { resetAnchorAt: body.traffic.resetAnchorAt || null } : {})
        };
      }
      if (body.alertPolicy && typeof body.alertPolicy === 'object') {
        node.alertPolicy = { ...(node.alertPolicy || {}), ...body.alertPolicy };
      }
      node.updatedAt = nowIso();
    });
    if (!node) return notFound(res);
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, presentNode(node, req, store.data));
  }

  if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && !segments[4]) {
    const nodeId = segments[3];
    const node = data.nodes.find((item) => item.id === nodeId);
    if (!node) return notFound(res);
    let summary;
    await store.update((draft) => {
      summary = purgeNodes(draft, [nodeId]);
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, { deleted: true, ...summary });
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && segments[4] === 'links' && segments[5] === 'reset') {
    const nodeId = segments[3];
    let command;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      node.linkSecret = randomToken(18);
      node.reportedLinks = [];
      node.updatedAt = nowIso();
      command = createCommand(draft, nodeId, 'reset-links', { linkSecret: node.linkSecret });
    });
    if (!command) return notFound(res);
    realtime.broadcastTraffic?.();
    await realtime.dispatchCommand?.(command.id);
    return sendJson(res, 201, command);
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && segments[4] === 'protocols') {
    const nodeId = segments[3];
    const body = await readJson(req);
    let protocol;
    let command;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      protocol = createNodeProtocol(body);
      node.protocols ||= [];
      node.protocols.push(protocol);
      node.updatedAt = nowIso();
      command = createCommand(draft, nodeId, 'protocol-add', { protocol });
    });
    if (!protocol) return notFound(res);
    realtime.broadcastTraffic?.();
    await realtime.dispatchCommand?.(command.id);
    return sendJson(res, 201, { protocol, command });
  }

  if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && segments[4] === 'protocols' && segments[5]) {
    const nodeId = segments[3];
    const protocolId = segments[5];
    let protocol;
    let command;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      protocol = (node.protocols || []).find((item) => item.id === protocolId);
      if (!protocol) return;
      node.protocols = node.protocols.filter((item) => item.id !== protocolId);
      node.updatedAt = nowIso();
      command = createCommand(draft, nodeId, 'protocol-delete', { protocolId, protocol });
    });
    if (!protocol) return notFound(res);
    realtime.broadcastTraffic?.();
    await realtime.dispatchCommand?.(command.id);
    return sendJson(res, 200, { deleted: true, protocol, command });
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && segments[4] === 'commands') {
    const nodeId = segments[3];
    const body = await readJson(req);
    let command;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      command = createCommand(draft, nodeId, body.type || 'probe', body.payload || {});
    });
    if (!command) return notFound(res);
    await realtime.dispatchCommand?.(command.id);
    return sendJson(res, 201, command);
  }

  if (method === 'GET' && url.pathname === '/api/v1/commands') {
    return sendJson(res, 200, {
      items: data.commands
        .slice()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    });
  }

  if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'commands' && segments[3] && segments[4] === 'events') {
    const commandId = segments[3];
    const command = data.commands.find((item) => item.id === commandId);
    if (!command) return notFound(res);
    if (url.searchParams.get('format') === 'json') {
      return sendJson(res, 200, { items: commandEvents(data, commandId) });
    }
    return sendCommandEventsSse(req, res, store, commandId);
  }

  if (method === 'GET' && url.pathname === '/api/v1/alert-events') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    return sendJson(res, 200, {
      items: (data.alertEvents || [])
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/alerts/check') {
    let summary;
    await store.update((draft) => {
      summary = evaluateOfflineAlerts(draft);
    });
    await dispatchPendingAlertEvents(store);
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, { ...summary, items: summary.createdEvents > 0 ? store.data.alertEvents.slice(-summary.createdEvents) : [] });
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'alert-events' && segments[3] && segments[4] === 'ack') {
    const eventId = segments[3];
    let event;
    await store.update((draft) => {
      event = (draft.alertEvents || []).find((item) => item.id === eventId);
      if (!event) return;
      event.acknowledgedAt = nowIso();
      event.updatedAt = event.acknowledgedAt;
      refreshAlertStatus(event);
    });
    if (!event) return notFound(res);
    return sendJson(res, 200, event);
  }

  if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'alert-events' && segments[3] && !segments[4]) {
    const eventId = segments[3];
    const event = (data.alertEvents || []).find((item) => item.id === eventId);
    if (!event) return notFound(res);
    await store.update((draft) => {
      draft.alertEvents = (draft.alertEvents || []).filter((item) => item.id !== eventId);
    });
    return sendJson(res, 200, { deleted: true });
  }

  if (method === 'GET' && url.pathname === '/api/v1/subscription-profiles') {
    return sendJson(res, 200, { items: data.subscriptionProfiles.map((profile) => presentProfile(profile, req)) });
  }

  if (method === 'POST' && url.pathname === '/api/v1/subscription-profiles') {
    const body = await readJson(req);
    const format = ['raw', 'clash', 'v2ray'].includes(body.format) ? body.format : 'raw';
    let profile;
    await store.update((draft) => {
      profile = {
        id: randomUUID(),
        name: String(body.name || '自定义订阅').trim() || '自定义订阅',
        format,
        enabled: body.enabled !== false,
        protected: false,
        description: String(body.description || '').trim(),
        filters: normalizeSubscriptionFilters(body.filters),
        linkPrefixMode: normalizeLinkPrefixMode(body.linkPrefixMode),
        token: randomToken(18),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      draft.subscriptionProfiles.push(profile);
    });
    return sendJson(res, 201, presentProfile(profile, req));
  }

  if ((method === 'PUT' || method === 'PATCH') && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'subscription-profiles' && segments[3]) {
    const profileId = segments[3];
    const body = await readJson(req);
    let profile;
    await store.update((draft) => {
      profile = draft.subscriptionProfiles.find((item) => item.id === profileId);
      if (!profile) return;
      if (body.name !== undefined) profile.name = String(body.name).trim() || profile.name;
      if (body.description !== undefined) profile.description = String(body.description).trim();
      if (body.enabled !== undefined) profile.enabled = body.enabled === true;
      if (body.format !== undefined && !profile.protected && ['raw', 'clash', 'v2ray'].includes(body.format)) profile.format = body.format;
      if (body.filters !== undefined) profile.filters = normalizeSubscriptionFilters(body.filters);
      if (body.linkPrefixMode !== undefined) profile.linkPrefixMode = normalizeLinkPrefixMode(body.linkPrefixMode);
      profile.updatedAt = nowIso();
    });
    if (!profile) return notFound(res);
    return sendJson(res, 200, presentProfile(profile, req));
  }

  if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'subscription-profiles' && segments[3]) {
    const profileId = segments[3];
    const profile = data.subscriptionProfiles.find((item) => item.id === profileId);
    if (!profile) return notFound(res);
    if (profile.protected) return conflict(res, 'default subscription profiles are protected; disable them instead');
    await store.update((draft) => {
      draft.subscriptionProfiles = draft.subscriptionProfiles.filter((item) => item.id !== profileId);
    });
    return sendJson(res, 200, { deleted: true });
  }

  if (method === 'GET' && url.pathname === '/api/v1/notification-channels') {
    return sendJson(res, 200, {
      telegram: maskChannel(data.notificationChannels.telegram),
      email: maskChannel(data.notificationChannels.email)
    });
  }

  if ((method === 'PUT' || method === 'PATCH') && url.pathname === '/api/v1/notification-channels') {
    const body = await readJson(req);
    let channels;
    await store.update((draft) => {
      if (body.telegram) {
        const nextTelegram = { ...body.telegram };
        if (nextTelegram.botToken === 'configured') delete nextTelegram.botToken;
        draft.notificationChannels.telegram = { ...draft.notificationChannels.telegram, ...nextTelegram };
      }
      if (body.email) {
        const nextEmail = { ...body.email };
        if (nextEmail.password === 'configured') delete nextEmail.password;
        draft.notificationChannels.email = { ...draft.notificationChannels.email, ...nextEmail };
      }
      channels = draft.notificationChannels;
    });
    return sendJson(res, 200, {
      telegram: maskChannel(channels.telegram),
      email: maskChannel(channels.email)
    });
  }

  if (method === 'GET' && url.pathname === '/api/v1/alert-policy') {
    return sendJson(res, 200, data.alertPolicy || {});
  }

  if ((method === 'PUT' || method === 'PATCH') && url.pathname === '/api/v1/alert-policy') {
    const body = await readJson(req);
    let policy;
    await store.update((draft) => {
      const nextAction = ['keep-node', 'disable-node-subscription', 'disable-all-subscriptions'].includes(body.trafficLimitAction)
        ? body.trafficLimitAction
        : body.autoDisableOnTrafficLimit === false
          ? 'keep-node'
          : body.autoDisableOnTrafficLimit === true
            ? 'disable-node-subscription'
            : undefined;
      draft.alertPolicy = {
        ...(draft.alertPolicy || {}),
        ...(body.offlineAfterSeconds !== undefined ? { offlineAfterSeconds: Number(body.offlineAfterSeconds) || 180 } : {}),
        ...(Array.isArray(body.offlineChannels) ? { offlineChannels: body.offlineChannels.map((item) => String(item)).filter(Boolean) } : {}),
        ...(Array.isArray(body.trafficChannels) ? { trafficChannels: body.trafficChannels.map((item) => String(item)).filter(Boolean) } : {}),
        ...(body.autoDisableOnTrafficLimit !== undefined ? { autoDisableOnTrafficLimit: body.autoDisableOnTrafficLimit === true } : {}),
        ...(nextAction ? { trafficLimitAction: nextAction } : {})
      };
      policy = draft.alertPolicy;
    });
    return sendJson(res, 200, policy);
  }

  return notFound(res);
}

export async function createPulseDeckServer(options = {}) {
  const store = options.store || new JsonStore(options.dataFile);
  await store.load();
  const trafficHub = createTrafficHub(store);
  const agentControlHub = createAgentControlHub(store, { broadcastTraffic: () => trafficHub.broadcast() });

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/')) {
        await handleApi(req, res, store, url, {
          broadcastTraffic: () => trafficHub.broadcast(),
          dispatchCommand: (commandId) => agentControlHub.dispatchCommand(commandId)
        });
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error instanceof SyntaxError) return badRequest(res, 'invalid json body');
      sendJson(res, 500, { detail: error.message || 'internal server error' });
    }
  });
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket, store, trafficHub, agentControlHub));
  server.on('close', () => {
    trafficHub.close();
    agentControlHub.close();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await createPulseDeckServer();
  server.listen(PORT, HOST, () => {
    console.log(`PulseDeck panel listening on http://${HOST}:${PORT}`);
  });
}
