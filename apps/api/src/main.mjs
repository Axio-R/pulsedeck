import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createNode, JsonStore, nowIso, randomToken } from './store.mjs';
import { renderAgentInstallScript } from './install-script.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const WEB_DIST_DIR = path.join(ROOT_DIR, 'dist');
const WEB_INDEX_FILE = path.join(WEB_DIST_DIR, 'index.html');
const AGENT_RUNTIME_FILE = path.join(ROOT_DIR, 'apps', 'agent', 'src', 'main.mjs');
const PORT = Number(process.env.PULSEDECK_PORT || 14770);
const HOST = process.env.PULSEDECK_HOST || '0.0.0.0';
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

function isRecent(iso, maxAgeMs = 180_000) {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

function requireUser(req, data) {
  const token = bearerToken(req);
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

function dashboard(data) {
  const onlineNodes = data.nodes.filter((node) => isRecent(node.lastSeenAt));
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
  node.status = patch.status || 'online';
  node.agentStatus = patch.agentStatus || 'online';
  node.lastSeenAt = timestamp;
  node.updatedAt = timestamp;
  if (Array.isArray(patch.addresses)) node.addresses = patch.addresses;
  if (patch.metrics) node.metrics = patch.metrics;
  if (patch.diagnostics) node.diagnostics = patch.diagnostics;
  if (Array.isArray(patch.reportedLinks)) node.reportedLinks = patch.reportedLinks;

  agent.lastSeenAt = timestamp;
  agent.updatedAt = timestamp;
  if (patch.version) agent.version = patch.version;
  if (patch.platform) agent.platform = patch.platform;
  if (patch.arch) agent.arch = patch.arch;
  if (patch.installDir) agent.installDir = patch.installDir;
  if (patch.serviceMode) agent.serviceMode = patch.serviceMode;
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

async function handleApi(req, res, store, url) {
  const data = store.data;
  const method = req.method || 'GET';
  const segments = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && url.pathname === '/api/v1/health') {
    return sendJson(res, 200, {
      status: 'ok',
      name: 'PulseDeck',
      version: '0.1.0',
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
    const session = requireUser(req, data);
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

  if (method === 'GET' && segments.join('/') === 'api/v1/agents/runtime') {
    const runtime = await readFile(AGENT_RUNTIME_FILE, 'utf8');
    return sendText(res, 200, runtime, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    });
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
        addresses: body.addresses || []
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
        if (draftAgent && draftNode) updateNodeFromAgent(draft, draftNode, draftAgent, body);
      });
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
            addresses: body.addresses,
            reportedLinks: body.reportedLinks
          });
        }
      });
      return sendJson(res, 200, { accepted: true });
    }

    if (method === 'POST' && segments[4] === 'diagnostics') {
      const body = await readJson(req);
      await store.update((draft) => {
        const draftAgent = draft.agents.find((item) => item.id === agentId);
        const draftNode = draft.nodes.find((item) => item.id === draftAgent?.nodeId);
        if (draftAgent && draftNode) updateNodeFromAgent(draft, draftNode, draftAgent, { diagnostics: body });
      });
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
          }
        }
      });
      return sendJson(res, 200, { items: commands });
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

  const session = requireUser(req, data);
  if (!session) return forbidden(res, 'authentication required');

  if (method === 'GET' && url.pathname === '/api/v1/dashboard') {
    return sendJson(res, 200, dashboard(data));
  }

  if (method === 'GET' && url.pathname === '/api/v1/nodes') {
    return sendJson(res, 200, {
      items: data.nodes.map((node) => ({
        ...node,
        online: isRecent(node.lastSeenAt),
        installCommand: `curl -fsSL '${publicBaseUrl(req)}/api/v1/agents/install/${encodeURIComponent(node.installId)}' | sh`
      }))
    });
  }

  if (method === 'POST' && url.pathname === '/api/v1/nodes') {
    const body = await readJson(req);
    let node;
    await store.update((draft) => {
      node = createNode(body);
      draft.nodes.push(node);
    });
    return sendJson(res, 201, {
      ...node,
      installCommand: `curl -fsSL '${publicBaseUrl(req)}/api/v1/agents/install/${encodeURIComponent(node.installId)}' | sh`
    });
  }

  if (method === 'DELETE' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3]) {
    const nodeId = segments[3];
    const node = data.nodes.find((item) => item.id === nodeId);
    if (!node) return notFound(res);
    let removedAgents = 0;
    let removedCommands = 0;
    await store.update((draft) => {
      const agentIds = new Set(draft.agents.filter((agent) => agent.nodeId === nodeId).map((agent) => agent.id));
      const beforeAgents = draft.agents.length;
      const beforeCommands = draft.commands.length;
      draft.nodes = draft.nodes.filter((item) => item.id !== nodeId);
      draft.agents = draft.agents.filter((agent) => agent.nodeId !== nodeId);
      draft.commands = draft.commands.filter((command) => command.nodeId !== nodeId && !agentIds.has(command.agentId));
      removedAgents = beforeAgents - draft.agents.length;
      removedCommands = beforeCommands - draft.commands.length;
    });
    return sendJson(res, 200, { deleted: true, removedAgents, removedCommands });
  }

  if (method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'nodes' && segments[3] && segments[4] === 'commands') {
    const nodeId = segments[3];
    const body = await readJson(req);
    let command;
    await store.update((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      command = {
        id: randomUUID(),
        nodeId,
        agentId: null,
        type: body.type || 'probe',
        payload: body.payload || {},
        status: 'queued',
        result: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      draft.commands.push(command);
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

  return notFound(res);
}

export async function createPulseDeckServer(options = {}) {
  const store = options.store || new JsonStore(options.dataFile);
  await store.load();

  return http.createServer(async (req, res) => {
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
        await handleApi(req, res, store, url);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error instanceof SyntaxError) return badRequest(res, 'invalid json body');
      sendJson(res, 500, { detail: error.message || 'internal server error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await createPulseDeckServer();
  server.listen(PORT, HOST, () => {
    console.log(`PulseDeck panel listening on http://${HOST}:${PORT}`);
  });
}
