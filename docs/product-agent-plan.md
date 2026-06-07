# PulseDeck Product And Agent Plan

## Positioning

PulseDeck is a lightweight personal node and subscription management panel for sing-box based nodes.

It is not designed as a heavy multi-tenant airport platform, billing system, or enterprise observability stack. The first useful version should stay small:

- One personal operator account.
- A small to medium VPS/node fleet.
- Node enrollment, health, traffic, command control, and subscription distribution.
- Clear install and recovery paths for low-resource VPS and LXC environments.
- Minimal persistent state with a clear migration path from JSON to SQLite later.

## Product Principles

1. Lightweight first: avoid unnecessary background jobs, large telemetry stores, and heavy UI pages.
2. Reliable control loop: node creation, Agent install, heartbeat, metrics, command dispatch, and subscription generation must work before advanced modules.
3. Agent-friendly: nodes may have small disks, restricted `/tmp`, LXC cgroups, no systemd, IPv4-only, IPv6-only, or WARP-assisted networking.
4. Clear operator actions: every major action should have a visible state, result, retry path, and cleanup path.
5. Data hygiene: runtime data, smoke data, local Compose state, tokens, and deployment JSON must never be committed.

## Current Gaps

- Node create/list/delete exists, including cleanup of related Agent and command records.
- Node protocol records and remote protocol add/delete commands exist for VMess, VLESS, Trojan, Shadowsocks, Hysteria2, Tuic, and AnyTLS. The Rust Agent now has a first sing-box executor that renders desired protocol state, validates configs with `sing-box check`, applies configs, restarts common service managers, and returns generated subscription links when apply succeeds.
- Subscription Profile deletion exists for custom Profiles, and node-level reset-link command queuing exists. Agent-side link regeneration is wired through the sing-box executor; advanced per-protocol TLS/Reality/client-specific link details still need hardening.
- Agent reports host addresses; the panel classifies IPv4-only, IPv6-only, dual-stack, private/LXC, and WARP IPv4 plus IPv6 style nodes. GeoIP and Geosite lookup can now use local JSON database files mounted into the panel container.
- Panel-side cumulative traffic accounting and threshold auto-disable exist from metrics snapshots. Real-time traffic rates still need the WebSocket collector.
- Rust Agent command queue is HTTP polling today; real-time bidirectional WebSocket control is not implemented yet.
- Traffic metrics are periodic snapshots today; real-time per-second rate streaming needs a dedicated protocol.
- Local runtime data is ignored by `.gitignore`, but broader runtime JSON and database patterns should also be ignored.
- sing-box install/update is intentionally conservative: the Agent reports an existing binary or installs from an explicit `downloadUrl`/`PULSEDECK_SING_BOX_DOWNLOAD_URL`. Automatic package-manager install and signed release selection are still pending.
- Command events are persisted and exposed through SSE for the browser. This gives the operator live command state/output history, while true bidirectional Agent control remains a later WebSocket phase.

## Core Modules

### Dashboard

- Online/offline node count.
- Warning node count.
- Current aggregate upload/download speed.
- Recent command status.
- Recent Agent install/enrollment events.
- Top traffic nodes.

### Node Management

- Create node.
- Delete node and cleanup related Agent/command records.
- Copy install command.
- Reset install/subscription identity.
- Add/delete protocol entries and queue remote Agent commands.
- View Agent status, version, platform, architecture, install path, service mode, and last seen time.
- View addresses and route hints: IPv4, IPv6, WARP, private/LXC addresses.
- View cumulative traffic and traffic threshold state.
- Trigger diagnostics and sing-box actions.

### Agent Install And Lifecycle

- One-line install command.
- Adaptive install/temp directory selection.
- Rust native Agent binary download from the panel runtime endpoint.
- Future multi-arch Rust Agent artifacts from GitHub Actions for strict low-allocation telemetry.
- Local shortcut command remains mandatory for recovery when the panel is unreachable.

### sing-box Management

- Install/update/reinstall sing-box.
- Manage protocol definitions: VMess, VLESS, Trojan, Shadowsocks, Hysteria2, Tuic, AnyTLS, and variants.
- Support per-node protocol port settings.
- Render node config from panel templates.
- Apply config to node.
- Restart sing-box.
- Check service status.
- Validate config before apply.
- Roll back to previous config if apply fails.

Current first implementation:

- Agent receives node snapshots with queued commands, so it can render the current desired protocol state rather than only the single command payload.
- `protocol-add`, `protocol-delete`, `reset-links`, and `sing-box-apply` require a local `sing-box` binary and fail explicitly if it is missing.
- Apply writes a temporary check config first, runs `sing-box check`, then atomically replaces the target config only after validation passes.
- Existing config files are backed up before replacement.
- `sing-box-render` writes an Agent-local preview config and returns preview links without publishing them as active subscription links.
- Generated links are reported back to the panel only after apply succeeds.

### Subscription Distribution

- Raw, V2Ray, Clash provider output.
- Copy/open/delete custom subscription URLs.
- Reset subscription token.
- Include only enabled and healthy nodes by default.
- Future: per-profile filters by tag, region, protocol, and health status.

### Remote Commands

Panel commands should be represented as typed operations:

- `probe`: collect host/network/service facts.
- `diagnostics`: run local checks and report structured results.
- `reset-link`: regenerate node subscription identity and force Agent to report fresh links.
- `sing-box-install`: install or update sing-box.
- `sing-box-reinstall`: reinstall sing-box from scratch.
- `sing-box-render`: render config without applying.
- `sing-box-apply`: apply validated config.
- `sing-box-restart`: restart sing-box service.
- `shell`: optional advanced command, disabled by default.

Command output should support:

- queued/running/succeeded/failed/cancelled states.
- streaming stdout/stderr chunks.
- progress events.
- final structured result.
- cancellation where possible.

Current implementation:

- Panel persists command events in `commandEvents`.
- Agent can upload event chunks through `POST /api/v1/agents/{agentId}/commands/{commandId}/events`.
- Browser can read history as JSON with `GET /api/v1/commands/{commandId}/events?format=json`.
- Browser can subscribe to live output with SSE at `GET /api/v1/commands/{commandId}/events`.
- Rust Agent emits start and finish/failure events around command execution. Deeper stdout/stderr chunking for long-running installers is still a hardening item.

## Agent Architecture

### Target Architecture

The Agent should be split into three layers:

1. Installer and supervisor
   - POSIX shell installer.
   - Chooses writable install and temp dirs.
   - Installs service through systemd/OpenRC/cron/manual fallback.
   - Installs local shortcut command.

2. Control runtime
   - Maintains identity and panel connection.
   - Handles WebSocket reconnect, auth, command dispatch, and result upload.
   - Starts/stops telemetry collector and sing-box operations.

3. Telemetry collector
   - Samples network counters and host metrics.
   - Computes rates and cumulative traffic.
   - Sends high-frequency deltas to the control runtime.

### Zero-Allocation Traffic Collection

The Agent direction is Rust-only. The Node.js Agent has been removed from the design. Strict zero heap allocation per sample is now a Rust implementation target rather than a JavaScript workaround.

Recommended path:

- Phase 1: Rust control Agent.
  - Native binary install with no Node.js runtime dependency.
  - Enrollment, heartbeat, metrics, diagnostics, command polling, local `PK/pk/RK/rk` commands.
  - Uses a simple HTTP transport while WebSocket and the strict collector are being built.

- Phase 2: Rust zero-allocation traffic collector.
  - Static Rust binary built by GitHub Actions for `linux/amd64`, `linux/arm64`, and best-effort `linux/arm/v7`.
  - Persistent file descriptors for `/proc/net/dev` or sysfs interface counters.
  - Fixed-size stack or preallocated buffers.
  - No heap allocation in the steady-state sample loop.
  - Sends compact binary or line protocol records to the control runtime.

The native collector should handle:

- Counter wrap.
- Interface reset.
- Machine reboot.
- Interface rename.
- Missing `/proc` or restricted container files.
- Monotonic timestamp drift.

### Traffic Accounting

Each traffic sample should include:

- `nodeId`
- `agentId`
- `bootId` if available from `/proc/sys/kernel/random/boot_id`
- `sampleId`
- `monotonicMs`
- `wallTime`
- Interface name
- RX bytes
- TX bytes
- RX rate bytes/sec
- TX rate bytes/sec
- Counter status: `normal`, `wrap`, `reset`, `reboot`, `unknown`

Accounting rules:

- If counter increases normally, delta is current minus previous.
- If counter decreases and boot ID changed, treat as reboot and do not add negative delta.
- If counter decreases and counter width is known, attempt wrap correction.
- If interface disappears, keep last state but mark stale.
- If interface reappears with lower counters, treat as reset unless boot ID changed.
- Never add negative deltas to cumulative traffic.

### WebSocket Real-Time Channel

The Agent should keep one primary WebSocket to the panel:

`/api/v1/agents/{agentId}/ws?token=...`

Message envelope:

```json
{
  "type": "traffic.sample",
  "id": "event-id",
  "time": "2026-06-07T00:00:00.000Z",
  "payload": {}
}
```

Agent to panel messages:

- `hello`: version, platform, arch, boot ID, capabilities.
- `heartbeat`: compact liveness update.
- `traffic.sample`: current rates and counters.
- `metrics.sample`: CPU/memory/load snapshot.
- `command.started`: command execution started.
- `command.output`: stdout/stderr chunk.
- `command.progress`: structured progress.
- `command.finished`: final result.
- `diagnostics.report`: structured checks.

Panel to Agent messages:

- `command.run`: dispatch typed command.
- `command.cancel`: request cancellation.
- `config.update`: deliver rendered config or settings.
- `ping`: keepalive.

Reliability:

- Use sequence IDs.
- Agent should acknowledge command receipt.
- Panel should persist command state before sending.
- Agent should replay final command status after reconnect if panel did not acknowledge it.
- Traffic samples can be lossy; command events cannot.

### SSE Command Output

The panel should expose command output to the browser through SSE:

`GET /api/v1/commands/{commandId}/events`

SSE event types:

- `state`
- `stdout`
- `stderr`
- `progress`
- `result`
- `error`

This endpoint is now implemented for panel users. The browser uses a short-lived query token because native `EventSource` cannot set custom authorization headers.

### GeoIP And Geosite Files

The panel supports local JSON database files without bundling third-party datasets:

- `PULSEDECK_GEOIP_FILE`, default `/app/geoip.json`
- `PULSEDECK_GEOSITE_FILE`, default `/app/geosite.json`

GeoIP entries support:

```json
[
  { "cidr": "203.0.113.0/24", "region": "Tokyo", "countryCode": "JP", "city": "Tokyo" }
]
```

Geosite entries support:

```json
[
  { "suffix": "example.com", "code": "test-sites", "name": "Example Sites" }
]
```

The browser does not need to hold a direct WebSocket to each Agent. The panel receives Agent WebSocket events, persists command output, and fans out browser-visible SSE events.

## Data Model Plan

### Node

- ID, name, region, tags.
- Install ID and subscription identity.
- Agent status and last seen time.
- Online state derived from recent heartbeat.
- Reported addresses.
- Current traffic rate.
- Cumulative traffic totals.
- sing-box service state.

### Agent

- Agent ID, node ID, token.
- Version, platform, arch.
- Install directory, service mode.
- Capabilities.
- Boot ID.
- Last seen time.

### Traffic Sample

For the lightweight first version, keep only recent samples in memory and aggregate totals in persistent state. Full time-series storage is deferred.

Future SQLite tables:

- `traffic_totals`
- `traffic_recent_samples`
- `command_events`
- `audit_events`

### Command

- Command ID, node ID, agent ID.
- Type and payload.
- Status and timestamps.
- Output buffer summary.
- Final result.

## Roadmap

### Stage 0: Foundation

- SoybeanAdmin-based panel.
- Auth.
- Node create/list/delete.
- Agent install/enroll/heartbeat.
- Rust Agent binary scaffold and installer runtime delivery.
- Subscription Profile lifecycle.
- Telegram/email channel settings.
- GHCR build and Compose deployment.

### Stage 1: Reliable Node Control

- Node delete with Agent/command cleanup.
- Reset install/subscription link.
- Better node cards and command history.
- Agent diagnostics hardening.
- sing-box install/status/restart commands.
- Runtime data hygiene and documentation.

### Stage 2: Real-Time Agent Channel

- WebSocket endpoint for Agent.
- Agent reconnect/backoff.
- Real-time heartbeat and traffic push.
- Panel dashboard speed cards.
- SSE command output endpoint.
- Browser command progress viewer.

### Stage 3: Traffic Accounting

- Counter wrap/reboot/reset handling.
- Per-node current rate and daily/monthly totals.
- In-memory recent series for dashboard charts.
- Optional SQLite persistence for recent samples.

### Stage 4: Native Telemetry Core

- Go/Rust native collector for strict zero-allocation sampling.
- Multi-arch GHCR/GitHub release artifacts.
- Rust control runtime invokes or embeds the zero-allocation collector.
- Capability detection and fallback to a lower-frequency Rust sampler when restricted container files prevent strict collection.

### Stage 5: Advanced Subscription And Policy

- Per-profile filters.
- Region/tag/protocol selection.
- Health-based subscription exclusion.
- sing-box template versioning and rollback.
- Optional provider import.

### Stage 6: Optional Extensions

- More notification channels: Telegram, email, webhook, Bark, ntfy, Slack/Discord-compatible webhook.
- Multi-user/RBAC if personal scope is no longer enough.
- SQLite/Postgres migration.
- Prometheus-compatible export.
- Backup/restore.

## Security And Safety

- Agent tokens are per Agent and revocable.
- Install IDs and subscription tokens can be reset.
- Remote shell command should be disabled by default.
- Destructive commands require confirmation in the panel.
- Command output should be size-limited and rotated.
- Secrets should be masked in API responses and command logs.
- Runtime data must stay outside git and outside the Docker image build context where possible.

## Repository Hygiene

Tracked and acceptable:

- Template `.env` files with non-secret build defaults.
- Source code, tests, docs, lockfile, Compose, and CI workflow.

Never tracked:

- `.data/`
- `dist/`
- `node_modules/`
- Runtime `pulsedeck.json`
- SQLite/database files.
- Local smoke JSON.
- GitHub tokens.
- Real Agent tokens or subscription tokens.

## Immediate Implementation Targets

1. Finish Rust Agent multi-arch artifact publishing beyond the initial `linux-x64` Docker-packaged binary.
2. Add reset subscription/install identity API.
3. Add Agent WebSocket protocol skeleton.
4. Add command event persistence and SSE output.
5. Add real-time traffic sample model and dashboard speed cards.
