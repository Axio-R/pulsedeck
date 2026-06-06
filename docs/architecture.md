# PulseDeck Architecture

PulseDeck is split into three parts:

1. Panel API: dependency-light Node.js control plane, JSON persistence for the first version, and static frontend serving.
2. Web panel: SoybeanAdmin-style Vue 3 admin shell with Naive UI components.
3. Agent: probe-style Linux runtime installed directly on VPS/LXC hosts.

## Core Loop

1. Operator creates a node in the panel.
2. Panel returns a one-line install command.
3. Agent installer chooses a writable install directory, bootstraps Node.js 20+ if needed, writes config, installs `PK`/`pk`, and starts the runtime through systemd/OpenRC/cron/manual fallback.
4. Agent enrolls with the panel using the node install ID.
5. Agent reports heartbeat, host metrics, interface addresses, service status, and diagnostics.
6. Panel shows node state, queues commands, exposes subscription Profiles, and triggers alerts.

## First-Version Boundaries

- SQLite/Postgres and distributed workers are intentionally deferred.
- Advanced provider import and sing-box orchestration are deferred until probe enrollment and dashboard reliability are stable.
- Cloudflare-specific functionality is not part of the first PulseDeck product surface.
