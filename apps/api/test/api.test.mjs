import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
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

test('health reports PulseDeck on default product port', async () => {
  const app = await startServer();
  try {
    const { res, body } = await request(app.base, '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(body.name, 'PulseDeck');
    assert.equal(body.port, 14770);
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
    assert.match(script.body, /systemd/);
    assert.match(script.body, /openrc/);
    assert.match(script.body, /PK/);
    assert.match(script.body, /pk status/);
    assert.match(script.body, /RK/);
    assert.doesNotMatch(script.body, /Node\.js runtime/);
    assert.doesNotMatch(script.body, /node-v/);
  } finally {
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
