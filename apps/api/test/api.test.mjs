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
    assert.equal(body.version, '0.2.4');
    assert.equal(body.agentVersion, '0.2.4-rust');
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
    assert.equal(body.agentVersion, '0.2.4-rust');
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
    assert.equal(single.body.version, '0.2.4-rust');
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
    assert.match(script.body, /Agent checksum verified/);
    assert.doesNotMatch(script.body, /download "\$PULSEDECK_BASE_URL\/api\/v1\/agents\/runtime\/\$PULSEDECK_AGENT_TARGET" "\$AGENT_BIN"/);
    assert.match(script.body, /systemd/);
    assert.match(script.body, /systemctl restart pulsedeck-agent\.service/);
    assert.match(script.body, /openrc/);
    assert.match(script.body, /rc-service pulsedeck-agent restart/);
    assert.match(script.body, /PK/);
    assert.match(script.body, /Run `pk` without arguments|Use: pk, pk status/);
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
    assert.ok(eventsBeforeResult.body.items.some((event) => event.message.includes('queued')));
    assert.ok(eventsBeforeResult.body.items.some((event) => event.message.includes('running')));
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
            message: 'sing-box binary was not found; run sing-box-install or install sing-box manually'
          }
        }
      }
    });
    assert.equal(failedResult.res.status, 200);
    const failedEvents = await request(app.base, `/api/v1/commands/${resetCommand.id}/events?format=json`, { headers: auth });
    assert.ok(failedEvents.body.items.some((event) => event.type === 'error' && event.message.includes('sing-box binary was not found')));

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
  } finally {
    ws?.close();
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
