# PulseDeck Worklog

This file is the source of truth for the new PulseDeck project. Keep it separate from `/root/relaydeck/WORKLOG.md` so the old RelayDeck history does not mix with the new rebuild.

## Current Task

- Build a new project named `PulseDeck` in `/root/pulsedeck`.
- Treat this as a fresh sing-box node management panel, not a cosmetic RelayDeck patch.
- Corrected frontend direction: use the real upstream `soybeanjs/soybean-admin` template as the base project, then modify routes, pages, stores, request services, and layout content for sing-box node management. Do not merely imitate the style with a hand-written shell.
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
  - Rust native Agent binary; node machines must not need Node.js.
  - GHCR-built Agent binaries for `linux-x64`, `linux-arm64`, and best-effort `linux-armv7l`.
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
- [x] Initialize git repository and first commit.
- [x] Create GitHub repository `Axio-R/pulsedeck`.
- [x] Push, wait for GHCR image, deploy locally on port `14770`, and smoke test.
- [x] Correct direction: import the real upstream SoybeanAdmin template as the frontend foundation.
- [x] Replace the temporary hand-written Vue shell with SoybeanAdmin project structure.
- [x] Finish local SoybeanAdmin-based sing-box panel verification.
- [x] Push, wait for GHCR, and redeploy.

## Log

### 2026-06-07

- User requested a full Agent direction change:
  - Remove the Node.js Agent.
  - Use Rust for the Agent.
  - Redesign the Agent architecture around native low-overhead collection and control.
- Implementation direction for this turn:
  - Replace the old JavaScript Agent bootstrap installer with Rust binary download and install.
  - Add a Rust Agent project and local command UX using a native binary.
  - Change panel runtime delivery from JavaScript runtime download to Rust binary download by target.
  - Update scripts, tests, docs, and WORKLOG so the old JavaScript Agent is no longer part of the Agent plan.
  - Keep panel API/frontend in Node/Vue for now; the requested change is specifically Agent runtime architecture.
- Rust Agent replacement implemented in the working tree:
  - Deleted the previous JavaScript Agent runtime.
  - Added `apps/agent` as a Rust project with native local commands: `status`, `menu`, `once`, `logs`, `doctor`, `restart`, `update`, `config`, and `version`.
  - Rewrote the installer to detect `linux-x64`, `linux-arm64`, or `linux-armv7l`, download the Rust binary, create `PK`/`pk`/`RK`/`rk` shortcuts, and install systemd/OpenRC/cron/manual service startup.
  - Changed the API runtime endpoint to serve `agent-dist/{target}/pulsedeck-agent` binaries.
  - Updated the Dockerfile so GitHub Actions builds and packages Rust Agent binaries for x64, arm64, and armv7l without any local Docker build.
  - Added QEMU setup in the GHCR workflow for the cross-architecture Agent build stages.
  - Updated tests, README, settings UI, and Agent/architecture docs for the Rust-only Agent direction.
  - Local machine has no `cargo`; Rust compilation will be validated by GitHub Actions/GHCR.
- Local verification after Rust Agent replacement:
  - `npm run check:api`: passed.
  - `npm test`: passed, 6 tests.
  - `corepack pnpm typecheck`: passed.
  - `corepack pnpm build`: passed.
  - No local Docker image build was performed.
- User clarified PulseDeck positioning: lightweight personal node and subscription management panel, not a heavy multi-tenant operations platform.
- New planning requirements captured:
  - Create a complete project function design and staged roadmap.
  - Design the Agent architecture and features around real-time traffic monitoring, low-overhead collection, bidirectional WebSocket control, remote sing-box operations, and streamed command output.
  - Real-time traffic requirements include persistent file descriptors, fixed stack buffers/low-allocation sampling, WebSocket rate push, counter wrap/reboot handling, and reliable traffic accounting.
  - Remote command requirements include reset node subscription link, reinstall/update sing-box, command execution progress, and streamed output suitable for SSE display in the panel.
  - Audit whether local smoke/deployment data is tracked in git.
  - Add or expose deletion for created nodes if missing.
- Initial repository audit:
  - `git status --short`: clean before new edits.
  - Tracked files do not include `.data/`, `dist/`, `node_modules/`, runtime JSON data, or smoke node records.
  - `.env`, `.env.prod`, and `.env.test` are tracked and need review to ensure they only contain non-secret template values.
  - Existing API supports deleting subscription Profiles but not created nodes yet.
- Product and Agent planning document added:
  - Created `docs/product-agent-plan.md` for lightweight personal panel positioning, function modules, Agent architecture, real-time traffic design, WebSocket protocol, SSE command output, staged roadmap, security rules, and repository hygiene.
  - Clarified that strict zero-allocation per-second traffic sampling cannot be guaranteed in the current Node.js Agent; the planned strict path is a future native Go/Rust telemetry collector built by GitHub Actions, while the current Agent remains a low-allocation control/runtime layer.
  - Updated `docs/architecture.md`, `docs/agent-compatibility.md`, and `docs/ui-plan.md` to reference the new direction.
- Repository hygiene update:
  - Reviewed tracked `.env` files; they contain non-secret frontend build defaults only.
  - Added ignore rules for runtime JSON, SQLite/database files, and temporary files to reduce the chance of committing local deployment/smoke data later.
- Node deletion implementation started:
  - Added `DELETE /api/v1/nodes/{nodeId}` to remove the node and cleanup related Agent/command records.
  - Added frontend API helper and node page delete confirmation actions in table/card views.
  - Added API test coverage for deleting a node and purging related commands.
- Verification after planning and node deletion work:
  - `npm run check:api`: passed.
  - `npm test`: passed, 6 tests.
  - `corepack pnpm typecheck`: passed.
  - `corepack pnpm build`: passed.
  - Diff scan confirms no `dist/`, `node_modules/`, `.data/`, runtime JSON, or smoke node data is staged for commit.
  - Token scan found no GitHub token or real panel IP; only the documented default password `change-me` remains in template/test files.
- Committed and pushed `02ed313 Plan Agent architecture and add node deletion` to `origin/main`.
- GitHub Actions run `27068182087` for commit `02ed313`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`.
- `docker compose pull`: pulled the GHCR image after the workflow completed.
- `docker compose up -d`: recreated and started `pulsedeck-panel`; no local Docker image build was run.
- `docker compose ps`: `pulsedeck-panel` is `Up` with `0.0.0.0:14770->14770/tcp` and `[::]:14770->14770/tcp`.
- `GET http://127.0.0.1:14770/api/v1/health`: passed with `name: PulseDeck` and `port: 14770`.
- Post-deploy smoke passed:
  - Soybean-compatible login with `admin / change-me` returned `R_SUPER`.
  - Created a temporary node, queued one `probe` command, deleted the node through `DELETE /api/v1/nodes/{nodeId}`, and verified the node was no longer listed.
  - Delete response reported `deleted: true` and `removedCommands: 1`, confirming related command cleanup.

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
- Implemented first Agent skeleton, superseded by the Rust Agent redesign on 2026-06-07:
  - Probe-style metrics collection from `/proc`, `os`, and network interfaces with graceful degradation.
  - Local `PK`/`pk` command UX for status, menu, once, logs, doctor, restart, update, config, and version.
  - Installer script renderer with adaptive install/temp directory selection, x64/arm64/armv7l platform mapping, systemd/OpenRC/cron/manual service fallback, and LXC-friendly assumptions.
- Implemented first SoybeanAdmin-style Vue/Naive UI shell:
  - Sidebar/topbar admin layout, dashboard, nodes, subscriptions, alert channels, command queue, and settings views.
  - Current-view-only data loading pattern.
- Added API/store tests for health/default port, node install script compatibility markers, and subscription Profile deletion rules.
- Verification so far:
  - `npm run check`: passed for API, store, install-script renderer, and Agent runtime syntax.
  - `npm test`: passed, 4 tests.
  - Attempted local `npm install` only to validate frontend build, but registry/network response produced no output for an extended period. The process was stopped, no `node_modules` or `package-lock.json` remained, and no Docker image was built locally. Frontend dependency install/build will be validated by GitHub Actions when the repository is pushed.
- Created the first local commit for `Initial PulseDeck rebuild`; after final amend it was pushed as `f5f641bd1e0d59ac055b1649802a2f5c8002ff01`.
- Created/confirmed GitHub repository `Axio-R/pulsedeck`: `https://github.com/Axio-R/pulsedeck`, public.
- Pushed initial commit `f5f641bd1e0d59ac055b1649802a2f5c8002ff01` to `origin/main`.
- GitHub Actions run `27065040964` for commit `f5f641b`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`. This also validated dependency install and the Vue/Vite frontend build in CI.
- `docker compose pull`: pulled `ghcr.io/axio-r/pulsedeck:latest` after the GHCR workflow completed.
- `docker compose up -d`: created and started `pulsedeck-panel`; no local Docker image build was run.
- `docker compose ps`: `pulsedeck-panel` is `Up` with `0.0.0.0:14770->14770/tcp` and `[::]:14770->14770/tcp`.
- `GET http://127.0.0.1:14770/api/v1/health`: passed with `name: PulseDeck` and `port: 14770`.
- Post-deploy smoke passed against the Compose deployment:
  - Login with default credentials succeeded.
  - Created smoke node `smoke-lxc-node`.
  - Fetched `/api/v1/agents/install/{install_id}` and confirmed PK/pk shortcut creation, `PULSEDECK_AGENT_HOME`, `/var/lib/pulsedeck`, `/opt/pulsedeck`, `linux-x64`, `linux-arm64`, `linux-armv7l`, systemd, OpenRC, and `cron-manual` fallback markers.
  - `/api/v1/subscription-profiles` returns default protected Profiles with `deletable: false` for `default-raw`.
- Direction correction from user:
  - The frontend must directly use `https://github.com/soybeanjs/soybean-admin` as the template foundation.
  - PulseDeck should be rebuilt as a sing-box node management panel on top of that template.
  - The earlier custom lightweight Vue shell is considered the wrong foundation and should be replaced by the real SoybeanAdmin project structure.
- Imported upstream SoybeanAdmin template files into PulseDeck:
  - Added `src/`, `packages/`, `build/`, `public/`, `index.html`, Vite, UnoCSS, TypeScript, pnpm workspace, and template config files from `soybeanjs/soybean-admin`.
  - Replaced the temporary `apps/web` frontend with SoybeanAdmin root frontend structure.
  - Converted `package.json` to SoybeanAdmin pnpm workspace dependencies while preserving PulseDeck API/Agent scripts.
  - Changed Dockerfile to use `corepack`/`pnpm install --frozen-lockfile` and `pnpm build` in GitHub Actions/Docker build, then serve root `dist` from the API runtime image.
  - Set Soybean env values to PulseDeck title, `/api/v1` backend base URL, storage prefix, dashboard home route, and dev preview ports.
  - Added Soybean routes/pages for Dashboard, Nodes, sing-box Config, Subscriptions, Alerts, Commands, and Settings.
  - Added a PulseDeck frontend API service under Soybean `src/service/api`.
  - Added Soybean-compatible auth responses in the PulseDeck API while keeping existing API behavior for tests.
- Removed the temporary hand-written `apps/web` frontend files and the Soybean demo `home` view so the generated route set uses `dashboard` as the home route.
- Fixed Soybean/pnpm strict dependency issues by adding explicit root dependencies used by the template build: `axios@1.16.0`, `@iconify/utils@3.1.3`, `@unocss/core@66.6.8`, and `@unocss/preset-mini@66.6.8`.
- Verification after Soybean import:
  - `corepack pnpm install --frozen-lockfile --ignore-scripts`: passed.
  - `corepack pnpm build`: passed and generated `dist`.
  - `corepack pnpm typecheck`: passed.
  - `npm run check:api`: passed.
  - `npm test`: passed, 5 tests.
  - Route scan found no old `home` route references in generated router/typing/locale files.
  - Token/mock scan found no GitHub token or old Apifox token strings in tracked source areas.
- Committed and pushed `7a0a141 Rebase panel on SoybeanAdmin template` to `origin/main`.
- GitHub Actions run `27066095204` for commit `7a0a141`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`.
- `docker compose pull`: pulled the GHCR image after the workflow completed.
- `docker compose up -d`: recreated and started `pulsedeck-panel`; no local Docker image build was run.
- `docker compose ps`: `pulsedeck-panel` is `Up` with `0.0.0.0:14770->14770/tcp` and `[::]:14770->14770/tcp`.
- `GET http://127.0.0.1:14770/api/v1/health`: passed with `name: PulseDeck` and `port: 14770`.
- `GET http://127.0.0.1:14770/`: returned the SoybeanAdmin-built HTML with `<title>PulseDeck</title>` and built assets under `/assets/`.
- Post-deploy smoke passed against the Compose deployment:
  - Soybean-compatible login returned `code: "0000"`, `token`, and `refreshToken`.
  - `/api/v1/auth/getUserInfo` returned `R_SUPER` for the default admin session.
  - Created smoke node `soybean-singbox-smoke`.
  - Fetched the Agent install script and confirmed `PK/pk`, `PULSEDECK_AGENT_HOME`, `/var/lib/pulsedeck`, and x64/arm64/armv7l runtime markers.
  - Subscription Profiles still protect `default-raw` with `deletable: false`.
- Login validation bug reported after SoybeanAdmin deployment:
  - The default backend/Compose password is `change-me`, but the upstream SoybeanAdmin form rule only allowed `\\w{6,18}` and blocked hyphenated passwords before sending the login request.
  - Fixed the frontend password rule to allow 6-64 characters from letters, numbers, and common safe symbols `._-@#$%+!`.
  - Updated Chinese and English validation messages so the UI no longer says passwords are limited to letters, numbers, and underscores.
  - Verification after the fix: `corepack pnpm typecheck`, `corepack pnpm build`, `npm run check:api`, and `npm test` all passed.
  - Committed and pushed `85e8734 Fix Soybean login password validation` to `origin/main`.
  - GitHub Actions run `27066493658` for commit `85e8734`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`.
  - `docker compose pull` and `docker compose up -d`: deployed the GHCR image for `85e8734`; no local Docker image build was run.
  - `GET http://127.0.0.1:14770/api/v1/health`: passed after deployment.
  - Deployment asset check found the old `6-18` password text absent and the new `6-64` password text present in built assets.
  - Post-deploy login smoke with `admin / change-me` passed through the Soybean-compatible auth contract and returned `R_SUPER`.
- Recorded the login validation deployment details in worklog-only commit `858cb90 Record login validation deployment` and pushed it to `origin/main`.
- GitHub Actions run `27066718831` for commit `858cb90`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`.
- `docker compose pull`: pulled the GHCR image for the latest `main` state after the workflow completed.
- `docker compose up -d`: recreated and started `pulsedeck-panel`; no local Docker image build was run.
- `docker compose ps`: `pulsedeck-panel` is `Up` with `0.0.0.0:14770->14770/tcp` and `[::]:14770->14770/tcp`.
- `GET http://127.0.0.1:14770/api/v1/health`: passed with `name: PulseDeck` and `port: 14770`.
- Post-deploy login smoke with `admin / change-me` passed after the latest GHCR deployment:
  - Soybean-compatible login returned token and refresh token.
  - `/api/v1/auth/getUserInfo` returned `user: admin` and `roles: ["R_SUPER"]`.
- New login page rendering bug reported:
  - Browser login page shows only `PulseDeck` and `密码登录`.
  - Username/password inputs are not visible or not interactable.
  - Initial source check confirms `pwd-login.vue` still contains the username/password form, so the likely fault is runtime rendering, CSS/layout clipping, component resolution, or a client-side exception in the Soybean login module.
  - Next action: reproduce against the deployed `14770` panel, inspect generated assets/runtime errors, simplify the login module if needed, then commit, push, wait for GHCR, and redeploy from GHCR only.
- Login page rendering fix implemented locally:
  - Replaced the Soybean default login card/transition wrapper with a PulseDeck-specific stable login panel that can scroll on small screens.
  - Replaced the critical password login form with native username/password inputs and a native submit button to avoid blank login caused by dynamic form component/layout issues.
  - Kept the default credentials visible as `admin / change-me`.
  - Removed scoped dark-mode overrides that were being minified into unintended global `html.dark` CSS.
  - Verification passed: `corepack pnpm typecheck`, `corepack pnpm build`, `npm run check:api`, and `npm test`.
  - Built assets now contain `pulse-input`, `默认账号：admin / change-me`, and `请输入账号和密码`; login CSS no longer contains unintended `html.dark` rules.
- Committed and pushed `3bd3485 Stabilize PulseDeck login form rendering` to `origin/main`.
- GitHub Actions run `27067475841` for commit `3bd3485`: completed successfully and published `ghcr.io/axio-r/pulsedeck:latest`.
- `docker compose pull`: pulled the GHCR image after the workflow completed.
- `docker compose up -d`: recreated and started `pulsedeck-panel`; no local Docker image build was run.
- `docker compose ps`: `pulsedeck-panel` is `Up` with `0.0.0.0:14770->14770/tcp` and `[::]:14770->14770/tcp`.
- `GET http://127.0.0.1:14770/api/v1/health`: passed with `name: PulseDeck` and `port: 14770`.
- Post-deploy login smoke with `admin / change-me` passed through the Soybean-compatible auth contract and returned `R_SUPER`.
- Deployment asset check found `pulse-input`, `默认账号：admin / change-me`, and `请输入账号和密码` in the served login assets, and found no `html.dark` login CSS rule.

## Next Targets

1. Import the real SoybeanAdmin template into PulseDeck and keep its project structure instead of the temporary single-file Vue shell.
2. Rework SoybeanAdmin routes/pages into sing-box node management modules: dashboard, nodes, Agent install, sing-box configs, subscriptions, alerts, commands, and settings.
3. Keep the existing PulseDeck API/Agent work only where it fits the new sing-box panel direction; replace mismatched frontend assumptions.
4. Deepen Agent compatibility: Alpine/musl handling, Debian/Ubuntu/CentOS package hints, lower-memory Node runtime fallback guidance, LXC cgroup v1/v2 detection, and package checksum verification.
5. Add subscription link generation from real Agent-reported sing-box inbounds after node lifecycle is stable.
