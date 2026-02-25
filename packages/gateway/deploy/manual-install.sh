#!/usr/bin/env bash
# manual-install.sh - Install chatcode-gateway on an existing Linux host.
#
# Supports two binary sources:
#  1) Local binary (--binary-source)
#  2) Release download (--version + --release-base-url)
set -euo pipefail

SERVICE_NAME="chatcode-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_DIR="/etc/chatcode"
ENV_FILE="${CONFIG_DIR}/gateway.env"
BINARY_PATH="/usr/local/bin/chatcode-gateway"
VIBE_USER="vibe"
SUDOERS_FILE="/etc/sudoers.d/vibe"

GATEWAY_ID="${GATEWAY_ID:-}"
GATEWAY_AUTH_TOKEN="${GATEWAY_AUTH_TOKEN:-}"
GATEWAY_CP_URL="${GATEWAY_CP_URL:-}"
GATEWAY_BOOTSTRAP_TOKEN="${GATEWAY_BOOTSTRAP_TOKEN:-}"
GATEWAY_LOG_LEVEL="${GATEWAY_LOG_LEVEL:-info}"
GATEWAY_HEALTH_INTERVAL="${GATEWAY_HEALTH_INTERVAL:-30s}"
GATEWAY_MAX_SESSIONS="${GATEWAY_MAX_SESSIONS:-5}"

BINARY_SOURCE="${BINARY_SOURCE:-}"
GATEWAY_VERSION="${GATEWAY_VERSION:-latest}"
GATEWAY_RELEASE_BASE_URL="${GATEWAY_RELEASE_BASE_URL:-https://releases.chatcode.dev/gateway}"
NO_START=0
DOWNLOAD_TMP_DIR=""

usage() {
  cat <<'USAGE'
Usage:
  # Local binary mode
  sudo ./manual-install.sh --binary-source /path/to/chatcode-gateway \
    --gateway-id gw_xxx --gateway-auth-token tok_xxx --cp-url wss://cp.example.dev/gw/connect

  # Release download mode
  sudo ./manual-install.sh --version v0.1.0 \
    --gateway-id gw_xxx --gateway-auth-token tok_xxx --cp-url wss://cp.example.dev/gw/connect

Options:
  --binary-source PATH       Use local binary at PATH.
  --version VERSION          Release version to download (default: latest).
  --release-base-url URL     Release base URL (default: https://releases.chatcode.dev/gateway).
  --binary-path PATH         Destination binary path (default: /usr/local/bin/chatcode-gateway).
  --gateway-id ID            Gateway ID (or env GATEWAY_ID).
  --gateway-auth-token TOK   Gateway auth token (or env GATEWAY_AUTH_TOKEN).
  --cp-url URL               Control-plane WS base URL (or env GATEWAY_CP_URL).
  --bootstrap-token TOKEN    Optional bootstrap token (or env GATEWAY_BOOTSTRAP_TOKEN).
  --log-level LEVEL          debug|info|warn|error (default: info).
  --health-interval DURATION Health interval (default: 30s).
  --max-sessions N           Max sessions (default: 5).
  --no-start                 Install files and enable service but do not start/restart it.
  -h, --help                 Show this help.
USAGE
}

log() {
  echo "[manual-install] $*"
}

die() {
  echo "[manual-install] ERROR: $*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "run as root (use sudo)"
  fi
}

require_single_line() {
  local name="$1"
  local value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*)
      die "${name} must be a single line"
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo "amd64"
      ;;
    aarch64|arm64)
      echo "arm64"
      ;;
    *)
      die "unsupported architecture: $(uname -m)"
      ;;
  esac
}

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  die "sha256sum or shasum is required"
}

resolve_version() {
  local base_url="$1"
  local version="$2"
  if [[ "$version" != "latest" ]]; then
    echo "$version"
    return
  fi

  local latest
  latest="$(curl -fsSL "${base_url}/latest.txt" | tr -d '[:space:]')"
  [[ -n "$latest" ]] || die "failed to resolve latest version from ${base_url}/latest.txt"
  echo "$latest"
}

download_release_binary() {
  local base_url="$1"
  local version="$2"
  local arch="$3"

  local binary_url="${base_url}/${version}/chatcode-gateway-linux-${arch}"
  local sha_url="${binary_url}.sha256"

  DOWNLOAD_TMP_DIR="$(mktemp -d)"

  log "downloading ${binary_url}"
  curl -fsSL -o "${DOWNLOAD_TMP_DIR}/chatcode-gateway" "$binary_url"
  curl -fsSL -o "${DOWNLOAD_TMP_DIR}/chatcode-gateway.sha256" "$sha_url"

  local expected_sha
  expected_sha="$(awk '{print $1}' "${DOWNLOAD_TMP_DIR}/chatcode-gateway.sha256" | tr -d '[:space:]')"
  [[ -n "$expected_sha" ]] || die "empty checksum in ${sha_url}"

  local actual_sha
  actual_sha="$(hash_file "${DOWNLOAD_TMP_DIR}/chatcode-gateway")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    die "checksum mismatch for downloaded binary"
  fi

  echo "${DOWNLOAD_TMP_DIR}/chatcode-gateway"
}

write_service_unit() {
  cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=Chatcode.dev Gateway Daemon
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=vibe
Group=vibe
WorkingDirectory=/home/vibe
ExecStart=/usr/local/bin/chatcode-gateway
EnvironmentFile=/etc/chatcode/gateway.env
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/vibe /tmp/chatcode
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chatcode-gateway

[Install]
WantedBy=multi-user.target
UNIT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary-source)
      BINARY_SOURCE="${2:-}"
      shift 2
      ;;
    --version)
      GATEWAY_VERSION="${2:-}"
      shift 2
      ;;
    --release-base-url)
      GATEWAY_RELEASE_BASE_URL="${2:-}"
      shift 2
      ;;
    --binary-path)
      BINARY_PATH="${2:-}"
      shift 2
      ;;
    --gateway-id)
      GATEWAY_ID="${2:-}"
      shift 2
      ;;
    --gateway-auth-token)
      GATEWAY_AUTH_TOKEN="${2:-}"
      shift 2
      ;;
    --cp-url)
      GATEWAY_CP_URL="${2:-}"
      shift 2
      ;;
    --bootstrap-token)
      GATEWAY_BOOTSTRAP_TOKEN="${2:-}"
      shift 2
      ;;
    --log-level)
      GATEWAY_LOG_LEVEL="${2:-}"
      shift 2
      ;;
    --health-interval)
      GATEWAY_HEALTH_INTERVAL="${2:-}"
      shift 2
      ;;
    --max-sessions)
      GATEWAY_MAX_SESSIONS="${2:-}"
      shift 2
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

require_root

cleanup() {
  if [[ -n "${DOWNLOAD_TMP_DIR}" && -d "${DOWNLOAD_TMP_DIR}" ]]; then
    rm -rf "${DOWNLOAD_TMP_DIR}"
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" ]]; then
  die "manual installer currently supports Linux/systemd only"
fi

command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
command -v useradd >/dev/null 2>&1 || die "useradd is required"
command -v tmux >/dev/null 2>&1 || die "tmux is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

[[ -n "${GATEWAY_ID}" ]] || die "gateway id is required (--gateway-id or GATEWAY_ID)"
[[ -n "${GATEWAY_AUTH_TOKEN}" ]] || die "gateway auth token is required (--gateway-auth-token or GATEWAY_AUTH_TOKEN)"
[[ -n "${GATEWAY_CP_URL}" ]] || die "cp url is required (--cp-url or GATEWAY_CP_URL)"

require_single_line "GATEWAY_ID" "${GATEWAY_ID}"
require_single_line "GATEWAY_AUTH_TOKEN" "${GATEWAY_AUTH_TOKEN}"
require_single_line "GATEWAY_CP_URL" "${GATEWAY_CP_URL}"
require_single_line "GATEWAY_BOOTSTRAP_TOKEN" "${GATEWAY_BOOTSTRAP_TOKEN}"

INSTALL_VERSION="manual"
if [[ -z "${BINARY_SOURCE}" ]]; then
  RESOLVED_VERSION="$(resolve_version "${GATEWAY_RELEASE_BASE_URL}" "${GATEWAY_VERSION}")"
  ARCH="$(detect_arch)"
  BINARY_SOURCE="$(download_release_binary "${GATEWAY_RELEASE_BASE_URL}" "${RESOLVED_VERSION}" "${ARCH}")"
  INSTALL_VERSION="${RESOLVED_VERSION}"
else
  [[ -f "${BINARY_SOURCE}" ]] || die "binary source not found: ${BINARY_SOURCE}"
  if [[ -n "${GATEWAY_VERSION}" && "${GATEWAY_VERSION}" != "latest" ]]; then
    INSTALL_VERSION="${GATEWAY_VERSION}"
  fi
fi

if ! id "${VIBE_USER}" >/dev/null 2>&1; then
  log "creating ${VIBE_USER} user"
  useradd -m -s /bin/bash "${VIBE_USER}"
fi

VIBE_HOME="$(getent passwd "${VIBE_USER}" | cut -d: -f6)"
[[ -n "${VIBE_HOME}" ]] || die "failed to resolve ${VIBE_USER} home directory"

install -d -m 700 -o "${VIBE_USER}" -g "${VIBE_USER}" "${VIBE_HOME}/.ssh"
touch "${VIBE_HOME}/.ssh/authorized_keys"
chown "${VIBE_USER}:${VIBE_USER}" "${VIBE_HOME}/.ssh/authorized_keys"
chmod 600 "${VIBE_HOME}/.ssh/authorized_keys"
install -d -m 755 -o "${VIBE_USER}" -g "${VIBE_USER}" "${VIBE_HOME}/workspace"

echo "${VIBE_USER} ALL=(ALL) NOPASSWD:ALL" > "${SUDOERS_FILE}"
chmod 0440 "${SUDOERS_FILE}"

log "installing gateway binary to ${BINARY_PATH}"
install -m 0755 "${BINARY_SOURCE}" "${BINARY_PATH}"

install -d -m 750 "${CONFIG_DIR}"
tmp_env="$(mktemp)"
cat > "${tmp_env}" <<ENV
GATEWAY_ID=${GATEWAY_ID}
GATEWAY_AUTH_TOKEN=${GATEWAY_AUTH_TOKEN}
GATEWAY_CP_URL=${GATEWAY_CP_URL}
GATEWAY_SSH_KEYS_FILE=${VIBE_HOME}/.ssh/authorized_keys
GATEWAY_TEMP_DIR=/tmp/chatcode
GATEWAY_BINARY_PATH=${BINARY_PATH}
GATEWAY_LOG_LEVEL=${GATEWAY_LOG_LEVEL}
GATEWAY_HEALTH_INTERVAL=${GATEWAY_HEALTH_INTERVAL}
GATEWAY_MAX_SESSIONS=${GATEWAY_MAX_SESSIONS}
GATEWAY_VERSION=${INSTALL_VERSION}
ENV
if [[ -n "${GATEWAY_BOOTSTRAP_TOKEN}" ]]; then
  echo "GATEWAY_BOOTSTRAP_TOKEN=${GATEWAY_BOOTSTRAP_TOKEN}" >> "${tmp_env}"
fi
install -m 600 "${tmp_env}" "${ENV_FILE}"
rm -f "${tmp_env}"

log "installing systemd service ${SERVICE_NAME}"
write_service_unit
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null

if [[ "${NO_START}" -eq 0 ]]; then
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    systemctl restart "${SERVICE_NAME}"
  else
    systemctl start "${SERVICE_NAME}"
  fi
  log "service started"
  systemctl --no-pager --full status "${SERVICE_NAME}" || true
else
  log "--no-start requested; service was enabled but not started"
fi

log "done"
echo "  binary: ${BINARY_PATH}"
echo "  env:    ${ENV_FILE}"
echo "  unit:   ${SERVICE_FILE}"
