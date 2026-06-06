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
