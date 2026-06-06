#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { access, appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const VERSION = '0.1.0-probe';
const DEFAULT_CONFIG_PATHS = [
  process.env.PULSEDECK_AGENT_CONFIG,
  '/etc/pulsedeck/agent.json',
  path.join(os.homedir() || '/', '.pulsedeck', 'etc', 'agent.json')
].filter(Boolean);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(file, fallback = {}) {
  const text = await readText(file);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

async function findConfigPath() {
  for (const file of DEFAULT_CONFIG_PATHS) {
    try {
      await access(file, constants.R_OK);
      return file;
    } catch {
      // Try next path.
    }
  }
  return DEFAULT_CONFIG_PATHS[0] || '/etc/pulsedeck/agent.json';
}

async function loadConfig() {
  const configPath = await findConfigPath();
  const config = await readJson(configPath, {});
  config.configPath = configPath;
  config.agentHome = config.agentHome || path.dirname(path.dirname(configPath));
  config.stateFile = config.stateFile || path.join(config.agentHome, 'state', 'agent-state.json');
  config.logFile = config.logFile || path.join(config.agentHome, 'state', 'agent.log');
  config.intervalMs = Number(config.intervalMs || 30_000);
  return config;
}

async function log(config, line) {
  const message = `${nowIso()} ${line}\n`;
  try {
    await mkdir(path.dirname(config.logFile), { recursive: true });
    await appendFile(config.logFile, message, 'utf8');
  } catch {
    // Logging must never break the Agent loop.
  }
}

async function postJson(config, endpoint, token, body) {
  const url = endpoint.startsWith('http') ? endpoint : `${config.baseUrl}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(parsed.detail || `request failed: ${res.status}`);
  return parsed;
}

async function getJson(config, endpoint, token) {
  const url = endpoint.startsWith('http') ? endpoint : `${config.baseUrl}${endpoint}`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `request failed: ${res.status}`);
  return body;
}

function parseMeminfo(text) {
  if (!text) return null;
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^([^:]+):\s+(\d+)/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  const total = values.MemTotal || os.totalmem?.() || 0;
  const available = values.MemAvailable || 0;
  const used = total && available ? total - available : null;
  return {
    totalBytes: total || null,
    availableBytes: available || null,
    usedBytes: used,
    usagePercent: total && used !== null ? Math.round((used / total) * 1000) / 10 : null
  };
}

function parseLoadavg(text) {
  if (!text) return null;
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  return { one, five, fifteen };
}

function parseNetDev(text) {
  if (!text) return [];
  const rows = [];
  for (const line of text.split('\n').slice(2)) {
    const [ifaceRaw, restRaw] = line.split(':');
    if (!ifaceRaw || !restRaw) continue;
    const iface = ifaceRaw.trim();
    if (!iface || iface === 'lo') continue;
    const cols = restRaw.trim().split(/\s+/).map(Number);
    rows.push({
      name: iface,
      rxBytes: cols[0] || 0,
      txBytes: cols[8] || 0
    });
  }
  return rows;
}

function interfaceAddresses() {
  try {
    const nets = os.networkInterfaces();
    return Object.entries(nets || {})
      .flatMap(([name, items]) =>
        (items || [])
          .filter((item) => !item.internal && ['IPv4', 'IPv6'].includes(item.family))
          .map((item) => ({
            interface: name,
            family: item.family,
            address: item.address,
            cidr: item.cidr || ''
          }))
      );
  } catch {
    return [];
  }
}

async function collectMetrics() {
  const [meminfo, loadavg, netdev, uptimeText] = await Promise.all([
    readText('/proc/meminfo'),
    readText('/proc/loadavg'),
    readText('/proc/net/dev'),
    readText('/proc/uptime')
  ]);
  const cpus = os.cpus?.() || [];
  const load = parseLoadavg(loadavg) || {
    one: os.loadavg?.()[0] || null,
    five: os.loadavg?.()[1] || null,
    fifteen: os.loadavg?.()[2] || null
  };
  const uptimeSeconds = uptimeText ? Number(uptimeText.trim().split(/\s+/)[0]) : os.uptime?.() || null;

  return {
    collectedAt: nowIso(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    uptimeSeconds,
    cpu: {
      cores: cpus.length || null,
      model: cpus[0]?.model || '',
      load,
      usagePercent: load?.one && cpus.length ? Math.min(100, Math.round((load.one / cpus.length) * 1000) / 10) : null
    },
    memory: parseMeminfo(meminfo),
    network: {
      interfaces: parseNetDev(netdev),
      addresses: interfaceAddresses()
    }
  };
}

async function collectDiagnostics(config) {
  const checks = [];
  async function check(name, run) {
    try {
      checks.push({ name, ok: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }

  await check('config-readable', async () => {
    await access(config.configPath, constants.R_OK);
    return true;
  });
  await check('state-writable', async () => {
    await mkdir(path.dirname(config.stateFile), { recursive: true });
    await writeFile(`${config.stateFile}.probe`, 'ok', 'utf8');
    return true;
  });
  await check('proc-readable', async () => Boolean(await readText('/proc/meminfo')));
  await check('systemd-present', async () => Boolean(await commandExists('systemctl')));
  await check('openrc-present', async () => Boolean(await commandExists('rc-service')));
  await check('lxc-hints', async () => {
    const cgroup = await readText('/proc/1/cgroup');
    return /lxc|docker|containerd|kubepods/i.test(cgroup || '');
  });

  return {
    collectedAt: nowIso(),
    version: VERSION,
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    serviceMode: config.serviceMode || 'unknown',
    checks
  };
}

async function commandExists(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of paths) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Continue.
    }
  }
  return false;
}

async function enroll(config, state) {
  if (state.agentId && state.token) return state;
  const metrics = await collectMetrics();
  const res = await postJson(config, `/api/v1/agents/enroll/${encodeURIComponent(config.installId)}`, '', {
    version: VERSION,
    platform: os.platform(),
    arch: os.arch(),
    installDir: config.agentHome,
    serviceMode: config.serviceMode || 'unknown',
    addresses: metrics.network.addresses
  });
  const next = {
    ...state,
    agentId: res.agentId,
    token: res.token,
    node: res.node,
    endpoints: res.endpoints,
    enrolledAt: state.enrolledAt || nowIso(),
    updatedAt: nowIso()
  };
  await writeJson(config.stateFile, next);
  return next;
}

async function runOnce(config) {
  let state = await readJson(config.stateFile, {});
  state = await enroll(config, state);
  const metrics = await collectMetrics();
  const diagnostics = await collectDiagnostics(config);
  const token = state.token;
  const agentId = state.agentId;

  await postJson(config, `/api/v1/agents/${agentId}/heartbeat`, token, {
    version: VERSION,
    platform: os.platform(),
    arch: os.arch(),
    installDir: config.agentHome,
    serviceMode: config.serviceMode || 'unknown',
    addresses: metrics.network.addresses
  });
  await postJson(config, `/api/v1/agents/${agentId}/metrics`, token, {
    metrics,
    addresses: metrics.network.addresses,
    reportedLinks: Array.isArray(config.reportedLinks) ? config.reportedLinks : []
  });
  await postJson(config, `/api/v1/agents/${agentId}/diagnostics`, token, diagnostics);
  await pollCommands(config, state);

  const nextState = {
    ...state,
    lastSeenAt: nowIso(),
    lastMetrics: {
      cpuUsagePercent: metrics.cpu.usagePercent,
      memoryUsagePercent: metrics.memory?.usagePercent ?? null,
      addressCount: metrics.network.addresses.length
    }
  };
  await writeJson(config.stateFile, nextState);
  await log(config, 'probe cycle completed');
  return nextState;
}

async function pollCommands(config, state) {
  if (!state.agentId || !state.token) return;
  const body = await getJson(config, `/api/v1/agents/${state.agentId}/commands`, state.token);
  for (const command of body.items || []) {
    const startedAt = nowIso();
    let result;
    let status = 'succeeded';
    try {
      if (command.type === 'diagnostics') result = await collectDiagnostics(config);
      else if (command.type === 'metrics' || command.type === 'probe') result = await collectMetrics();
      else if (command.type === 'restart') result = { message: 'restart command acknowledged; use local service manager for hard restart', startedAt };
      else result = { message: `unknown command ${command.type}`, startedAt };
    } catch (error) {
      status = 'failed';
      result = { error: error.message, startedAt, finishedAt: nowIso() };
    }
    await postJson(config, `/api/v1/agents/${state.agentId}/commands/${command.id}/result`, state.token, {
      status,
      result: { ...result, finishedAt: nowIso() }
    });
  }
}

async function runDaemon() {
  const config = await loadConfig();
  await log(config, `PulseDeck Agent ${VERSION} starting`);
  for (;;) {
    try {
      await runOnce(config);
    } catch (error) {
      await log(config, `probe cycle failed: ${error.message}`);
    }
    await sleep(config.intervalMs);
  }
}

async function status() {
  const config = await loadConfig();
  const state = await readJson(config.stateFile, {});
  console.log(`PulseDeck Agent ${VERSION}`);
  console.log(`config: ${config.configPath}`);
  console.log(`state: ${config.stateFile}`);
  console.log(`panel: ${config.baseUrl || '-'}`);
  console.log(`install: ${mask(config.installId)}`);
  console.log(`agent: ${mask(state.agentId)}`);
  console.log(`node: ${state.node?.name || state.node?.id || '-'}`);
  console.log(`service: ${config.serviceMode || 'unknown'}`);
  console.log(`last seen: ${state.lastSeenAt || '-'}`);
  console.log(`cpu: ${state.lastMetrics?.cpuUsagePercent ?? '-'}%`);
  console.log(`memory: ${state.lastMetrics?.memoryUsagePercent ?? '-'}%`);
  console.log(`addresses: ${state.lastMetrics?.addressCount ?? 0}`);
}

function mask(value) {
  if (!value) return '-';
  const text = String(value);
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

async function doctor() {
  const config = await loadConfig();
  const diagnostics = await collectDiagnostics(config);
  console.log(`PulseDeck Agent doctor (${VERSION})`);
  console.log(`platform: ${diagnostics.platform}/${diagnostics.arch}`);
  console.log(`node: ${diagnostics.node}`);
  console.log(`config: ${config.configPath}`);
  for (const item of diagnostics.checks) {
    const state = item.ok ? 'ok' : 'fail';
    console.log(`${state} ${item.name}${item.detail ? `: ${item.detail}` : ''}`);
  }
}

async function printLogs(lines = 120) {
  const config = await loadConfig();
  const text = await readText(config.logFile);
  if (!text) {
    console.log(`No log file at ${config.logFile}`);
    return;
  }
  console.log(text.trim().split('\n').slice(-lines).join('\n'));
}

async function restart() {
  if (await commandExists('systemctl')) {
    await exec('systemctl', ['restart', 'pulsedeck-agent.service']).catch(() => null);
    console.log('restart requested through systemd');
    return;
  }
  if (await commandExists('rc-service')) {
    await exec('rc-service', ['pulsedeck-agent', 'restart']).catch(() => null);
    console.log('restart requested through OpenRC');
    return;
  }
  console.log('No supported service manager found. Stop the current Agent process and run: pk daemon');
}

function exec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function updateSelf() {
  const config = await loadConfig();
  const target = process.argv[1];
  const res = await fetch(`${config.baseUrl}/api/v1/agents/runtime`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const next = await res.text();
  const backup = `${target}.bak`;
  await copyFile(target, backup).catch(() => null);
  await writeFile(`${target}.next`, next, 'utf8');
  await rename(`${target}.next`, target);
  console.log(`Agent runtime updated. Backup: ${backup}`);
}

async function menu() {
  if (!process.stdin.isTTY) return status();
  const rl = createInterface({ input, output });
  try {
    console.log('PulseDeck Agent');
    console.log('1. status');
    console.log('2. run once');
    console.log('3. logs');
    console.log('4. doctor');
    console.log('5. restart');
    console.log('6. update');
    console.log('7. config path');
    const answer = await rl.question('Select action [1-7]: ');
    if (answer === '1') await status();
    else if (answer === '2') console.log(JSON.stringify(await runOnce(await loadConfig()), null, 2));
    else if (answer === '3') await printLogs();
    else if (answer === '4') await doctor();
    else if (answer === '5') await restart();
    else if (answer === '6') await updateSelf();
    else if (answer === '7') console.log((await loadConfig()).configPath);
  } finally {
    rl.close();
  }
}

async function main() {
  const command = process.argv[2] || 'status';
  if (['daemon', 'run'].includes(command)) return runDaemon();
  if (['once', 'probe'].includes(command)) {
    const state = await runOnce(await loadConfig());
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (['status', 's', 'active', 'info'].includes(command)) return status();
  if (['menu', 'm'].includes(command)) return menu();
  if (['logs', 'log', 'l'].includes(command)) return printLogs(Number(process.argv[3] || 120));
  if (['doctor', 'check', 'd'].includes(command)) return doctor();
  if (['restart', 'r'].includes(command)) return restart();
  if (['update', 'u'].includes(command)) return updateSelf();
  if (['config', 'path', 'p'].includes(command)) {
    console.log((await loadConfig()).configPath);
    return;
  }
  if (['version', 'v'].includes(command)) {
    console.log(VERSION);
    return;
  }
  console.log('Usage: pk [status|menu|once|logs|doctor|restart|update|config|version]');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
