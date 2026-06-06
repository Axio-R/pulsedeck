export function renderAgentInstallScript({ baseUrl, installId }) {
  const safeBaseUrl = String(baseUrl).replace(/'/g, "'\"'\"'");
  const safeInstallId = String(installId).replace(/'/g, "'\"'\"'");

  return `#!/bin/sh
set -u

PULSEDECK_BASE_URL='${safeBaseUrl}'
PULSEDECK_INSTALL_ID='${safeInstallId}'
PULSEDECK_NODE_VERSION='20.20.2'
PULSEDECK_APP='PulseDeck'

say() { printf '%s\\n' "[PulseDeck] $*"; }
die() { say "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

try_mkdir() {
  dir="$1"
  [ -n "$dir" ] || return 1
  mkdir -p "$dir" >/dev/null 2>&1 || return 1
  [ -w "$dir" ] || return 1
  return 0
}

space_ok() {
  dir="$1"
  min_kb="$2"
  if have df; then
    avail="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
    [ -n "$avail" ] || return 0
    [ "$avail" -ge "$min_kb" ] || return 1
  fi
  return 0
}

choose_base_dir() {
  for dir in "\${PULSEDECK_AGENT_HOME:-}" /var/lib/pulsedeck /opt/pulsedeck "\${HOME:-}/.pulsedeck"; do
    [ -n "$dir" ] || continue
    if try_mkdir "$dir" && space_ok "$dir" 51200; then
      printf '%s\\n' "$dir"
      return 0
    fi
  done
  die "No writable install directory with enough space. Set PULSEDECK_AGENT_HOME to a writable path."
}

choose_tmp_dir() {
  base="$1"
  for dir in "$base/tmp" "\${TMPDIR:-}" /var/tmp /tmp; do
    [ -n "$dir" ] || continue
    if try_mkdir "$dir" && space_ok "$dir" 20480; then
      printf '%s\\n' "$dir"
      return 0
    fi
  done
  die "No writable temp directory with enough space. Set TMPDIR or PULSEDECK_AGENT_HOME."
}

download() {
  url="$1"
  out="$2"
  if have curl; then
    curl -fsSL "$url" -o "$out"
  elif have wget; then
    wget -qO "$out" "$url"
  else
    die "curl or wget is required."
  fi
}

node_major() {
  "$1" -v 2>/dev/null | sed 's/^v//' | awk -F. '{print $1}'
}

node_platform() {
  machine="$(uname -m 2>/dev/null || printf unknown)"
  case "$machine" in
    x86_64|amd64) printf 'linux-x64' ;;
    aarch64|arm64) printf 'linux-arm64' ;;
    armv7l|armv7*) printf 'linux-armv7l' ;;
    *) printf 'unsupported' ;;
  esac
}

ensure_node() {
  base="$1"
  tmp="$2"
  if have node; then
    major="$(node_major node || printf 0)"
    if [ "\${major:-0}" -ge 20 ] 2>/dev/null; then
      command -v node
      return 0
    fi
  fi

  platform="$(node_platform)"
  [ "$platform" != "unsupported" ] || die "Unsupported CPU architecture: $(uname -m 2>/dev/null || printf unknown). Install Node.js 20+ manually and rerun."

  runtime_dir="$base/runtime/node-v$PULSEDECK_NODE_VERSION-$platform"
  node_bin="$runtime_dir/bin/node"
  if [ -x "$node_bin" ]; then
    printf '%s\\n' "$node_bin"
    return 0
  fi

  say "Installing private Node.js runtime v$PULSEDECK_NODE_VERSION for $platform."
  mkdir -p "$base/runtime" || die "Cannot create runtime directory."
  archive="$tmp/node-v$PULSEDECK_NODE_VERSION-$platform.tar.xz"
  download "https://nodejs.org/dist/v$PULSEDECK_NODE_VERSION/node-v$PULSEDECK_NODE_VERSION-$platform.tar.xz" "$archive" || die "Node.js runtime download failed."
  tar -xJf "$archive" -C "$base/runtime" || die "Node.js runtime extraction failed. Install xz/tar support or system Node.js 20+."
  [ -x "$node_bin" ] || die "Private Node.js runtime is incomplete."
  printf '%s\\n' "$node_bin"
}

install_shortcut() {
  name="$1"
  target="$2"
  if try_mkdir /usr/local/bin; then
    shortcut="/usr/local/bin/$name"
  else
    mkdir -p "$BASE_DIR/bin" || die "Cannot create shortcut directory."
    shortcut="$BASE_DIR/bin/$name"
  fi
  cat > "$shortcut" <<EOF
#!/bin/sh
export PULSEDECK_AGENT_CONFIG="$CONFIG_FILE"
exec "$NODE_BIN" "$AGENT_FILE" "\\$@"
EOF
  chmod +x "$shortcut" || true
  printf '%s\\n' "$shortcut"
}

install_service() {
  if [ "$(id -u 2>/dev/null || printf 1)" = "0" ] && have systemctl && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/pulsedeck-agent.service <<EOF
[Unit]
Description=PulseDeck Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PULSEDECK_AGENT_CONFIG=$CONFIG_FILE
ExecStart=$NODE_BIN $AGENT_FILE daemon
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now pulsedeck-agent.service >/dev/null 2>&1 || return 1
    printf 'systemd\\n'
    return 0
  fi

  if [ "$(id -u 2>/dev/null || printf 1)" = "0" ] && have rc-service && [ -d /etc/init.d ]; then
    cat > /etc/init.d/pulsedeck-agent <<EOF
#!/sbin/openrc-run
name="PulseDeck Agent"
command="$NODE_BIN"
command_args="$AGENT_FILE daemon"
command_background=true
pidfile="/run/pulsedeck-agent.pid"
export PULSEDECK_AGENT_CONFIG="$CONFIG_FILE"
EOF
    chmod +x /etc/init.d/pulsedeck-agent || true
    rc-update add pulsedeck-agent default >/dev/null 2>&1 || true
    rc-service pulsedeck-agent start >/dev/null 2>&1 || return 1
    printf 'openrc\\n'
    return 0
  fi

  if have crontab; then
    cron_line="@reboot PULSEDECK_AGENT_CONFIG=$CONFIG_FILE $NODE_BIN $AGENT_FILE daemon >/dev/null 2>&1"
    (crontab -l 2>/dev/null | grep -v 'pulsedeck-agent'; printf '%s\\n' "$cron_line") | crontab - >/dev/null 2>&1 || true
    nohup "$NODE_BIN" "$AGENT_FILE" daemon >/dev/null 2>&1 &
    printf 'cron-manual\\n'
    return 0
  fi

  nohup "$NODE_BIN" "$AGENT_FILE" daemon >/dev/null 2>&1 &
  printf 'manual\\n'
}

BASE_DIR="$(choose_base_dir)"
TMP_DIR="$(choose_tmp_dir "$BASE_DIR")"
say "Using Agent install directory: $BASE_DIR"
say "Using Agent temp directory: $TMP_DIR"

mkdir -p "$BASE_DIR/lib" "$BASE_DIR/state" || die "Cannot create Agent directories."
NODE_BIN="$(ensure_node "$BASE_DIR" "$TMP_DIR")"
AGENT_FILE="$BASE_DIR/lib/pulsedeck-agent.mjs"
download "$PULSEDECK_BASE_URL/api/v1/agents/runtime" "$AGENT_FILE" || die "Cannot download Agent runtime."
chmod +x "$AGENT_FILE" || true

if try_mkdir /etc/pulsedeck; then
  CONFIG_DIR=/etc/pulsedeck
else
  CONFIG_DIR="$BASE_DIR/etc"
  mkdir -p "$CONFIG_DIR" || die "Cannot create config directory."
fi
CONFIG_FILE="$CONFIG_DIR/agent.json"

cat > "$CONFIG_FILE" <<EOF
{
  "baseUrl": "$PULSEDECK_BASE_URL",
  "installId": "$PULSEDECK_INSTALL_ID",
  "agentHome": "$BASE_DIR",
  "stateFile": "$BASE_DIR/state/agent-state.json",
  "logFile": "$BASE_DIR/state/agent.log",
  "serviceMode": "installing"
}
EOF

PK_PATH="$(install_shortcut PK "$AGENT_FILE")"
pk_path="$(install_shortcut pk "$AGENT_FILE")"
SERVICE_MODE="$(install_service || printf manual)"

cat > "$CONFIG_FILE" <<EOF
{
  "baseUrl": "$PULSEDECK_BASE_URL",
  "installId": "$PULSEDECK_INSTALL_ID",
  "agentHome": "$BASE_DIR",
  "stateFile": "$BASE_DIR/state/agent-state.json",
  "logFile": "$BASE_DIR/state/agent.log",
  "serviceMode": "$SERVICE_MODE"
}
EOF

"$NODE_BIN" "$AGENT_FILE" once >/dev/null 2>&1 || true

say "PulseDeck Agent installed for $PULSEDECK_BASE_URL with install ID $PULSEDECK_INSTALL_ID."
say "Service mode: $SERVICE_MODE"
say "Shortcut: $PK_PATH and $pk_path"
say "Use: pk status, pk menu, pk logs, pk doctor, pk restart"
`;
}
