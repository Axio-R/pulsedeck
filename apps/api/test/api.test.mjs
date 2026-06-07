import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createPulseDeckServer } from '../src/main.mjs';

async function startServer() {
  const dir = path.join('/tmp', `pulsedeck-api-test-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const server = await createPulseDeckServer({ dataFile: path.join(dir, 'data.json') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function request(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { res, body };
}

async function openWebSocket(base, path) {
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const messages = [];
  let waiter = null;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(message);
    } else {
      messages.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timed out')), 2000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('websocket open failed'));
      },
      { once: true }
    );
  });

  return {
    socket,
    close: () => socket.close(),
    sendJson: (body) => socket.send(JSON.stringify(body)),
    readJson: () =>
      new Promise((resolve, reject) => {
        if (messages.length) {
          resolve(messages.shift());
          return;
        }
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error('websocket frame timed out'));
        }, 2000);
        waiter = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      })
  };
}

test('health reports PulseDeck on default product port', async () => {
  const app = await startServer();
  try {
    const { res, body } = await request(app.base, '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(body.name, 'PulseDeck');
    assert.equal(body.version, '0.2.9');
    assert.equal(body.agentVersion, '0.2.9-rust');
    assert.equal(body.port, 14770);
  } finally {
    await app.close();
  }
});

test('agent runtime manifest exposes target metadata', async () => {
  const app = await startServer();
  try {
    const { res, body } = await request(app.base, '/api/v1/agents/runtime/manifest');
    assert.equal(res.status, 200);
    assert.equal(body.agentVersion, '0.2.9-rust');
    assert.ok(Array.isArray(body.targets));
    assert.deepEqual(
      body.targets.map((target) => target.target),
      ['linux-x64', 'linux-arm64', 'linux-armv7l']
    );
    const x64 = body.targets.find((target) => target.target === 'linux-x64');
    assert.equal(typeof x64.available, 'boolean');
    assert.equal(typeof x64.sizeBytes, 'number');
    assert.equal(typeof x64.sha256, 'string');
    assert.match(x64.downloadUrl, /\/api\/v1\/agents\/runtime\/linux-x64$/);

    const single = await request(app.base, '/api/v1/agents/runtime/manifest/linux-x64');
    assert.equal(single.res.status, 200);
    assert.equal(single.body.target, 'linux-x64');
    assert.equal(single.body.version, '0.2.9-rust');
  } finally {
    await app.close();
  }
});

test('node enrollment install script is LXC and Rust multi-arch aware', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    assert.equal(login.res.status, 200);
    const auth = { authorization: `Bearer ${login.body.token}` };

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'halo', region: 'LXC' }
    });
    assert.equal(created.res.status, 201);
    assert.match(created.body.installCommand, /curl -fsSL/);

    const script = await request(app.base, `/api/v1/agents/install/${created.body.installId}`);
    assert.equal(script.res.status, 200);
    assert.match(script.body, /PULSEDECK_AGENT_HOME/);
    assert.match(script.body, /PULSEDECK_AGENT_TARGET/);
    assert.match(script.body, /\/var\/lib\/pulsedeck/);
    assert.match(script.body, /\/opt\/pulsedeck/);
    assert.match(script.body, /linux-x64/);
    assert.match(script.body, /linux-arm64/);
    assert.match(script.body, /linux-armv7l/);
    assert.match(script.body, /pulsedeck-agent/);
    assert.match(script.body, /runtime\/\$PULSEDECK_AGENT_TARGET/);
    assert.match(script.body, /install_agent_binary/);
    assert.match(script.body, /\.\$\.download|\.\$\$\.download/);
    assert.match(script.body, /mv -f "\$next" "\$target"/);
    assert.match(script.body, /runtime\/manifest\/\$PULSEDECK_AGENT_TARGET/);
    assert.match(script.body, /verify_sha256/);
    assert.match(script.body, /Agent 校验通过/);
    assert.doesNotMatch(script.body, /download "\$PULSEDECK_BASE_URL\/api\/v1\/agents\/runtime\/\$PULSEDECK_AGENT_TARGET" "\$AGENT_BIN"/);
    assert.match(script.body, /systemd/);
    assert.match(script.body, /systemctl restart pulsedeck-agent\.service/);
    assert.match(script.body, /openrc/);
    assert.match(script.body, /rc-service pulsedeck-agent restart/);
    assert.match(script.body, /PK/);
    assert.match(script.body, /常用命令：pk|Use: pk, pk status/);
    assert.match(script.body, /pk info/);
    assert.match(script.body, /pk update-check/);
    assert.match(script.body, /RK/);
    assert.doesNotMatch(script.body, /Node\.js runtime/);
    assert.doesNotMatch(script.body, /node-v/);
  } finally {
    await app.close();
  }
});

test('geoip and geosite lookup use local database files', async () => {
  const dir = path.join('/tmp', `pulsedeck-geo-test-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const geoipFile = path.join(dir, 'geoip.json');
  const geositeFile = path.join(dir, 'geosite.json');
  await writeFile(
    geoipFile,
    JSON.stringify([{ cidr: '203.0.113.0/24', region: 'Tokyo', countryCode: 'JP', city: 'Tokyo' }]),
    'utf8'
  );
  await writeFile(
    geositeFile,
    JSON.stringify([{ suffix: 'example.com', code: 'test-sites', name: 'Example Sites' }]),
    'utf8'
  );
  const previousGeoip = process.env.PULSEDECK_GEOIP_FILE;
  const previousGeosite = process.env.PULSEDECK_GEOSITE_FILE;
  process.env.PULSEDECK_GEOIP_FILE = geoipFile;
  process.env.PULSEDECK_GEOSITE_FILE = geositeFile;

  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const lookup = await request(app.base, '/api/v1/geoip/lookup?ip=203.0.113.8', { headers: auth });
    assert.equal(lookup.res.status, 200);
    assert.equal(lookup.body.region, 'Tokyo');
    assert.equal(lookup.body.countryCode, 'JP');
    assert.match(lookup.body.source, /geoip-file/);

    const site = await request(app.base, '/api/v1/geosite/lookup?domain=www.example.com', { headers: auth });
    assert.equal(site.res.status, 200);
    assert.equal(site.body.matched, true);
    assert.equal(site.body.groups[0].code, 'test-sites');

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'geo-node' }
    });
    await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.1.0-rust',
        platform: 'linux',
        arch: 'x86_64',
        installDir: '/var/lib/pulsedeck',
        serviceMode: 'manual',
        addresses: [{ interface: 'eth0', family: 'ipv4', address: '203.0.113.9', cidr: '203.0.113.9/24' }]
      }
    });
    const nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    const discovered = nodes.body.items.find((node) => node.id === created.body.id);
    assert.equal(discovered.region, 'Tokyo');
    assert.match(discovered.network.regionSource, /geoip-file/);
  } finally {
    if (previousGeoip === undefined) delete process.env.PULSEDECK_GEOIP_FILE;
    else process.env.PULSEDECK_GEOIP_FILE = previousGeoip;
    if (previousGeosite === undefined) delete process.env.PULSEDECK_GEOSITE_FILE;
    else process.env.PULSEDECK_GEOSITE_FILE = previousGeosite;
    await app.close();
  }
});

test('created nodes can be deleted with related commands purged', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'delete-me', region: 'test' }
    });
    assert.equal(created.res.status, 201);

    const command = await request(app.base, `/api/v1/nodes/${created.body.id}/commands`, {
      method: 'POST',
      headers: auth,
      body: { type: 'probe' }
    });
    assert.equal(command.res.status, 201);

    const deleted = await request(app.base, `/api/v1/nodes/${created.body.id}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(deleted.res.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.removedCommands, 1);

    const nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    assert.equal(nodes.res.status, 200);
    assert.equal(nodes.body.items.some((node) => node.id === created.body.id), false);

    const commands = await request(app.base, '/api/v1/commands', { headers: auth });
    assert.equal(commands.res.status, 200);
    assert.equal(commands.body.items.some((item) => item.nodeId === created.body.id), false);
  } finally {
    await app.close();
  }
});

test('nodes support automatic network discovery, protocol commands, and link reset', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const protocols = await request(app.base, '/api/v1/protocols', { headers: auth });
    assert.equal(protocols.res.status, 200);
    assert.ok(protocols.body.items.some((item) => item.type === 'vless'));
    assert.ok(protocols.body.items.some((item) => item.type === 'anytls'));

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'auto-region-node' }
    });
    assert.equal(created.res.status, 201);
    assert.equal(created.body.region, '');
    assert.equal(created.body.network.regionSource, 'auto-pending');

    const agentEnroll = await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.1.0-rust',
        platform: 'linux',
        arch: 'x86_64',
        installDir: '/var/lib/pulsedeck',
        serviceMode: 'manual',
        addresses: [
          { interface: 'eth0', family: 'ipv4', address: '198.51.100.10', cidr: '198.51.100.10/24' },
          { interface: 'eth0', family: 'ipv6', address: '2001:4860:4860::8888', cidr: '2001:4860:4860::8888/64' }
        ]
      }
    });
    assert.equal(agentEnroll.res.status, 200);

    const listed = await request(app.base, '/api/v1/nodes', { headers: auth });
    const discovered = listed.body.items.find((node) => node.id === created.body.id);
    assert.equal(discovered.network.primaryIpv4, '198.51.100.10');
    assert.equal(discovered.network.primaryIpv6, '2001:4860:4860::8888');
    assert.equal(discovered.network.ipMode, 'dual-stack');
    assert.equal(discovered.network.regionSource, 'geoip-empty');
    assert.equal(discovered.displayRegion, 'GeoIP 未配置');
    assert.equal(discovered.agent.version, '0.1.0-rust');
    assert.equal(discovered.agent.target, 'linux-x64');
    assert.equal(discovered.agent.latestVersion, '0.2.9-rust');
    assert.equal(discovered.agent.updateAvailable, true);
    assert.equal(discovered.agent.remoteUpdateSupported, false);

    const agentGeoNode = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'agent-geo-node' }
    });
    assert.equal(agentGeoNode.res.status, 201);
    await request(app.base, `/api/v1/agents/enroll/${agentGeoNode.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.2.5-rust',
        platform: 'linux',
        arch: 'x86_64',
        installDir: '/var/lib/pulsedeck',
        serviceMode: 'manual',
        addresses: [
          {
            interface: 'public-lookup',
            family: 'ipv4',
            address: '198.51.100.20',
            region: 'California',
            countryCode: 'US',
            city: 'Los Angeles',
            source: 'agent-public-lookup'
          }
        ]
      }
    });
    const listedWithAgentGeo = await request(app.base, '/api/v1/nodes', { headers: auth });
    const agentGeoDiscovered = listedWithAgentGeo.body.items.find((node) => node.id === agentGeoNode.body.id);
    assert.equal(agentGeoDiscovered.region, 'US · California · Los Angeles');
    assert.equal(agentGeoDiscovered.displayRegion, 'US · California · Los Angeles');
    assert.equal(agentGeoDiscovered.network.regionSource, 'agent-public-lookup');

    const warpNode = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'warp-v4-ipv6-node' }
    });
    await request(app.base, `/api/v1/agents/enroll/${warpNode.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.2.9-rust',
        platform: 'linux',
        arch: 'x86_64',
        installDir: '/var/lib/pulsedeck',
        serviceMode: 'manual',
        addresses: [
          { interface: 'eth0', family: 'ipv6', address: '2001:4860:4860::8888', cidr: '2001:4860:4860::8888/64' },
          { interface: 'docker0', family: 'ipv4', address: '172.17.0.1', cidr: '172.17.0.1/16' },
          { interface: 'warp', family: 'ipv4', address: '172.16.0.2', cidr: '172.16.0.2/32' },
          { interface: 'warp', family: 'ipv6', address: '2606:4700:110:80f3::1', cidr: '2606:4700:110:80f3::1/128' },
          {
            interface: 'public-lookup-ipv6',
            family: 'ipv6',
            address: '2a14:7581:8516::1',
            region: 'Hong Kong',
            countryCode: 'HK',
            city: 'Hong Kong',
            source: 'agent-public-ipv6'
          },
          { interface: 'remote', family: 'ipv4', address: '104.28.215.69', source: 'panel-remote' }
        ]
      }
    });
    const listedWarp = await request(app.base, '/api/v1/nodes', { headers: auth });
    const warpDiscovered = listedWarp.body.items.find((node) => node.id === warpNode.body.id);
    assert.equal(warpDiscovered.region, 'HK · Hong Kong');
    assert.equal(warpDiscovered.displayRegion, 'HK · Hong Kong');
    assert.equal(warpDiscovered.network.ipMode, 'warp-v4-ipv6');
    assert.equal(warpDiscovered.network.primaryIpv4, null);
    assert.equal(warpDiscovered.network.primaryIpv6, '2001:4860:4860::8888');
    assert.equal(warpDiscovered.network.warpIpv4, '104.28.215.69');
    assert.equal(warpDiscovered.network.warpIpv6, '2606:4700:110:80f3::1');
    assert.equal(warpDiscovered.agent.remoteUpdateSupported, true);

    const patched = await request(app.base, `/api/v1/nodes/${created.body.id}`, {
      method: 'PATCH',
      headers: auth,
      body: { region: 'JP', traffic: { thresholdBytes: 1024, autoDisableSubscription: true } }
    });
    assert.equal(patched.res.status, 200);
    assert.equal(patched.body.region, 'JP');
    assert.equal(patched.body.regionOverride, true);
    assert.equal(patched.body.traffic.thresholdBytes, 1024);

    const added = await request(app.base, `/api/v1/nodes/${created.body.id}/protocols`, {
      method: 'POST',
      headers: auth,
      body: { type: 'vless', port: 443, variant: 'reality' }
    });
    assert.equal(added.res.status, 201);
    assert.equal(added.body.protocol.type, 'vless');
    assert.equal(added.body.protocol.port, 443);
    assert.equal(added.body.command.type, 'protocol-add');

    const queued = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands`, {
      headers: { authorization: `Bearer ${agentEnroll.body.token}` }
    });
    assert.equal(queued.res.status, 200);
    const protocolCommand = queued.body.items.find((item) => item.type === 'protocol-add');
    assert.ok(protocolCommand);
    assert.equal(protocolCommand.node.id, created.body.id);
    assert.equal(protocolCommand.node.protocols.length, 1);
    assert.equal(protocolCommand.node.protocols[0].type, 'vless');

    const progressEvent = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands/${protocolCommand.id}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentEnroll.body.token}` },
      body: {
        type: 'progress',
        stream: 'stdout',
        message: 'rendering sing-box config',
        payload: { step: 'render' }
      }
    });
    assert.equal(progressEvent.res.status, 202);

    const eventsBeforeResult = await request(app.base, `/api/v1/commands/${protocolCommand.id}/events?format=json`, { headers: auth });
    assert.equal(eventsBeforeResult.res.status, 200);
    assert.ok(eventsBeforeResult.body.items.some((event) => event.message.includes('已入队')));
    assert.ok(eventsBeforeResult.body.items.some((event) => event.message.includes('执行中')));
    assert.ok(eventsBeforeResult.body.items.some((event) => event.message === 'rendering sing-box config'));

    const commandResult = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands/${protocolCommand.id}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentEnroll.body.token}` },
      body: {
        status: 'succeeded',
        result: {
          finishedAt: '1',
          data: {
            reportedLinks: ['vless://example@203.0.113.10:443#auto-region-node'],
            singBox: {
              installed: true,
              status: 'applied',
              configPath: '/etc/sing-box/config.json'
            }
          }
        }
      }
    });
    assert.equal(commandResult.res.status, 200);

    const listedAfterResult = await request(app.base, '/api/v1/nodes', { headers: auth });
    const withCommandResult = listedAfterResult.body.items.find((node) => node.id === created.body.id);
    assert.deepEqual(withCommandResult.reportedLinks, ['vless://example@203.0.113.10:443#auto-region-node']);
    assert.equal(withCommandResult.singBox.status, 'applied');
    assert.equal(withCommandResult.singBox.configPath, '/etc/sing-box/config.json');

    const updateCheck = await request(app.base, `/api/v1/nodes/${created.body.id}/commands`, {
      method: 'POST',
      headers: auth,
      body: { type: 'agent-update-check' }
    });
    assert.equal(updateCheck.res.status, 201);
    const queuedUpdateChecks = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands`, {
      headers: { authorization: `Bearer ${agentEnroll.body.token}` }
    });
    assert.ok(queuedUpdateChecks.body.items.some((item) => item.id === updateCheck.body.id));
    const updateResult = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands/${updateCheck.body.id}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentEnroll.body.token}` },
      body: {
        status: 'succeeded',
        result: {
          finishedAt: '2',
          data: {
            message: '发现可更新 Agent 版本',
            agentUpdate: {
              status: 'update-available',
              target: 'linux-x64',
              currentVersion: '0.1.0-rust',
              latestVersion: '0.2.9-rust',
              available: true,
              updateAvailable: true
            }
          }
        }
      }
    });
    assert.equal(updateResult.res.status, 200);
    const listedAfterAgentCheck = await request(app.base, '/api/v1/nodes', { headers: auth });
    const withAgentUpdate = listedAfterAgentCheck.body.items.find((node) => node.id === created.body.id);
    assert.equal(withAgentUpdate.agent.update.status, 'update-available');
    assert.equal(withAgentUpdate.agent.update.updateAvailable, true);
    assert.equal(withAgentUpdate.agent.update.latestVersion, '0.2.9-rust');

    const eventsAfterResult = await request(app.base, `/api/v1/commands/${protocolCommand.id}/events?format=json`, { headers: auth });
    assert.ok(eventsAfterResult.body.items.some((event) => event.type === 'result'));
    assert.ok(eventsAfterResult.body.items.some((event) => event.payload?.status === 'succeeded'));

    const reset = await request(app.base, `/api/v1/nodes/${created.body.id}/links/reset`, {
      method: 'POST',
      headers: auth
    });
    assert.equal(reset.res.status, 201);
    assert.equal(reset.body.type, 'reset-links');

    const queuedAfterReset = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands`, {
      headers: { authorization: `Bearer ${agentEnroll.body.token}` }
    });
    const resetCommand = queuedAfterReset.body.items.find((item) => item.id === reset.body.id);
    assert.ok(resetCommand);
    const failedResult = await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/commands/${resetCommand.id}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentEnroll.body.token}` },
      body: {
        status: 'failed',
        result: {
          finishedAt: '2',
          data: {
            message: '未找到 sing-box 可执行文件；请先下发 sing-box 安装命令或手动安装'
          }
        }
      }
    });
    assert.equal(failedResult.res.status, 200);
    const failedEvents = await request(app.base, `/api/v1/commands/${resetCommand.id}/events?format=json`, { headers: auth });
    assert.ok(failedEvents.body.items.some((event) => event.type === 'error' && event.message.includes('未找到 sing-box 可执行文件')));

    const removed = await request(app.base, `/api/v1/nodes/${created.body.id}/protocols/${added.body.protocol.id}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(removed.res.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.command.type, 'protocol-delete');

    const policy = await request(app.base, '/api/v1/alert-policy', { headers: auth });
    assert.equal(policy.res.status, 200);
    assert.equal(policy.body.autoDisableOnTrafficLimit, true);

    const patchedPolicy = await request(app.base, '/api/v1/alert-policy', {
      method: 'PATCH',
      headers: auth,
      body: { offlineAfterSeconds: 300, offlineChannels: ['telegram'], trafficChannels: ['email'], autoDisableOnTrafficLimit: false }
    });
    assert.equal(patchedPolicy.res.status, 200);
    assert.equal(patchedPolicy.body.offlineAfterSeconds, 300);
    assert.deepEqual(patchedPolicy.body.offlineChannels, ['telegram']);
    assert.deepEqual(patchedPolicy.body.trafficChannels, ['email']);
    assert.equal(patchedPolicy.body.autoDisableOnTrafficLimit, false);
  } finally {
    await app.close();
  }
});

test('traffic websocket streams live node traffic snapshots', async () => {
  const app = await startServer();
  let ws;
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'traffic-node' }
    });
    const agentEnroll = await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.1.0-rust',
        platform: 'linux',
        arch: 'x86_64',
        serviceMode: 'manual'
      }
    });

    ws = await openWebSocket(app.base, `/api/v1/traffic/stream?token=${login.body.token}`);
    const initial = await ws.readJson();
    assert.equal(initial.type, 'traffic.snapshot');
    assert.ok(initial.items.some((item) => item.id === created.body.id));

    const agentAuth = { authorization: `Bearer ${agentEnroll.body.token}` };
    await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          cpu: { usagePercent: 12 },
          memory: { usagePercent: 34 },
          network: { interfaces: [{ name: 'eth0', rxBytes: 1000, txBytes: 2000 }] }
        }
      }
    });
    const firstPush = await ws.readJson();
    const firstNode = firstPush.items.find((item) => item.id === created.body.id);
    assert.equal(firstPush.type, 'traffic.snapshot');
    assert.equal(firstNode.metrics.cpu.usagePercent, 12);
    assert.equal(firstNode.traffic.lastRxBytes, 1000);

    await request(app.base, `/api/v1/agents/${agentEnroll.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          cpu: { usagePercent: 18 },
          memory: { usagePercent: 40 },
          network: { interfaces: [{ name: 'eth0', rxBytes: 2500, txBytes: 4500 }] }
        }
      }
    });
    const secondPush = await ws.readJson();
    const secondNode = secondPush.items.find((item) => item.id === created.body.id);
    assert.equal(secondNode.traffic.lastDeltaRxBytes, 1500);
    assert.equal(secondNode.traffic.lastDeltaTxBytes, 2500);
    assert.equal(secondNode.traffic.rxRateBytesPerSecond, 1500);
    assert.equal(secondNode.traffic.txRateBytesPerSecond, 2500);

    const dashboard = await request(app.base, '/api/v1/dashboard', { headers: auth });
    assert.equal(dashboard.res.status, 200);
    assert.equal(dashboard.body.traffic.totalRxBytes, 1500);
    assert.equal(dashboard.body.traffic.totalTxBytes, 2500);
    assert.equal(dashboard.body.traffic.totalBytes, 4000);
    assert.equal(dashboard.body.traffic.rxRateBytesPerSecond, 1500);
    assert.equal(dashboard.body.traffic.txRateBytesPerSecond, 2500);
  } finally {
    ws?.close();
    await app.close();
  }
});

test('traffic history rank reset and node batch management work', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const first = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'alpha', group: 'edge' }
    });
    const second = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'beta', group: 'core' }
    });
    assert.equal(first.body.group, 'edge');
    assert.equal(second.body.group, 'core');

    const reordered = await request(app.base, '/api/v1/nodes/reorder', {
      method: 'POST',
      headers: auth,
      body: { ids: [second.body.id, first.body.id] }
    });
    assert.equal(reordered.res.status, 200);
    assert.deepEqual(
      reordered.body.items.slice(0, 2).map((node) => node.id),
      [second.body.id, first.body.id]
    );

    const batch = await request(app.base, '/api/v1/nodes/batch-command', {
      method: 'POST',
      headers: auth,
      body: { nodeIds: [first.body.id, second.body.id], type: 'diagnostics' }
    });
    assert.equal(batch.res.status, 201);
    assert.equal(batch.body.queued, 2);

    const enrolled = await request(app.base, `/api/v1/agents/enroll/${first.body.installId}`, {
      method: 'POST',
      body: { version: '0.2.5-rust', platform: 'linux', arch: 'x86_64', serviceMode: 'manual' }
    });
    const agentAuth = { authorization: `Bearer ${enrolled.body.token}` };
    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: { metrics: { network: { interfaces: [{ name: 'eth0', rxBytes: 1000, txBytes: 2000 }] } } }
    });
    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: { metrics: { network: { interfaces: [{ name: 'eth0', rxBytes: 4000, txBytes: 7000 }] } } }
    });

    const history = await request(app.base, `/api/v1/traffic/history?nodeId=${first.body.id}&limit=10`, { headers: auth });
    assert.equal(history.res.status, 200);
    assert.ok(history.body.items.length >= 2);
    assert.ok(history.body.items.some((item) => item.rxBytes === 3000 && item.txBytes === 5000));

    const rank = await request(app.base, '/api/v1/traffic/rank?mode=total&limit=5', { headers: auth });
    assert.equal(rank.res.status, 200);
    assert.equal(rank.body.items[0].nodeId, first.body.id);
    assert.equal(rank.body.items[0].usageBytes, 8000);

    const reset = await request(app.base, '/api/v1/traffic/reset', {
      method: 'POST',
      headers: auth,
      body: { nodeIds: [first.body.id] }
    });
    assert.equal(reset.res.status, 200);
    assert.equal(reset.body.reset, 1);

    const nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    const resetNode = nodes.body.items.find((node) => node.id === first.body.id);
    assert.equal(resetNode.traffic.totalBytes, 0);
    assert.equal(resetNode.traffic.lastResetAt !== null, true);

    const historyAfterReset = await request(app.base, `/api/v1/traffic/history?nodeId=${first.body.id}&limit=10`, { headers: auth });
    assert.ok(historyAfterReset.body.items.some((item) => item.kind === 'manual-reset'));
  } finally {
    await app.close();
  }
});

test('agent control websocket receives queued commands and reports results', async () => {
  const app = await startServer();
  let ws;
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'control-node' }
    });
    const enrolled = await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: { version: '0.2.5-rust', platform: 'linux', arch: 'x86_64', serviceMode: 'manual' }
    });

    ws = await openWebSocket(app.base, `/api/v1/agents/${enrolled.body.agentId}/control/stream?token=${enrolled.body.token}`);
    const hello = await ws.readJson();
    assert.equal(hello.type, 'hello');

    const queued = await request(app.base, `/api/v1/nodes/${created.body.id}/commands`, {
      method: 'POST',
      headers: auth,
      body: { type: 'probe' }
    });
    assert.equal(queued.res.status, 201);

    const pushed = await ws.readJson();
    assert.equal(pushed.type, 'command');
    assert.equal(pushed.command.id, queued.body.id);
    assert.equal(pushed.command.type, 'probe');

    ws.sendJson({
      type: 'command.event',
      commandId: pushed.command.id,
      stream: 'stdout',
      message: 'ws progress',
      payload: { step: 'probe' }
    });
    ws.sendJson({
      type: 'command.result',
      commandId: pushed.command.id,
      status: 'succeeded',
      result: { finishedAt: '3', data: { message: 'ws ok', reportedLinks: ['vless://ws.example'] } }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const commands = await request(app.base, '/api/v1/commands', { headers: auth });
    const command = commands.body.items.find((item) => item.id === pushed.command.id);
    assert.equal(command.status, 'succeeded');

    const events = await request(app.base, `/api/v1/commands/${pushed.command.id}/events?format=json`, { headers: auth });
    assert.ok(events.body.items.some((event) => event.message.includes('控制通道')));
    assert.ok(events.body.items.some((event) => event.message === 'ws progress'));
    assert.ok(events.body.items.some((event) => event.payload?.transport === 'websocket'));

    const nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    const node = nodes.body.items.find((item) => item.id === created.body.id);
    assert.deepEqual(node.reportedLinks, ['vless://ws.example']);
  } finally {
    ws?.close();
    await app.close();
  }
});

test('traffic limit policy can use download or upload accounting mode', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: {
        name: 'traffic-mode-node',
        traffic: {
          thresholdBytes: 1000,
          limitMode: 'download',
          warningPercent: 100,
          autoDisableSubscription: true
        }
      }
    });
    assert.equal(created.res.status, 201);
    assert.equal(created.body.traffic.limitMode, 'download');

    const enrolled = await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.2.5-rust',
        platform: 'linux',
        arch: 'x86_64',
        serviceMode: 'manual'
      }
    });
    const agentAuth = { authorization: `Bearer ${enrolled.body.token}` };

    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          network: { interfaces: [{ name: 'eth0', rxBytes: 100, txBytes: 100 }] }
        }
      }
    });
    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          network: { interfaces: [{ name: 'eth0', rxBytes: 700, txBytes: 2100 }] }
        }
      }
    });

    let nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    let trafficNode = nodes.body.items.find((node) => node.id === created.body.id);
    assert.equal(trafficNode.traffic.totalRxBytes, 600);
    assert.equal(trafficNode.traffic.totalTxBytes, 2000);
    assert.equal(trafficNode.traffic.thresholdExceededAt, null);
    assert.equal(trafficNode.subscriptionEnabled, true);

    let events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    assert.equal(events.body.items.some((event) => event.nodeId === created.body.id && event.type === 'traffic-threshold'), false);

    const patched = await request(app.base, `/api/v1/nodes/${created.body.id}`, {
      method: 'PATCH',
      headers: auth,
      body: { traffic: { limitMode: 'upload' } }
    });
    assert.equal(patched.res.status, 200);
    assert.equal(patched.body.traffic.limitMode, 'upload');

    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          network: { interfaces: [{ name: 'eth0', rxBytes: 701, txBytes: 2101 }] }
        }
      }
    });

    nodes = await request(app.base, '/api/v1/nodes', { headers: auth });
    trafficNode = nodes.body.items.find((node) => node.id === created.body.id);
    assert.equal(trafficNode.traffic.thresholdExceededAt !== null, true);
    assert.equal(trafficNode.subscriptionEnabled, false);

    events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    const thresholdEvent = events.body.items.find((event) => event.nodeId === created.body.id && event.type === 'traffic-threshold');
    assert.ok(thresholdEvent);
    assert.match(thresholdEvent.message, /上传流量阈值/);
  } finally {
    await app.close();
  }
});

test('alert policy detects offline nodes and traffic limit actions', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };

    const policy = await request(app.base, '/api/v1/alert-policy', {
      method: 'PATCH',
      headers: auth,
      body: {
        offlineAfterSeconds: 1,
        offlineChannels: ['telegram', 'email'],
        trafficChannels: ['telegram', 'email'],
        autoDisableOnTrafficLimit: true,
        trafficLimitAction: 'disable-node-subscription'
      }
    });
    assert.equal(policy.res.status, 200);
    assert.equal(policy.body.offlineAfterSeconds, 1);
    assert.equal(policy.body.trafficLimitAction, 'disable-node-subscription');

    const created = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: {
        name: 'alert-node',
        traffic: {
          thresholdBytes: 1000,
          warningPercent: 50
        }
      }
    });
    const enrolled = await request(app.base, `/api/v1/agents/enroll/${created.body.installId}`, {
      method: 'POST',
      body: {
        version: '0.1.0-rust',
        platform: 'linux',
        arch: 'x86_64',
        serviceMode: 'manual'
      }
    });
    assert.equal(enrolled.res.status, 200);
    const agentAuth = { authorization: `Bearer ${enrolled.body.token}` };

    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          network: { interfaces: [{ name: 'eth0', rxBytes: 100, txBytes: 100 }] }
        }
      }
    });
    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/metrics`, {
      method: 'POST',
      headers: agentAuth,
      body: {
        metrics: {
          network: { interfaces: [{ name: 'eth0', rxBytes: 900, txBytes: 900 }] }
        }
      }
    });

    const afterTraffic = await request(app.base, '/api/v1/nodes', { headers: auth });
    const trafficNode = afterTraffic.body.items.find((node) => node.id === created.body.id);
    assert.equal(trafficNode.subscriptionEnabled, false);
    assert.equal(trafficNode.traffic.thresholdExceededAt !== null, true);
    assert.equal(trafficNode.alertState.trafficThresholdAlertedAt !== null, true);

    let events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    assert.equal(events.res.status, 200);
    const thresholdEvent = events.body.items.find((event) => event.nodeId === created.body.id && event.type === 'traffic-threshold');
    assert.ok(thresholdEvent);
    assert.equal(thresholdEvent.status, 'skipped');
    assert.ok(thresholdEvent.actions.some((action) => action.type === 'disable-node-subscription' && action.status === 'completed'));
    assert.ok(thresholdEvent.deliveries.every((delivery) => delivery.status === 'skipped'));

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const offlineCheck = await request(app.base, '/api/v1/alerts/check', {
      method: 'POST',
      headers: auth
    });
    assert.equal(offlineCheck.res.status, 200);
    assert.equal(offlineCheck.body.offlineNodes, 1);
    assert.equal(offlineCheck.body.createdEvents, 1);

    events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    const offlineEvent = events.body.items.find((event) => event.nodeId === created.body.id && event.type === 'node-offline');
    assert.ok(offlineEvent);
    const ack = await request(app.base, `/api/v1/alert-events/${offlineEvent.id}/ack`, {
      method: 'POST',
      headers: auth
    });
    assert.equal(ack.res.status, 200);
    assert.equal(ack.body.status, 'acknowledged');

    await request(app.base, `/api/v1/agents/${enrolled.body.agentId}/heartbeat`, {
      method: 'POST',
      headers: agentAuth,
      body: { status: 'online' }
    });
    events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    assert.ok(events.body.items.some((event) => event.nodeId === created.body.id && event.type === 'node-recovered'));

    const deleted = await request(app.base, `/api/v1/nodes/${created.body.id}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(deleted.res.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.ok(deleted.body.removedAlertEvents >= 1);
    events = await request(app.base, '/api/v1/alert-events', { headers: auth });
    assert.equal(events.body.items.some((event) => event.nodeId === created.body.id), false);
  } finally {
    await app.close();
  }
});

test('soybean auth contract returns wrapped login token and user info', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { userName: 'admin', password: 'change-me' }
    });
    assert.equal(login.res.status, 200);
    assert.equal(login.body.code, '0000');
    assert.ok(login.body.data.token);
    assert.ok(login.body.data.refreshToken);

    const info = await request(app.base, '/api/v1/auth/getUserInfo', {
      headers: { authorization: `Bearer ${login.body.data.token}` }
    });
    assert.equal(info.res.status, 200);
    assert.equal(info.body.code, '0000');
    assert.equal(info.body.data.userName, 'admin');
    assert.ok(info.body.data.roles.includes('R_SUPER'));
  } finally {
    await app.close();
  }
});

test('subscription profiles protect defaults and delete custom profiles', async () => {
  const app = await startServer();
  try {
    const login = await request(app.base, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'change-me' }
    });
    const auth = { authorization: `Bearer ${login.body.token}` };
    const defaults = await request(app.base, '/api/v1/subscription-profiles', { headers: auth });
    assert.equal(defaults.res.status, 200);
    assert.ok(defaults.body.items.every((profile) => typeof profile.deletable === 'boolean'));
    const defaultRaw = defaults.body.items.find((profile) => profile.id === 'default-raw');
    assert.equal(defaultRaw.deletable, false);

    const blocked = await request(app.base, `/api/v1/subscription-profiles/${defaultRaw.id}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(blocked.res.status, 409);

    const custom = await request(app.base, '/api/v1/subscription-profiles', {
      method: 'POST',
      headers: auth,
      body: { name: '临时订阅', format: 'raw' }
    });
    assert.equal(custom.res.status, 201);
    assert.equal(custom.body.deletable, true);

    const hkNode = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'hk-node', region: 'HK · Hong Kong', group: 'asia', tags: ['edge'] }
    });
    const hkAgent = await request(app.base, `/api/v1/agents/enroll/${hkNode.body.installId}`, {
      method: 'POST',
      body: { version: '0.2.9-rust', platform: 'linux', arch: 'x86_64', installDir: '/var/lib/pulsedeck', serviceMode: 'manual' }
    });
    await request(app.base, `/api/v1/agents/${hkAgent.body.agentId}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hkAgent.body.token}` },
      body: { metrics: {}, reportedLinks: ['vless://hk@example.com:443#hk-node'] }
    });
    const usNode = await request(app.base, '/api/v1/nodes', {
      method: 'POST',
      headers: auth,
      body: { name: 'us-node', region: 'US · California', group: 'us', tags: ['edge'] }
    });
    const usAgent = await request(app.base, `/api/v1/agents/enroll/${usNode.body.installId}`, {
      method: 'POST',
      body: { version: '0.2.9-rust', platform: 'linux', arch: 'x86_64', installDir: '/var/lib/pulsedeck', serviceMode: 'manual' }
    });
    await request(app.base, `/api/v1/agents/${usAgent.body.agentId}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${usAgent.body.token}` },
      body: { metrics: {}, reportedLinks: ['vless://us@example.com:443#us-node'] }
    });
    const filtered = await request(app.base, '/api/v1/subscription-profiles', {
      method: 'POST',
      headers: auth,
      body: {
        name: '亚洲节点',
        format: 'raw',
        filters: { groups: ['asia'] },
        linkPrefixMode: 'region'
      }
    });
    const sub = await request(app.base, `/sub/${filtered.body.token}`);
    assert.equal(sub.res.status, 200);
    const decodedSub = decodeURIComponent(sub.body);
    assert.ok(decodedSub.includes('HK · Hong Kong hk-node'));
    assert.equal(decodedSub.includes('us-node'), false);

    const deleted = await request(app.base, `/api/v1/subscription-profiles/${custom.body.id}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(deleted.res.status, 200);
    assert.equal(deleted.body.deleted, true);
  } finally {
    await app.close();
  }
});
