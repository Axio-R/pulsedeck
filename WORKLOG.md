# PulseDeck Worklog

This file is the source of truth for the new PulseDeck project. Keep it separate from `/root/relaydeck/WORKLOG.md` so the old RelayDeck history does not mix with the new rebuild.

## Current Task

- Build a new project named `PulseDeck` in `/root/pulsedeck`.
- Treat this as a fresh product redesign, not a cosmetic RelayDeck patch.
- Frontend direction: SoybeanAdmin-inspired Vue 3 admin shell, Naive UI-style dense operations layout, clearer functional sections, and simpler cross-feature workflows.
- Agent direction: probe-style lightweight node runtime inspired by projects such as Komari, with host metrics, network addresses, service/process status, diagnostics, and clear local command UX.
- Default panel port: `14770`, chosen to avoid conflicts with existing projects.
- Agent compatibility is a first-class requirement: support common Linux distributions, systemd/OpenRC/non-systemd hosts, x86_64/aarch64/armv7 where possible, and low-resource LXC/container VPS environments.

## Standing Rules

1. Keep this worklog updated during the work, especially before and after major implementation, commit, push, image build, and deployment steps.
2. Do not store GitHub tokens in files, git config, docs, Compose files, logs, or source.
3. Do not build Docker images locally for deployment or testing. Use GitHub Actions to build and publish GHCR images, then deploy locally with `docker compose pull` and `docker compose up -d`.
4. Deployment order after pushed changes: commit -> push -> wait for GitHub Actions/GHCR image -> `docker compose pull` -> `docker compose up -d` -> health check and smoke test.
5. Keep the first version focused on the main control loop before porting advanced modules.

## First-Version Scope

- Panel API:
  - Auth login/session.
  - Dashboard summary.
  - Node/probe enrollment.
  - Agent install script endpoint.
  - Agent heartbeat, metrics report, diagnostics report, and command queue basics.
  - Subscription Profile lifecycle, including create/update/delete for custom Profiles and protected defaults.
  - Basic notification channel config for Telegram and email.
- Frontend:
  - SoybeanAdmin-style shell with sidebar, topbar, compact dashboard cards, table/cards for nodes, subscription URL cards, alert settings, and command history.
  - Chinese-first operations copy.
  - Lightweight loading pattern: fetch only data needed for the current view.
- Agent:
  - Portable POSIX shell installer.
  - Private Node.js runtime bootstrap where host Node.js is missing or too old.
  - Adaptive writable install/temp directory selection for low-space or restricted LXC hosts.
  - Local command shortcut `PK` plus lowercase `pk` for status, menu, logs, doctor, restart, update, config, and once.
  - Metrics collection should degrade gracefully when `/proc`, cgroup, or network interface data is restricted.
- Deployment:
  - `compose.yaml` maps host port `14770` to container port `14770`.
  - GHCR image target: `ghcr.io/axio-r/pulsedeck:latest`.
  - No local Docker image build.

## Progress

- [x] Created independent project directory `/root/pulsedeck`.
- [x] Created independent PulseDeck worklog.
- [x] Scaffold PulseDeck repository.
- [x] Implement first API/server skeleton.
- [x] Implement SoybeanAdmin-style frontend shell.
- [x] Implement probe-style Agent skeleton and installer.
- [x] Add tests and syntax checks.
- [x] Add Dockerfile, Compose, and GHCR workflow.
- [ ] Initialize git repository and first commit.
- [ ] Create GitHub repository `Axio-R/pulsedeck`.
- [ ] Push, wait for GHCR image, deploy locally on port `14770`, and smoke test.

## Log

### 2026-06-06

- User requested a fresh rebuild/new project instead of continuing RelayDeck UI patches.
- Chosen working name: `PulseDeck`.
- Created `/root/pulsedeck/WORKLOG.md` as the independent progress record.
- Captured hard requirements: SoybeanAdmin-style panel redesign, Komari/probe-inspired Agent, broad Linux/architecture/LXC compatibility, default port `14770`, real-time worklog updates, and no local Docker builds.
- Added project foundation files:
  - `package.json` with Node API, Agent, test, syntax-check, and Vite web build scripts.
  - `Dockerfile` and `compose.yaml` using `ghcr.io/axio-r/pulsedeck:latest` and host/container port `14770`.
  - GitHub Actions workflow for publishing the GHCR image on push to `main`.
  - Architecture, UI plan, and Agent compatibility docs.
- Implemented first API skeleton:
  - Auth login, health, dashboard summary, node creation/listing, node command queue, Agent install/runtime endpoints, Agent enroll/heartbeat/metrics/diagnostics/command-result endpoints, subscription Profile lifecycle, public subscription output, and Telegram/email notification channel config.
  - JSON persistence with default protected subscription Profiles.
- Implemented Agent skeleton:
  - Probe-style metrics collection from `/proc`, `os`, and network interfaces with graceful degradation.
  - Local `PK`/`pk` command UX for status, menu, once, logs, doctor, restart, update, config, and version.
  - Installer script renderer with adaptive install/temp directory selection, private Node.js runtime bootstrap, x64/arm64/armv7l platform mapping, systemd/OpenRC/cron/manual service fallback, and LXC-friendly assumptions.
- Implemented first SoybeanAdmin-style Vue/Naive UI shell:
  - Sidebar/topbar admin layout, dashboard, nodes, subscriptions, alert channels, command queue, and settings views.
  - Current-view-only data loading pattern.
- Added API/store tests for health/default port, node install script compatibility markers, and subscription Profile deletion rules.
- Verification so far:
  - `npm run check`: passed for API, store, install-script renderer, and Agent runtime syntax.
  - `npm test`: passed, 4 tests.
  - Attempted local `npm install` only to validate frontend build, but registry/network response produced no output for an extended period. The process was stopped, no `node_modules` or `package-lock.json` remained, and no Docker image was built locally. Frontend dependency install/build will be validated by GitHub Actions when the repository is pushed.
- Created the first local commit for `Initial PulseDeck rebuild`; final pushed commit SHA will be recorded after the GitHub repository is created and pushed.
