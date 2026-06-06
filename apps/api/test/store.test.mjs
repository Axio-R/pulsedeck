import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createNode, JsonStore } from '../src/store.mjs';

test('store hydrates defaults and persists nodes', async () => {
  const dir = path.join('/tmp', `pulsedeck-store-test-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'data.json');
  const store = new JsonStore(file);
  const data = await store.load();
  assert.equal(data.subscriptionProfiles.length, 3);
  assert.ok(data.subscriptionProfiles.every((profile) => profile.token));

  await store.update((draft) => {
    draft.nodes.push(createNode({ name: 'lxc-node', region: 'HK', tags: ['lxc'] }));
  });

  const reloaded = new JsonStore(file);
  const next = await reloaded.load();
  assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0].name, 'lxc-node');
  assert.equal(next.nodes[0].region, 'HK');
  assert.equal(next.nodes[0].tags[0], 'lxc');
});
