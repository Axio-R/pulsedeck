# PulseDeck

PulseDeck is a sing-box node management panel built directly on top of the upstream SoybeanAdmin template:

- Real `soybeanjs/soybean-admin` project structure: Vue 3, TypeScript, Naive UI, UnoCSS, Pinia, vue-router, pnpm workspace packages, and Soybean layout/router conventions.
- Probe-style Agent for Linux VPS and LXC environments.
- sing-box node enrollment, Agent install, metrics, diagnostics, command queue, subscriptions, and alert channels.
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
pnpm check:api
pnpm build
npm start
```

The API and Agent remain dependency-light Node.js modules. The frontend follows SoybeanAdmin and should be developed with pnpm.
