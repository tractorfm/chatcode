#!/usr/bin/env bash
# gateway-cleanup.sh - Remove chatcode-gateway service/runtime from a host.
#
# Linux (root, dedicated vibe user):
# - chatcode-gateway systemd unit + process
# - /etc/chatcode config
# - /usr/local/bin/chatcode-gateway binary
# - vibe sudoers entry
# - vibe user and home directory (unless --keep-user)
# - /tmp/chatcode and /opt/chatcode leftovers
#
# macOS (current user):
# - dev.chatcode.gateway launchd agent
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

DARWIN_LABEL="dev.chatcode.gateway"

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
  local plist_path="$2"

  launchctl bootout "gui/${uid}" "${plist_path}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${uid}/${DARWIN_LABEL}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}" "${plist_path}" >/dev/null 2>&1 || true
  launchctl bootout "user/${uid}/${DARWIN_LABEL}" >/dev/null 2>&1 || true
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
    fi
    pkill -x chatcode-gateway >/dev/null 2>&1 || true

    safe_rm_file "${LINUX_SERVICE_FILE}"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload
      systemctl reset-failed "${SERVICE_NAME}" >/dev/null 2>&1 || true
    fi

    safe_rm_file "${LINUX_BINARY_PATH}"
    safe_rm_file "${LINUX_SUDOERS_FILE}"
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
    CONFIG_DIR="${USER_HOME}/.config/chatcode"
    BINARY_PATH="${USER_HOME}/.local/bin/chatcode-gateway"
    WORKSPACE_DIR="${USER_HOME}/workspace"

    bootout_darwin_agent "${USER_UID}" "${PLIST_PATH}"
    pkill -x chatcode-gateway >/dev/null 2>&1 || true

    safe_rm_file "${PLIST_PATH}"
    safe_rm_file "${BINARY_PATH}"
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
