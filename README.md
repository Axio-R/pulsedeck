# PulseDeck

PulseDeck is a fresh rebuild of the node operations panel concept:

- SoybeanAdmin-inspired Vue 3 + Naive UI panel shell.
- Probe-style Agent for Linux VPS and LXC environments.
- Node enrollment, metrics, diagnostics, command queue, subscriptions, and alert channels.
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
npm run check
npm run build:web
npm start
```

The first version keeps the backend dependency-free and uses Vue/Naive UI for the panel build.
