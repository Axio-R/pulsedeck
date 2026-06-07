# PulseDeck

PulseDeck is a sing-box node management panel built directly on top of the upstream SoybeanAdmin template:

- Real `soybeanjs/soybean-admin` project structure: Vue 3, TypeScript, Naive UI, UnoCSS, Pinia, vue-router, pnpm workspace packages, and Soybean layout/router conventions.
- Rust native Agent for Linux VPS and LXC environments.
- sing-box node enrollment, Agent install, metrics, diagnostics, command queue, subscriptions, and alert channels.
- Browser WebSocket traffic snapshots with live per-node RX/TX rates.
- Agent runtime manifest with per-architecture availability, size, and SHA-256 metadata for installer/update verification.
- Default panel port: `14770`.

## Deployment Rule

Do not build Docker images locally for normal deployment. Push to GitHub, wait for GitHub Actions to publish `ghcr.io/axio-r/pulsedeck:latest`, then deploy locally:

```bash
docker compose pull
docker compose up -d
```

## Development

```bash
npm test
npm run check:api
corepack pnpm build
npm start
```

The panel API remains a dependency-light Node.js control plane. The Agent is a Rust native binary; GHCR image builds compile and package the Agent runtime for installer download.

The Rust Agent can render/apply sing-box configs for the supported protocol records. Production TLS/Reality variants require the corresponding settings JSON, such as SNI, certificate/key paths, or Reality private/public key material.

Agent runtime metadata is exposed at `/api/v1/agents/runtime/manifest`. `pk` opens the interactive Agent menu, `pk status` prints the quick status view, `pk update-check` reports the panel runtime version, size, and SHA-256, and `pk update` verifies the downloaded binary before replacing the local Agent.
