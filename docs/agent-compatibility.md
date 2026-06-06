# Agent Compatibility Plan

PulseDeck Agent targets practical VPS environments first:

- Linux distributions with systemd.
- Alpine/OpenRC hosts where possible.
- LXC/container VPS hosts with restricted `/proc`, limited `/tmp`, no systemd, or low root filesystem space.
- Architectures: `x86_64`, `aarch64`, and best-effort `armv7l`.

## Installer Strategy

- Do not assume `/opt` or `/tmp` is writable.
- Test candidate install directories before selecting one.
- Prefer system Node.js 20+ when available.
- Bootstrap a private Node.js runtime when the system runtime is missing or too old.
- Create both `PK` and `pk` command shortcuts.
- Install service through systemd, OpenRC, cron `@reboot`, or manual fallback.

## Runtime Strategy

- Metrics collection degrades gracefully when `/proc`, cgroup files, or network interface data are restricted.
- Diagnostics report missing capabilities instead of failing the Agent loop.
- Local commands must work even if the panel is unreachable.

## Traffic Collector Direction

The current Node-based Agent is suitable for early low-allocation telemetry and command control, but it cannot strictly guarantee zero heap allocation in a per-second sampling loop.

For precise real-time traffic monitoring, the planned Agent architecture separates the hot collector from the control runtime:

- Keep the control runtime responsible for enrollment, WebSocket reconnect, commands, and sing-box operations.
- Add a future native Go/Rust collector built by GitHub Actions for multi-arch Linux targets.
- Use persistent counter file descriptors and fixed/preallocated buffers in the native collector.
- Handle counter wrap, interface reset, machine reboot, and restricted LXC files without adding negative traffic deltas.

See [product-agent-plan.md](./product-agent-plan.md) for the protocol and staged implementation plan.
