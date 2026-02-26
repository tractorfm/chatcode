#!/usr/bin/env bash
# gateway-install.sh - Install chatcode-gateway on Linux (systemd) or macOS (launchd).
#
# Supports two binary sources:
#  1) Local binary (--binary-source)
#  2) Release download (--version + --release-base-url)
set -euo pipefail

SERVICE_NAME="chatcode-gateway"

# Linux paths/ids (dedicated vibe user model).
LINUX_USER="vibe"
LINUX_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LINUX_CONFIG_DIR="/etc/chatcode"
LINUX_BINARY_PATH_DEFAULT="/usr/local/bin/chatcode-gateway"
LINUX_SUDOERS_FILE="/etc/sudoers.d/vibe"

# macOS paths/ids (current user model).
DARWIN_LABEL="dev.chatcode.gateway"

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
BINARY_PATH="${BINARY_PATH:-}"
NO_START=0
DOWNLOAD_TMP_DIR=""

OS_NAME="$(uname -s)"
TARGET_USER=""
TARGET_GROUP=""
TARGET_HOME=""
CONFIG_DIR=""
ENV_FILE=""
SERVICE_FILE=""
SUDOERS_FILE=""
DARWIN_PLIST_PATH=""
DARWIN_LOG_DIR=""

usage() {
  cat <<'USAGE'
Usage:
  # Local binary mode
  ./gateway-install.sh --binary-source /path/to/chatcode-gateway \
    --gateway-id gw_xxx --gateway-auth-token tok_xxx --cp-url wss://cp.example.dev/gw/connect

  # Release download mode
  ./gateway-install.sh --version v0.1.0 \
    --gateway-id gw_xxx --gateway-auth-token tok_xxx --cp-url wss://cp.example.dev/gw/connect

Options:
  --binary-source PATH       Use local binary at PATH.
  --version VERSION          Release version to download (default: latest).
  --release-base-url URL     Release base URL (default: https://releases.chatcode.dev/gateway).
  --binary-path PATH         Destination binary path.
                             Linux default: /usr/local/bin/chatcode-gateway
                             macOS default: ~/.local/bin/chatcode-gateway
  --gateway-id ID            Gateway ID (or env GATEWAY_ID).
  --gateway-auth-token TOK   Gateway auth token (or env GATEWAY_AUTH_TOKEN).
  --cp-url URL               Control-plane WS base URL (or env GATEWAY_CP_URL).
  --bootstrap-token TOKEN    Optional bootstrap token (or env GATEWAY_BOOTSTRAP_TOKEN).
  --log-level LEVEL          debug|info|warn|error (default: info).
  --health-interval DURATION Health interval (default: 30s).
  --max-sessions N           Max sessions (default: 5).
  --no-start                 Install files but do not start/restart service now.
  -h, --help                 Show this help.

Notes:
  - Linux mode expects root and installs a dedicated `vibe` user + systemd unit.
  - macOS mode must run as the target non-root user and installs a launchd agent.
USAGE
}

log() {
  echo "[gateway-install] $*"
}

die() {
  echo "[gateway-install] ERROR: $*" >&2
  exit 1
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

ensure_root_linux() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "linux install must run as root (use sudo)"
  fi
}

ensure_non_root_darwin() {
  if [[ "${EUID}" -eq 0 ]]; then
    die "macOS install must run as the target user (do not use sudo)"
  fi
}

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "${OS_NAME}:${machine}" in
    Linux:x86_64|Linux:amd64)
      echo "amd64"
      ;;
    Linux:aarch64|Linux:arm64)
      echo "arm64"
      ;;
    Darwin:arm64|Darwin:aarch64)
      echo "arm64"
      ;;
    Darwin:x86_64|Darwin:amd64)
      die "darwin/amd64 release artifacts are not published; use --binary-source or arm64 host"
      ;;
    *)
      die "unsupported platform: ${OS_NAME} $(uname -m)"
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

binary_object_name() {
  local arch="$1"
  case "${OS_NAME}" in
    Linux)
      echo "chatcode-gateway-linux-${arch}"
      ;;
    Darwin)
      echo "chatcode-gateway-darwin-${arch}"
      ;;
    *)
      die "unsupported OS for release download: ${OS_NAME}"
      ;;
  esac
}

download_release_binary() {
  local base_url="$1"
  local version="$2"
  local arch="$3"

  local object_name
  object_name="$(binary_object_name "${arch}")"

  local binary_url="${base_url}/${version}/${object_name}"
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

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  s="${s//\'/&apos;}"
  printf '%s' "$s"
}

write_env_file() {
  local install_version="$1"

  install -d -m 700 "${CONFIG_DIR}"

  local tmp_env
  tmp_env="$(mktemp)"
  cat > "${tmp_env}" <<ENV
GATEWAY_ID=${GATEWAY_ID}
GATEWAY_AUTH_TOKEN=${GATEWAY_AUTH_TOKEN}
GATEWAY_CP_URL=${GATEWAY_CP_URL}
GATEWAY_SSH_KEYS_FILE=${TARGET_HOME}/.ssh/authorized_keys
GATEWAY_TEMP_DIR=/tmp/chatcode
GATEWAY_BINARY_PATH=${BINARY_PATH}
GATEWAY_LOG_LEVEL=${GATEWAY_LOG_LEVEL}
GATEWAY_HEALTH_INTERVAL=${GATEWAY_HEALTH_INTERVAL}
GATEWAY_MAX_SESSIONS=${GATEWAY_MAX_SESSIONS}
GATEWAY_VERSION=${install_version}
ENV
  if [[ -n "${GATEWAY_BOOTSTRAP_TOKEN}" ]]; then
    echo "GATEWAY_BOOTSTRAP_TOKEN=${GATEWAY_BOOTSTRAP_TOKEN}" >> "${tmp_env}"
  fi

  if [[ "${OS_NAME}" == "Linux" ]]; then
    install -m 600 "${tmp_env}" "${ENV_FILE}"
  else
    install -m 600 "${tmp_env}" "${ENV_FILE}"
    chown "${TARGET_USER}:${TARGET_GROUP}" "${ENV_FILE}" >/dev/null 2>&1 || true
  fi
  rm -f "${tmp_env}"
}

write_linux_service_unit() {
  cat > "${SERVICE_FILE}" <<UNIT
[Unit]
Description=Chatcode.dev Gateway Daemon
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${TARGET_HOME}
ExecStart=${BINARY_PATH}
EnvironmentFile=${ENV_FILE}
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${TARGET_HOME} /tmp/chatcode
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chatcode-gateway

[Install]
WantedBy=multi-user.target
UNIT
}

write_darwin_plist() {
  install -d -m 755 "$(dirname "${DARWIN_PLIST_PATH}")"
  install -d -m 755 "${DARWIN_LOG_DIR}"

  {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DARWIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "${BINARY_PATH}")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${TARGET_HOME}")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${DARWIN_LOG_DIR}/chatcode-gateway.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${DARWIN_LOG_DIR}/chatcode-gateway.err.log")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GATEWAY_ID</key>
    <string>$(xml_escape "${GATEWAY_ID}")</string>
    <key>GATEWAY_AUTH_TOKEN</key>
    <string>$(xml_escape "${GATEWAY_AUTH_TOKEN}")</string>
    <key>GATEWAY_CP_URL</key>
    <string>$(xml_escape "${GATEWAY_CP_URL}")</string>
PLIST

    if [[ -n "${GATEWAY_BOOTSTRAP_TOKEN}" ]]; then
      cat <<PLIST
    <key>GATEWAY_BOOTSTRAP_TOKEN</key>
    <string>$(xml_escape "${GATEWAY_BOOTSTRAP_TOKEN}")</string>
PLIST
    fi

    cat <<PLIST
    <key>GATEWAY_SSH_KEYS_FILE</key>
    <string>$(xml_escape "${TARGET_HOME}/.ssh/authorized_keys")</string>
    <key>GATEWAY_TEMP_DIR</key>
    <string>/tmp/chatcode</string>
    <key>GATEWAY_BINARY_PATH</key>
    <string>$(xml_escape "${BINARY_PATH}")</string>
    <key>GATEWAY_LOG_LEVEL</key>
    <string>$(xml_escape "${GATEWAY_LOG_LEVEL}")</string>
    <key>GATEWAY_HEALTH_INTERVAL</key>
    <string>$(xml_escape "${GATEWAY_HEALTH_INTERVAL}")</string>
    <key>GATEWAY_MAX_SESSIONS</key>
    <string>$(xml_escape "${GATEWAY_MAX_SESSIONS}")</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST
  } > "${DARWIN_PLIST_PATH}"

  chmod 644 "${DARWIN_PLIST_PATH}"
}

bootout_darwin_agent() {
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/${uid}" "${DARWIN_PLIST_PATH}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${uid}/${DARWIN_LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}" "${DARWIN_PLIST_PATH}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}/${DARWIN_LABEL}" >/dev/null 2>&1 || true
}

bootstrap_darwin_agent() {
  local uid
  uid="$(id -u)"

  if launchctl bootstrap "gui/${uid}" "${DARWIN_PLIST_PATH}" >/dev/null 2>&1; then
    echo "gui/${uid}"
    return 0
  fi
  if launchctl bootstrap "user/${uid}" "${DARWIN_PLIST_PATH}" >/dev/null 2>&1; then
    echo "user/${uid}"
    return 0
  fi
  return 1
}

prepare_linux_user() {
  if ! id "${TARGET_USER}" >/dev/null 2>&1; then
    log "creating ${TARGET_USER} user"
    useradd -m -s /bin/bash "${TARGET_USER}"
  fi

  TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
  [[ -n "${TARGET_HOME}" ]] || die "failed to resolve ${TARGET_USER} home directory"

  install -d -m 700 -o "${TARGET_USER}" -g "${TARGET_USER}" "${TARGET_HOME}/.ssh"
  touch "${TARGET_HOME}/.ssh/authorized_keys"
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.ssh/authorized_keys"
  chmod 600 "${TARGET_HOME}/.ssh/authorized_keys"
  install -d -m 755 -o "${TARGET_USER}" -g "${TARGET_USER}" "${TARGET_HOME}/workspace"

  echo "${TARGET_USER} ALL=(ALL) NOPASSWD:ALL" > "${SUDOERS_FILE}"
  chmod 0440 "${SUDOERS_FILE}"
}

prepare_darwin_user() {
  install -d -m 700 "${TARGET_HOME}/.ssh"
  touch "${TARGET_HOME}/.ssh/authorized_keys"
  chmod 600 "${TARGET_HOME}/.ssh/authorized_keys"
  install -d -m 755 "${TARGET_HOME}/workspace"
}

install_binary() {
  local src="$1"
  install -d -m 755 "$(dirname "${BINARY_PATH}")"
  install -m 0755 "${src}" "${BINARY_PATH}"

  if [[ "${OS_NAME}" == "Linux" ]]; then
    chown root:root "${BINARY_PATH}" >/dev/null 2>&1 || true
  else
    chown "${TARGET_USER}:${TARGET_GROUP}" "${BINARY_PATH}" >/dev/null 2>&1 || true
  fi
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

case "${OS_NAME}" in
  Linux)
    ensure_root_linux
    TARGET_USER="${LINUX_USER}"
    TARGET_GROUP="${LINUX_USER}"
    CONFIG_DIR="${LINUX_CONFIG_DIR}"
    ENV_FILE="${CONFIG_DIR}/gateway.env"
    SERVICE_FILE="${LINUX_SERVICE_FILE}"
    SUDOERS_FILE="${LINUX_SUDOERS_FILE}"
    if [[ -z "${BINARY_PATH}" ]]; then
      BINARY_PATH="${LINUX_BINARY_PATH_DEFAULT}"
    fi
    ;;
  Darwin)
    ensure_non_root_darwin
    TARGET_USER="$(id -un)"
    TARGET_GROUP="$(id -gn)"
    TARGET_HOME="${HOME}"
    CONFIG_DIR="${TARGET_HOME}/.config/chatcode"
    ENV_FILE="${CONFIG_DIR}/gateway.env"
    DARWIN_PLIST_PATH="${TARGET_HOME}/Library/LaunchAgents/${DARWIN_LABEL}.plist"
    DARWIN_LOG_DIR="${TARGET_HOME}/Library/Logs"
    if [[ -z "${BINARY_PATH}" ]]; then
      BINARY_PATH="${TARGET_HOME}/.local/bin/chatcode-gateway"
    fi
    ;;
  *)
    die "unsupported OS: ${OS_NAME}"
    ;;
esac

cleanup() {
  if [[ -n "${DOWNLOAD_TMP_DIR}" && -d "${DOWNLOAD_TMP_DIR}" ]]; then
    rm -rf "${DOWNLOAD_TMP_DIR}"
  fi
}
trap cleanup EXIT

[[ -n "${GATEWAY_ID}" ]] || die "gateway id is required (--gateway-id or GATEWAY_ID)"
[[ -n "${GATEWAY_AUTH_TOKEN}" ]] || die "gateway auth token is required (--gateway-auth-token or GATEWAY_AUTH_TOKEN)"
[[ -n "${GATEWAY_CP_URL}" ]] || die "cp url is required (--cp-url or GATEWAY_CP_URL)"

require_single_line "GATEWAY_ID" "${GATEWAY_ID}"
require_single_line "GATEWAY_AUTH_TOKEN" "${GATEWAY_AUTH_TOKEN}"
require_single_line "GATEWAY_CP_URL" "${GATEWAY_CP_URL}"
require_single_line "GATEWAY_BOOTSTRAP_TOKEN" "${GATEWAY_BOOTSTRAP_TOKEN}"

case "${OS_NAME}" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
    command -v useradd >/dev/null 2>&1 || die "useradd is required"
    command -v getent >/dev/null 2>&1 || die "getent is required"
    command -v tmux >/dev/null 2>&1 || die "tmux is required"
    command -v curl >/dev/null 2>&1 || die "curl is required"
    ;;
  Darwin)
    command -v launchctl >/dev/null 2>&1 || die "launchctl is required"
    command -v tmux >/dev/null 2>&1 || die "tmux is required"
    command -v curl >/dev/null 2>&1 || die "curl is required"
    ;;
esac

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

if [[ "${OS_NAME}" == "Linux" ]]; then
  prepare_linux_user
else
  prepare_darwin_user
fi

log "installing gateway binary to ${BINARY_PATH}"
install_binary "${BINARY_SOURCE}"
write_env_file "${INSTALL_VERSION}"

if [[ "${OS_NAME}" == "Linux" ]]; then
  log "installing systemd service ${SERVICE_NAME}"
  write_linux_service_unit
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
  echo "  os:     Linux"
  echo "  user:   ${TARGET_USER}"
  echo "  binary: ${BINARY_PATH}"
  echo "  env:    ${ENV_FILE}"
  echo "  unit:   ${SERVICE_FILE}"
else
  write_darwin_plist
  bootout_darwin_agent

  if [[ "${NO_START}" -eq 0 ]]; then
    domain="$(bootstrap_darwin_agent || true)"
    [[ -n "${domain}" ]] || die "launchctl bootstrap failed for ${DARWIN_PLIST_PATH}"
    launchctl kickstart -k "${domain}/${DARWIN_LABEL}" >/dev/null 2>&1 || true
    log "launchd agent started (${domain}/${DARWIN_LABEL})"
  else
    log "--no-start requested; launchd plist was written but not bootstrapped"
  fi

  log "done"
  echo "  os:     macOS"
  echo "  user:   ${TARGET_USER}"
  echo "  binary: ${BINARY_PATH}"
  echo "  env:    ${ENV_FILE}"
  echo "  plist:  ${DARWIN_PLIST_PATH}"
fi
