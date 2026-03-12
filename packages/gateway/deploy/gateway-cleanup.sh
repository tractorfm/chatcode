#!/usr/bin/env bash
# gateway-cleanup.sh - Remove chatcode-gateway service/runtime from a host.
#
# Copyright (c) 2026 Chatcode contributors.
# Project: https://github.com/tractorfm/chatcode
# Docs: https://chatcode.dev/docs/gateway
#
# Linux (root, dedicated vibe user):
# - chatcode-gateway systemd unit + process
# - chatcode-maintenance service/timer + helper scripts
# - /etc/chatcode config
# - /usr/local/bin/chatcode-gateway binary
# - vibe sudoers entry
# - vibe user and home directory (unless --keep-user)
# - /tmp/chatcode and /opt/chatcode leftovers
#
# macOS (current user):
# - dev.chatcode.gateway launchd agent
# - dev.chatcode.maintenance launchd agent + helper scripts
# - ~/.config/chatcode config
# - ~/.local/bin/chatcode-gateway binary
# - /tmp/chatcode leftovers
# - optional ~/workspace removal via --remove-workspace
set -euo pipefail

SERVICE_NAME="chatcode-gateway"
LINUX_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LINUX_CONFIG_DIR="/etc/chatcode"
LINUX_BINARY_PATH="/usr/local/bin/chatcode-gateway"
LINUX_USER="vibe"
LINUX_SUDOERS_FILE="/etc/sudoers.d/vibe"
LINUX_SUDO_LOG_DIR="/var/log/chatcode"
LINUX_SUDO_LOG_FILE="${LINUX_SUDO_LOG_DIR}/sudo-vibe.log"
LINUX_LOGROTATE_FILE="/etc/logrotate.d/chatcode-sudo-vibe"
LINUX_MAINTENANCE_SERVICE="chatcode-maintenance"
LINUX_MAINTENANCE_SERVICE_FILE="/etc/systemd/system/chatcode-maintenance.service"
LINUX_MAINTENANCE_TIMER_FILE="/etc/systemd/system/chatcode-maintenance.timer"
LINUX_MAINTENANCE_SCRIPT="/usr/local/sbin/chatcode-maintenance"
LINUX_MAINTENANCE_LOCK="/var/lock/chatcode-maintenance.lock"
LINUX_AGENT_UPDATE_HELPER="/usr/local/sbin/chatcode-update-agent-clis"
LINUX_AGENT_INSTALLER_SCRIPTS=(
  "/usr/local/sbin/install-git.sh"
  "/usr/local/sbin/install-claude-code.sh"
  "/usr/local/sbin/install-codex.sh"
  "/usr/local/sbin/install-gemini.sh"
  "/usr/local/sbin/install-opencode.sh"
)

DARWIN_LABEL="dev.chatcode.gateway"
DARWIN_MAINTENANCE_LABEL="dev.chatcode.maintenance"
LINUX_ENV_FILE="${LINUX_CONFIG_DIR}/gateway.env"

CONFIRM=0
KEEP_USER=0
KEEP_WORKSPACE=0
REMOVE_WORKSPACE=0

usage() {
  cat <<'EOF_USAGE'
Usage:
  # Linux
  sudo ./gateway-cleanup.sh --yes

  # macOS
  ./gateway-cleanup.sh --yes [--remove-workspace]

Options:
  --yes               Required. Confirm destructive cleanup.
  --keep-user         Linux only. Keep vibe user/home.
  --keep-workspace    Linux only. Keep /home/vibe/workspace (requires --keep-user).
  --remove-workspace  macOS only. Also remove ~/workspace.
  -h, --help          Show this help.
EOF_USAGE
}

log() {
  echo "[gateway-cleanup] $*"
}

die() {
  echo "[gateway-cleanup] ERROR: $*" >&2
  exit 1
}

safe_rm_file() {
  local path="$1"
  if [[ -f "${path}" || -L "${path}" ]]; then
    rm -f -- "${path}"
    log "removed file ${path}"
  fi
}

safe_rm_dir() {
  local path="$1"
  [[ -n "${path}" ]] || return 0
  case "${path}" in
    /|/home|/Users|/etc|/usr|/var|/tmp)
      die "refusing to remove unsafe path: ${path}"
      ;;
  esac
  if [[ -L "${path}" ]]; then
    die "refusing to remove symlink path: ${path}"
  fi
  if [[ -d "${path}" ]]; then
    rm -rf --one-file-system -- "${path}"
    log "removed directory ${path}"
  fi
}

bootout_darwin_agent() {
  local uid="$1"
  local label="$2"
  local plist_path="$3"

  launchctl bootout "gui/${uid}" "${plist_path}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}" "${plist_path}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}/${label}" >/dev/null 2>&1 || true
}

load_gateway_env() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  # Trusted installer-written env file.
  # shellcheck disable=SC1090
  source "${env_file}"
}

cp_unlink_url() {
  local ws_url="$1"
  local gateway_id="$2"
  local base="${ws_url}"
  case "${base}" in
    wss://*) base="https://${base#wss://}" ;;
    ws://*) base="http://${base#ws://}" ;;
    https://*|http://*) ;;
    *) return 1 ;;
  esac
  base="${base%/gw/connect}"
  printf '%s/gw/unlink/%s' "${base}" "${gateway_id}"
}

try_unlink_control_plane() {
  local cp_url="${GATEWAY_CP_URL:-}"
  local gateway_id="${GATEWAY_ID:-}"
  local auth_token="${GATEWAY_AUTH_TOKEN:-}"
  [[ -n "${cp_url}" && -n "${gateway_id}" && -n "${auth_token}" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  local unlink_url=""
  unlink_url="$(cp_unlink_url "${cp_url}" "${gateway_id}")" || return 0

  if curl -fsS -X POST \
    -H "Authorization: Bearer ${auth_token}" \
    -H "X-Gateway-Id: ${gateway_id}" \
    --max-time 10 \
    "${unlink_url}" >/dev/null 2>&1; then
    log "unlinked server from control plane"
  else
    log "warning: failed to unlink server from control plane; you may need to remove it manually"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      CONFIRM=1
      shift
      ;;
    --keep-user)
      KEEP_USER=1
      shift
      ;;
    --keep-workspace)
      KEEP_WORKSPACE=1
      shift
      ;;
    --remove-workspace)
      REMOVE_WORKSPACE=1
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

if [[ "${CONFIRM}" -ne 1 ]]; then
  usage
  die "--yes is required"
fi

OS_NAME="$(uname -s)"

case "${OS_NAME}" in
  Linux)
    if [[ "${EUID}" -ne 0 ]]; then
      die "linux cleanup must run as root (use sudo)"
    fi
    if [[ "${REMOVE_WORKSPACE}" -eq 1 ]]; then
      die "--remove-workspace is macOS-only"
    fi
    if [[ "${KEEP_WORKSPACE}" -eq 1 && "${KEEP_USER}" -eq 0 ]]; then
      die "--keep-workspace requires --keep-user"
    fi

    load_gateway_env "${LINUX_ENV_FILE}"

    VIBE_HOME="/home/${LINUX_USER}"
    if id "${LINUX_USER}" >/dev/null 2>&1; then
      maybe_home="$(getent passwd "${LINUX_USER}" | cut -d: -f6)"
      if [[ -n "${maybe_home}" ]]; then
        VIBE_HOME="${maybe_home}"
      fi
    fi
    WORKSPACE_DIR="${VIBE_HOME}/workspace"

    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
      systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
      systemctl stop "${LINUX_MAINTENANCE_SERVICE}.timer" >/dev/null 2>&1 || true
      systemctl disable "${LINUX_MAINTENANCE_SERVICE}.timer" >/dev/null 2>&1 || true
    fi
    pkill -x chatcode-gateway >/dev/null 2>&1 || true
    try_unlink_control_plane

    safe_rm_file "${LINUX_SERVICE_FILE}"
    safe_rm_file "${LINUX_MAINTENANCE_SERVICE_FILE}"
    safe_rm_file "${LINUX_MAINTENANCE_TIMER_FILE}"
    safe_rm_file "${LINUX_MAINTENANCE_SCRIPT}"
    safe_rm_file "${LINUX_AGENT_UPDATE_HELPER}"
    for helper in "${LINUX_AGENT_INSTALLER_SCRIPTS[@]}"; do
      safe_rm_file "${helper}"
    done
    safe_rm_file "${LINUX_MAINTENANCE_LOCK}"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload
      systemctl reset-failed "${SERVICE_NAME}" >/dev/null 2>&1 || true
      systemctl reset-failed "${LINUX_MAINTENANCE_SERVICE}.service" >/dev/null 2>&1 || true
      systemctl reset-failed "${LINUX_MAINTENANCE_SERVICE}.timer" >/dev/null 2>&1 || true
    fi

    safe_rm_file "${LINUX_BINARY_PATH}"
    safe_rm_file "${LINUX_SUDOERS_FILE}"
    safe_rm_file "${LINUX_LOGROTATE_FILE}"
    if command -v chattr >/dev/null 2>&1; then
      chattr -a "${LINUX_SUDO_LOG_FILE}" >/dev/null 2>&1 || true
    fi
    safe_rm_file "${LINUX_SUDO_LOG_FILE}"
    safe_rm_dir "${LINUX_SUDO_LOG_DIR}"
    safe_rm_dir "${LINUX_CONFIG_DIR}"
    safe_rm_dir "/tmp/chatcode"
    safe_rm_dir "/opt/chatcode"

    if [[ "${KEEP_USER}" -eq 1 ]]; then
      if [[ "${KEEP_WORKSPACE}" -eq 0 ]]; then
        safe_rm_dir "${WORKSPACE_DIR}"
      fi
      log "--keep-user set; leaving user/home in place"
    else
      if id "${LINUX_USER}" >/dev/null 2>&1; then
        if ! userdel --remove "${LINUX_USER}" >/dev/null 2>&1; then
          userdel "${LINUX_USER}" >/dev/null 2>&1 || true
          safe_rm_dir "${VIBE_HOME}"
        fi
        log "removed user ${LINUX_USER} (and home when possible)"
      fi
    fi

    log "cleanup complete"
    ;;

  Darwin)
    if [[ "${EUID}" -eq 0 ]]; then
      die "macOS cleanup must run as the target user (do not use sudo)"
    fi
    if [[ "${KEEP_USER}" -eq 1 || "${KEEP_WORKSPACE}" -eq 1 ]]; then
      die "--keep-user/--keep-workspace are Linux-only"
    fi

    USER_HOME="${HOME}"
    USER_UID="$(id -u)"
    PLIST_PATH="${USER_HOME}/Library/LaunchAgents/${DARWIN_LABEL}.plist"
    MAINTENANCE_PLIST_PATH="${USER_HOME}/Library/LaunchAgents/${DARWIN_MAINTENANCE_LABEL}.plist"
    CONFIG_DIR="${USER_HOME}/.config/chatcode"
    ENV_FILE="${CONFIG_DIR}/gateway.env"
    BINARY_PATH="${USER_HOME}/.local/bin/chatcode-gateway"
    AGENT_UPDATE_HELPER="${USER_HOME}/.local/bin/chatcode-update-agent-clis"
    MAINTENANCE_SCRIPT="${USER_HOME}/.local/bin/chatcode-maintenance"
    INSTALLER_CLAUDE="${USER_HOME}/.local/bin/install-claude-code.sh"
    INSTALLER_CODEX="${USER_HOME}/.local/bin/install-codex.sh"
    INSTALLER_GEMINI="${USER_HOME}/.local/bin/install-gemini.sh"
    INSTALLER_OPENCODE="${USER_HOME}/.local/bin/install-opencode.sh"
    INSTALLER_GIT="${USER_HOME}/.local/bin/install-git.sh"
    WORKSPACE_DIR="${USER_HOME}/workspace"

    bootout_darwin_agent "${USER_UID}" "${DARWIN_LABEL}" "${PLIST_PATH}"
    bootout_darwin_agent "${USER_UID}" "${DARWIN_MAINTENANCE_LABEL}" "${MAINTENANCE_PLIST_PATH}"
    pkill -x chatcode-gateway >/dev/null 2>&1 || true
    load_gateway_env "${ENV_FILE}"
    try_unlink_control_plane

    safe_rm_file "${PLIST_PATH}"
    safe_rm_file "${MAINTENANCE_PLIST_PATH}"
    safe_rm_file "${BINARY_PATH}"
    safe_rm_file "${AGENT_UPDATE_HELPER}"
    safe_rm_file "${MAINTENANCE_SCRIPT}"
    safe_rm_file "${INSTALLER_CLAUDE}"
    safe_rm_file "${INSTALLER_CODEX}"
    safe_rm_file "${INSTALLER_GEMINI}"
    safe_rm_file "${INSTALLER_OPENCODE}"
    safe_rm_file "${INSTALLER_GIT}"
    safe_rm_dir "${CONFIG_DIR}"
    safe_rm_dir "/tmp/chatcode"

    if [[ "${REMOVE_WORKSPACE}" -eq 1 ]]; then
      safe_rm_dir "${WORKSPACE_DIR}"
    else
      log "kept workspace at ${WORKSPACE_DIR} (use --remove-workspace to delete it)"
    fi

    log "cleanup complete"
    ;;

  *)
    die "unsupported OS: ${OS_NAME}"
    ;;
esac
