export function renderAgentInstallScript({ baseUrl, installId }) {
  const safeBaseUrl = String(baseUrl).replace(/'/g, "'\"'\"'");
  const safeInstallId = String(installId).replace(/'/g, "'\"'\"'");

  return `#!/bin/sh
set -u

PULSEDECK_BASE_URL='${safeBaseUrl}'
PULSEDECK_INSTALL_ID='${safeInstallId}'
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
    if try_mkdir "$dir" && space_ok "$dir" 8192; then
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
    if try_mkdir "$dir" && space_ok "$dir" 4096; then
      printf '%s\\n' "$dir"
      return 0
    fi
  done
  die "No writable temp directory with enough space. Set TMPDIR or PULSEDECK_AGENT_HOME."
}

download() {
  url="$1"
  out="$2"
  rm -f "$out" >/dev/null 2>&1 || true
  if have curl; then
    curl -fsSL "$url" -o "$out"
  elif have wget; then
    wget -qO "$out" "$url"
  else
    die "curl or wget is required."
  fi
}

download_text() {
  url="$1"
  if have curl; then
    curl -fsSL "$url"
  elif have wget; then
    wget -qO- "$url"
  else
    die "curl or wget is required."
  fi
}

json_string() {
  key="$1"
  sed -n "s/.*\\"$key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1
}

json_number() {
  key="$1"
  sed -n "s/.*\\"$key\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | head -n 1
}

file_sha256() {
  file="$1"
  if have sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 1
  fi
}

verify_sha256() {
  file="$1"
  expected="$2"
  [ -n "$expected" ] || return 0
  actual="$(file_sha256 "$file" 2>/dev/null || true)"
  if [ -z "$actual" ]; then
    say "未找到 SHA-256 工具，跳过 Agent 校验。"
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    say "Agent 校验失败：期望 $expected，实际 $actual。"
    return 1
  fi
  say "Agent 校验通过：$actual"
  return 0
}

install_agent_binary() {
  url="$1"
  target="$2"
  expected_sha="\${3:-}"
  next="$target.$$.download"
  backup="$target.bak"
  rm -f "$next" >/dev/null 2>&1 || true
  download "$url" "$next" || {
    rm -f "$next" >/dev/null 2>&1 || true
    return 1
  }
  [ -s "$next" ] || {
    rm -f "$next" >/dev/null 2>&1 || true
    say "Downloaded Agent binary is empty."
    return 1
  }
  verify_sha256 "$next" "$expected_sha" || {
    rm -f "$next" >/dev/null 2>&1 || true
    return 1
  }
  chmod +x "$next" || {
    rm -f "$next" >/dev/null 2>&1 || true
    say "Cannot make downloaded Agent binary executable."
    return 1
  }
  if [ -f "$target" ]; then
    cp "$target" "$backup" >/dev/null 2>&1 || true
  fi
  mv -f "$next" "$target" || {
    rm -f "$next" >/dev/null 2>&1 || true
    say "Cannot replace Agent binary at $target."
    return 1
  }
  chmod +x "$target" || return 1
  return 0
}

agent_target() {
  machine="$(uname -m 2>/dev/null || printf unknown)"
  case "$machine" in
    x86_64|amd64) printf 'linux-x64' ;;
    aarch64|arm64) printf 'linux-arm64' ;;
    armv7l|armv7*) printf 'linux-armv7l' ;;
    *) printf 'unsupported' ;;
  esac
}

install_shortcut() {
  name="$1"
  if try_mkdir /usr/local/bin; then
    shortcut="/usr/local/bin/$name"
  else
    mkdir -p "$BASE_DIR/bin" || die "Cannot create shortcut directory."
    shortcut="$BASE_DIR/bin/$name"
  fi
  cat > "$shortcut" <<EOF
#!/bin/sh
export PULSEDECK_AGENT_CONFIG="$CONFIG_FILE"
exec "$AGENT_BIN" "\\$@"
EOF
  chmod +x "$shortcut" || true
  printf '%s\\n' "$shortcut"
}

install_service() {
  if [ "$(id -u 2>/dev/null || printf 1)" = "0" ] && have systemctl && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/pulsedeck-agent.service <<EOF
[Unit]
Description=PulseDeck Rust Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PULSEDECK_AGENT_CONFIG=$CONFIG_FILE
ExecStart=$AGENT_BIN daemon
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable pulsedeck-agent.service >/dev/null 2>&1 || true
    systemctl restart pulsedeck-agent.service >/dev/null 2>&1 || systemctl start pulsedeck-agent.service >/dev/null 2>&1 || return 1
    printf 'systemd\\n'
    return 0
  fi

  if [ "$(id -u 2>/dev/null || printf 1)" = "0" ] && have rc-service && [ -d /etc/init.d ]; then
    cat > /etc/init.d/pulsedeck-agent <<EOF
#!/sbin/openrc-run
name="PulseDeck Rust Agent"
command="$AGENT_BIN"
command_args="daemon"
command_background=true
pidfile="/run/pulsedeck-agent.pid"
export PULSEDECK_AGENT_CONFIG="$CONFIG_FILE"
EOF
    chmod +x /etc/init.d/pulsedeck-agent || true
    rc-update add pulsedeck-agent default >/dev/null 2>&1 || true
    rc-service pulsedeck-agent restart >/dev/null 2>&1 || rc-service pulsedeck-agent start >/dev/null 2>&1 || return 1
    printf 'openrc\\n'
    return 0
  fi

  if have crontab; then
    cron_line="@reboot PULSEDECK_AGENT_CONFIG=$CONFIG_FILE $AGENT_BIN daemon >/dev/null 2>&1"
    (crontab -l 2>/dev/null | grep -v 'pulsedeck-agent'; printf '%s\\n' "$cron_line") | crontab - >/dev/null 2>&1 || true
    nohup "$AGENT_BIN" daemon >/dev/null 2>&1 &
    printf 'cron-manual\\n'
    return 0
  fi

  nohup "$AGENT_BIN" daemon >/dev/null 2>&1 &
  printf 'manual\\n'
}

BASE_DIR="$(choose_base_dir)"
TMP_DIR="$(choose_tmp_dir "$BASE_DIR")"
PULSEDECK_AGENT_TARGET="$(agent_target)"
[ "$PULSEDECK_AGENT_TARGET" != "unsupported" ] || die "不支持的 CPU 架构：$(uname -m 2>/dev/null || printf unknown)。PulseDeck Rust Agent 发布包支持 linux-x64、linux-arm64 和 linux-armv7l。"

say "Agent 安装目录：$BASE_DIR"
say "Agent 临时目录：$TMP_DIR"
say "Agent 目标包：$PULSEDECK_AGENT_TARGET"

MANIFEST_JSON="$(download_text "$PULSEDECK_BASE_URL/api/v1/agents/runtime/manifest/$PULSEDECK_AGENT_TARGET" 2>/dev/null || true)"
RUNTIME_VERSION="$(printf '%s\\n' "$MANIFEST_JSON" | json_string version)"
RUNTIME_SIZE_BYTES="$(printf '%s\\n' "$MANIFEST_JSON" | json_number sizeBytes)"
RUNTIME_SHA256="$(printf '%s\\n' "$MANIFEST_JSON" | json_string sha256)"
if [ -n "$RUNTIME_VERSION" ] || [ -n "$RUNTIME_SIZE_BYTES" ]; then
  display_version="$RUNTIME_VERSION"
  display_size="$RUNTIME_SIZE_BYTES"
  [ -n "$display_version" ] || display_version=unknown
  [ -n "$display_size" ] || display_size=unknown
  say "Agent 运行时信息：版本 $display_version，大小 $display_size bytes"
fi

mkdir -p "$BASE_DIR/bin" "$BASE_DIR/state" || die "无法创建 Agent 目录。"
AGENT_BIN="$BASE_DIR/bin/pulsedeck-agent"
install_agent_binary "$PULSEDECK_BASE_URL/api/v1/agents/runtime/$PULSEDECK_AGENT_TARGET" "$AGENT_BIN" "$RUNTIME_SHA256" || die "无法下载并安装 $PULSEDECK_AGENT_TARGET 的 PulseDeck Rust Agent。"

if try_mkdir /etc/pulsedeck; then
  CONFIG_DIR=/etc/pulsedeck
else
  CONFIG_DIR="$BASE_DIR/etc"
  mkdir -p "$CONFIG_DIR" || die "无法创建配置目录。"
fi
CONFIG_FILE="$CONFIG_DIR/agent.json"

cat > "$CONFIG_FILE" <<EOF
{
  "baseUrl": "$PULSEDECK_BASE_URL",
  "installId": "$PULSEDECK_INSTALL_ID",
  "agentHome": "$BASE_DIR",
  "agentTarget": "$PULSEDECK_AGENT_TARGET",
  "stateFile": "$BASE_DIR/state/agent-state.json",
  "logFile": "$BASE_DIR/state/agent.log",
  "runtime": "rust",
  "serviceMode": "installing"
}
EOF

PK_PATH="$(install_shortcut PK)"
pk_path="$(install_shortcut pk)"
RK_PATH="$(install_shortcut RK)"
rk_path="$(install_shortcut rk)"
SERVICE_MODE="$(install_service || printf manual)"

cat > "$CONFIG_FILE" <<EOF
{
  "baseUrl": "$PULSEDECK_BASE_URL",
  "installId": "$PULSEDECK_INSTALL_ID",
  "agentHome": "$BASE_DIR",
  "agentTarget": "$PULSEDECK_AGENT_TARGET",
  "stateFile": "$BASE_DIR/state/agent-state.json",
  "logFile": "$BASE_DIR/state/agent.log",
  "runtime": "rust",
  "serviceMode": "$SERVICE_MODE"
}
EOF

"$AGENT_BIN" once >/dev/null 2>&1 || true

say "PulseDeck Rust Agent 已安装：面板 $PULSEDECK_BASE_URL，安装 ID $PULSEDECK_INSTALL_ID。"
say "服务模式：$SERVICE_MODE"
say "快捷命令：$PK_PATH, $pk_path, $RK_PATH, $rk_path"
say "常用命令：pk, pk status, pk info, pk service-status, pk update-check, pk update, pk uninstall --yes"
`;
}
