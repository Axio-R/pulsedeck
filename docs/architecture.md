# PulseDeck Architecture

PulseDeck is split into three parts:

1. Panel API: dependency-light Node.js control plane, JSON persistence for the first version, and static frontend serving.
2. Web panel: SoybeanAdmin-style Vue 3 admin shell with Naive UI components.
3. Agent: Rust Linux runtime installed directly on VPS/LXC hosts.

## Core Loop

1. Operator creates a node in the panel.
2. Panel returns a one-line install command.
3. Agent installer chooses a writable install directory, downloads the Rust Agent binary for the detected target, writes config, installs `PK`/`pk`/`RK`/`rk`, and starts the runtime through systemd/OpenRC/cron/manual fallback.
4. Agent enrolls with the panel using the node install ID.
5. Agent reports heartbeat, host metrics, interface addresses, service status, and diagnostics.
6. Panel classifies IP mode, detects region when GeoIP data is available, accounts cumulative traffic, and enforces traffic threshold auto-disable rules.
7. Panel shows node state, queues commands, exposes subscription Profiles, manages protocol/port records, and triggers alerts.

## First-Version Boundaries

- SQLite/Postgres and distributed workers are intentionally deferred.
- Advanced provider import and full sing-box orchestration are deferred until protocol records, command dispatch, and Agent executor reliability are stable.
- Cloudflare-specific functionality is not part of the first PulseDeck product surface.

## Product Direction

PulseDeck is positioned as a lightweight personal node and subscription management panel. It should prioritize a dependable single-operator workflow over multi-tenant billing, enterprise monitoring, or heavy airport features.

The detailed product and Agent roadmap is maintained in [product-agent-plan.md](./product-agent-plan.md).

Near-term architecture targets:

- Node create/list/delete with related Agent and command cleanup.
- Node protocol management for VMess, VLESS, Trojan, Shadowsocks, Hysteria2, Tuic, AnyTLS, and variants.
- Automatic IP mode classification from Agent-reported addresses.
- Browser WebSocket endpoint for live node traffic snapshots and RX/TX rates.
- Browser SSE endpoint for streamed command output.
- Future Agent WebSocket channel for real-time heartbeat, traffic samples, and remote command dispatch.
- Recent traffic rates in memory, cumulative traffic persisted, and optional SQLite only after the JSON store becomes a bottleneck.
