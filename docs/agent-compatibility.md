# Agent Compatibility Plan

PulseDeck Agent targets practical VPS environments first:

- Linux distributions with systemd.
- Alpine/OpenRC hosts where possible.
- LXC/container VPS hosts with restricted `/proc`, limited `/tmp`, no systemd, or low root filesystem space.
- Architectures: `x86_64`, `aarch64`, and best-effort `armv7l`.

## Installer Strategy

- Do not assume `/opt` or `/tmp` is writable.
- Test candidate install directories before selecting one.
- Download the Rust Agent binary for the detected target from the panel runtime endpoint.
- Do not require Node.js on the node machine.
- Create `PK`, `pk`, `RK`, and `rk` command shortcuts for compatibility with the earlier command naming.
- Install service through systemd, OpenRC, cron `@reboot`, or manual fallback.

The GHCR image builds and packages Rust Agent binaries for `linux-x64`, `linux-arm64`, and `linux-armv7l` so a panel running on one architecture can install nodes on another supported architecture.

## Runtime Strategy

- Metrics collection degrades gracefully when `/proc`, cgroup files, or network interface data are restricted.
- Diagnostics report missing capabilities instead of failing the Agent loop.
- Local commands must work even if the panel is unreachable.
- sing-box operations degrade explicitly: render-only commands can work without a local `sing-box` binary, but apply/protocol/reset operations fail with a clear result until `sing-box` is installed.
- The Agent validates configs with `sing-box check` before replacing the target config file.
- Service restart tries systemd, OpenRC, then generic `service`; if none succeeds, the command result records that validation passed but restart was not confirmed.
- Agent-driven sing-box install/update can use an explicit binary URL from command payload or `PULSEDECK_SING_BOX_DOWNLOAD_URL`. It can also select an official versioned `SagerNet/sing-box` Linux release tarball from `payload.version` or `PULSEDECK_SING_BOX_VERSION`, extract the embedded binary, and verify an optional SHA-256 checksum.
- Automatic package-manager install is deferred to avoid distro-specific side effects.
- Command event uploads are best-effort. If an event upload fails because the panel is temporarily unreachable, the Agent still uploads the final command result on the normal result endpoint when possible.

## Rust Traffic Collector Direction

The Agent direction is Rust-only. The Node.js Agent has been removed.

For precise real-time traffic monitoring, the planned Agent architecture separates the hot collector from the control runtime:

- Keep the control runtime responsible for enrollment, WebSocket reconnect, commands, and sing-box operations.
- Add a Rust collector built by GitHub Actions for multi-arch Linux targets.
- Use persistent counter file descriptors and fixed/preallocated buffers in the native collector.
- Handle counter wrap, interface reset, machine reboot, and restricted LXC files without adding negative traffic deltas.

See [product-agent-plan.md](./product-agent-plan.md) for the protocol and staged implementation plan.
