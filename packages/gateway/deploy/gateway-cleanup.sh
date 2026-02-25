#!/usr/bin/env bash
# gateway-cleanup.sh - Remove chatcode-gateway service/runtime from a host.
#
# By default this script removes:
# - chatcode-gateway systemd unit + process
# - /etc/chatcode config
# - /usr/local/bin/chatcode-gateway binary
# - vibe sudoers entry
# - vibe user and home directory
# - /tmp/chatcode and /opt/chatcode leftovers
#
# This is intentionally destructive and requires --yes.
set -euo pipefail

SERVICE_NAME="chatcode-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_DIR="/etc/chatcode"
BINARY_PATH="/usr/local/bin/chatcode-gateway"
VIBE_USER="vibe"
SUDOERS_FILE="/etc/sudoers.d/vibe"

CONFIRM=0
KEEP_USER=0
KEEP_WORKSPACE=0

usage() {
  cat <<'EOF'
Usage:
  sudo ./gateway-cleanup.sh --yes

Options:
  --yes             Required. Confirm destructive cleanup.
  --keep-user       Keep vibe user/home (service + files are still removed).
  --keep-workspace  Keep /home/vibe/workspace (only relevant with --keep-user).
  -h, --help        Show this help.
EOF
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
    /|/home|/etc|/usr|/var|/tmp)
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  die "run as root (use sudo)"
fi

if [[ "${CONFIRM}" -ne 1 ]]; then
  usage
  die "--yes is required"
fi

if [[ "${KEEP_WORKSPACE}" -eq 1 && "${KEEP_USER}" -eq 0 ]]; then
  die "--keep-workspace requires --keep-user"
fi

VIBE_HOME="/home/${VIBE_USER}"
if id "${VIBE_USER}" >/dev/null 2>&1; then
  maybe_home="$(getent passwd "${VIBE_USER}" | cut -d: -f6)"
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

safe_rm_file "${SERVICE_FILE}"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl reset-failed "${SERVICE_NAME}" >/dev/null 2>&1 || true
fi

safe_rm_file "${BINARY_PATH}"
safe_rm_file "${SUDOERS_FILE}"
safe_rm_dir "${CONFIG_DIR}"
safe_rm_dir "/tmp/chatcode"
safe_rm_dir "/opt/chatcode"

if [[ "${KEEP_USER}" -eq 1 ]]; then
  if [[ "${KEEP_WORKSPACE}" -eq 0 ]]; then
    safe_rm_dir "${WORKSPACE_DIR}"
  fi
  log "--keep-user set; leaving user/home in place"
else
  if id "${VIBE_USER}" >/dev/null 2>&1; then
    if ! userdel --remove "${VIBE_USER}" >/dev/null 2>&1; then
      # Fallback for distros where --remove fails due running processes or hooks.
      userdel "${VIBE_USER}" >/dev/null 2>&1 || true
      safe_rm_dir "${VIBE_HOME}"
    fi
    log "removed user ${VIBE_USER} (and home when possible)"
  fi
fi

log "cleanup complete"
