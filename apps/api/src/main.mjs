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
const APP_VERSION = process.env.PULSEDECK_VERSION || '0.2.4';
const AGENT_VERSION = process.env.PULSEDECK_AGENT_VERSION || `${APP_VERSION}-rust`;
const AGENT_RUNTIME_TARGETS = ['linux-x64', 'linux-arm64', 'linux-armv7l'];
const ADMIN_USER = process.env.PULSEDECK_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.PULSEDECK_ADMIN_PASSWORD || 'change-me';

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
    deletable: profile.protected !== true,
    publicUrl: `${base}/sub/${profile.token}`
  };
}

function presentNode(node, req, data) {
  return {
    ...node,
    online: isNodeOnline(node, data),
    displayRegion: displayRegion(node),
    installCommand: `curl -fsSL '${publicBaseUrl(req)}/api/v1/agents/install/${encodeURIComponent(node.installId)}' | sh`
  };
}

function displayRegion(node) {
  if (node.region) return node.region;
  if (node.network?.detectedRegion) return node.network.detectedRegion;
  const source = node.network?.regionSource || '';
  if (source === 'geoip-empty') return 'GeoIP 未配置';
  if (source === 'geoip-miss') return 'GeoIP 未命中';
  if (node.network?.primaryIpv4 || node.network?.primaryIpv6) return '待手动设置区域';
  return '等待 Agent 上报';
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

function average(values) {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function clientAddress(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
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
    cidr: item.cidr ? String(item.cidr).trim() : ''
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
      cidr: ''
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
  const publicIpv4 = publicAddresses.find((item) => item.family === 'ipv4') || null;
  const publicIpv6 = publicAddresses.find((item) => item.family === 'ipv6') || null;
  const anyIpv4 = normalized.find((item) => item.family === 'ipv4') || null;
  const anyIpv6 = normalized.find((item) => item.family === 'ipv6') || null;
  const warpLikely = normalized.some((item) => /warp|wgcf|cloudflare|wireguard|^wg/i.test(item.interface)) || (!publicIpv4 && anyIpv4 && publicIpv6);
  const primaryIpv4 = publicIpv4?.address || anyIpv4?.address || null;
  const primaryIpv6 = publicIpv6?.address || anyIpv6?.address || null;
  let ipMode = 'unknown';
  if (warpLikely && anyIpv4 && publicIpv6) ipMode = 'warp-v4-ipv6';
  else if (publicIpv4 && publicIpv6) ipMode = 'dual-stack';
  else if (publicIpv4) ipMode = 'ipv4-only';
  else if (publicIpv6) ipMode = 'ipv6-only';
  else if (anyIpv4 && anyIpv6) ipMode = 'private-dual-stack';
  else if (anyIpv4) ipMode = 'private-ipv4';
  else if (anyIpv6) ipMode = 'private-ipv6';

  const lookupIp = publicIpv4?.address || publicIpv6?.address || '';
  const geo = lookupIp ? detectGeoRegion(lookupIp) : { region: '', countryCode: '', city: '', source: 'auto-pending' };
  return {
    primaryIpv4,
    primaryIpv6,
    ipMode,
    publicAddresses,
    warpLikely,
    detectedRegion: geo.region,
    regionSource: geo.source,
    updatedAt: nowIso()
  };
}

function applyNetworkDiscovery(node, addresses) {
  if (!Array.isArray(addresses)) return;
  const normalized = addresses.map(normalizeAddressItem).filter(Boolean);
  node.addresses = normalized;
  const analysis = analyzeAddresses(normalized);
  node.network = { ...(node.network || {}), ...analysis };
  if (!node.regionOverride && analysis.detectedRegion) {
    node.region = analysis.detectedRegion;
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
      detail: ready ? 'Telegram channel configured' : 'Telegram channel is disabled or incomplete',
      updatedAt: timestamp
    };
  }
  if (channel === 'email') {
    const config = data.notificationChannels?.email || {};
    const ready = config.enabled === true && Boolean(config.smtpHost) && Boolean(config.from) && Boolean(config.to);
    return {
      channel,
      status: ready ? 'pending' : 'skipped',
      detail: ready ? 'SMTP channel configured' : 'Email channel is disabled or incomplete',
      updatedAt: timestamp
    };
  }
  return {
    channel,
    status: 'skipped',
    detail: 'Unknown notification channel',
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
  const level = event.level === 'critical' ? 'CRITICAL' : event.level === 'warning' ? 'WARNING' : 'INFO';
  return `[PulseDeck] ${level} ${event.type || 'alert'}`;
}

function alertBody(event) {
  return [
    alertSubject(event),
    '',
    event.message || '',
    event.nodeId ? `Node: ${event.nodeId}` : '',
    event.createdAt ? `Time: ${event.createdAt}` : ''
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
        detail: changed ? 'Node subscription output disabled' : 'Node subscription output was already disabled',
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
        detail: 'Node subscription output disabled',
        updatedAt: timestamp
      },
      {
        type: 'disable-all-subscriptions',
        status: disabledProfiles.length ? 'completed' : 'skipped',
        detail: disabledProfiles.length ? `Disabled ${disabledProfiles.length} subscription profiles` : 'All subscription profiles were already disabled',
        profileIds: disabledProfiles,
        updatedAt: timestamp
      }
    ];
  }
  return [
    {
      type: 'keep-node',
      status: 'skipped',
      detail: 'Traffic limit action is disabled',
      updatedAt: timestamp
    }
  ];
}

function updateTrafficAccounting(data, node, metrics) {
  const current = metricsTraffic(metrics);
  if (!current.rx && !current.tx) return;
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
  const threshold = Number(traffic.thresholdBytes) || 0;
  node.alertState ||= {};
  const warningPercent = Math.min(Math.max(Number(traffic.warningPercent) || 80, 1), 100);
  const warningBytes = threshold > 0 ? Math.floor((threshold * warningPercent) / 100) : 0;
  if (warningBytes > 0 && traffic.totalBytes >= warningBytes && !node.alertState.trafficWarningAlertedAt && !traffic.thresholdExceededAt) {
    node.alertState.trafficWarningAlertedAt = nowIso();
    addAlertEvent(data, {
      nodeId: node.id,
      type: 'traffic-warning',
      level: 'warning',
      message: `Node ${node.name} reached ${warningPercent}% of traffic threshold`,
      channels: node.alertPolicy?.trafficChannels || data.alertPolicy?.trafficChannels || [],
      dedupeKey: `traffic-warning:${node.id}:${threshold}`
    });
  }
  if (threshold > 0 && traffic.totalBytes >= threshold && !traffic.thresholdExceededAt) {
    traffic.thresholdExceededAt = nowIso();
    node.alertState.trafficThresholdAlertedAt = traffic.thresholdExceededAt;
    node.status = 'warning';
    const action = trafficLimitAction(data, node, traffic);
    const actions = applyTrafficLimitAction(data, node, action);
    addAlertEvent(data, {
      nodeId: node.id,
      type: 'traffic-threshold',
      level: 'warning',
      message: `Node ${node.name} exceeded traffic threshold`,
      channels: node.alertPolicy?.trafficChannels || data.alertPolicy?.trafficChannels || [],
      actions,
      dedupeKey: `traffic-threshold:${node.id}:${threshold}`
    });
  }
  node.traffic = traffic;
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
          message: `Node ${node.name} has been offline for more than ${Math.round(maxAgeMs / 1000)} seconds`,
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
        message: `Node ${node.name} is back online`,
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

function subscriptionLinks(data) {
  return data.nodes
    .filter((node) => node.subscriptionEnabled && isRecent(node.lastSeenAt, 24 * 60 * 60 * 1000))
    .flatMap((node) => {
      if (Array.isArray(node.reportedLinks) && node.reportedLinks.length > 0) return node.reportedLinks;
      return [];
    })
    .filter(Boolean);
}

function renderSubscription(data, profile) {
  const links = subscriptionLinks(data);
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
      message: `Node ${node.name} is back online`,
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
    message: `queued ${type}`,
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
}

function commandResultMessage(result) {
  const data = resultData(result);
  const message = String(data.message || result?.message || '').trim();
  return message || 'command failed';
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
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
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

function writeWebSocket(socket, payload) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(websocketFrame(payload));
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
          commands: `/api/v1/agents/${agent.id}/commands`
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
              message: `running ${command.type}`,
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
          message: command.status === 'failed' ? commandResultMessage(command.result) : 'command succeeded',
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
      items: data.nodes.map((node) => presentNode(node, req, data))
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes') {
    const body = await readJson(req);
    let node;
    await store.update((draft) => {
      node = createNode(body);
      draft.nodes.push(node);
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 201, presentNode(node, req, store.data));
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
      if (Array.isArray(body.tags)) node.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean);
      if (body.subscriptionEnabled !== undefined) node.subscriptionEnabled = body.subscriptionEnabled === true;
      if (body.traffic && typeof body.traffic === 'object') {
        node.traffic = {
          ...(node.traffic || {}),
          ...(body.traffic.thresholdBytes !== undefined ? { thresholdBytes: Number(body.traffic.thresholdBytes) || 0 } : {}),
          ...(body.traffic.warningPercent !== undefined ? { warningPercent: Number(body.traffic.warningPercent) || 80 } : {}),
          ...(body.traffic.autoDisableSubscription !== undefined ? { autoDisableSubscription: body.traffic.autoDisableSubscription === true } : {})
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
    let removedAgents = 0;
    let removedCommands = 0;
    let removedAlertEvents = 0;
    await store.update((draft) => {
      const agentIds = new Set(draft.agents.filter((agent) => agent.nodeId === nodeId).map((agent) => agent.id));
      const beforeAgents = draft.agents.length;
      const beforeCommands = draft.commands.length;
      const beforeAlertEvents = (draft.alertEvents || []).length;
      const removedCommandIds = new Set(draft.commands.filter((command) => command.nodeId === nodeId || agentIds.has(command.agentId)).map((command) => command.id));
      draft.nodes = draft.nodes.filter((item) => item.id !== nodeId);
      draft.agents = draft.agents.filter((agent) => agent.nodeId !== nodeId);
      draft.commands = draft.commands.filter((command) => command.nodeId !== nodeId && !agentIds.has(command.agentId));
      draft.commandEvents = (draft.commandEvents || []).filter((event) => !removedCommandIds.has(event.commandId));
      draft.alertEvents = (draft.alertEvents || []).filter((event) => event.nodeId !== nodeId);
      removedAgents = beforeAgents - draft.agents.length;
      removedCommands = beforeCommands - draft.commands.length;
      removedAlertEvents = beforeAlertEvents - draft.alertEvents.length;
    });
    realtime.broadcastTraffic?.();
    return sendJson(res, 200, { deleted: true, removedAgents, removedCommands, removedAlertEvents });
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
        await handleApi(req, res, store, url, { broadcastTraffic: () => trafficHub.broadcast() });
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error instanceof SyntaxError) return badRequest(res, 'invalid json body');
      sendJson(res, 500, { detail: error.message || 'internal server error' });
    }
  });
  server.on('upgrade', (req, socket) => handleTrafficUpgrade(req, socket, store, trafficHub));
  server.on('close', () => trafficHub.close());
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await createPulseDeckServer();
  server.listen(PORT, HOST, () => {
    console.log(`PulseDeck panel listening on http://${HOST}:${PORT}`);
  });
}
