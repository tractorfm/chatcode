#!/usr/bin/env bash
# cloud-init.sh – Bootstrap a DigitalOcean droplet for Chatcode.dev by
# delegating to gateway-install.sh from the selected release.
#
# Copyright (c) 2026 Chatcode contributors.
# Project: https://github.com/tractorfm/chatcode
set -euo pipefail

GATEWAY_RELEASE_BASE_URL="${GATEWAY_RELEASE_BASE_URL:-https://releases.chatcode.dev/gateway}"
TMPDIR="${TMPDIR:-/var/tmp}"
export TMPDIR
BOOTSTRAP_TMP_DIR="${TMPDIR%/}/chatcode-bootstrap"
INSTALLER_PATH="${BOOTSTRAP_TMP_DIR}/gateway-install.sh"

echo "[cloud-init] Chatcode.dev bootstrap starting..."

warn_small_tmpfs_tmp() {
  if mount | grep -Eq ' on /tmp type tmpfs '; then
    local total_kb avail_kb
    total_kb="$(df -Pk /tmp | awk 'NR==2 {print $2}')"
    avail_kb="$(df -Pk /tmp | awk 'NR==2 {print $4}')"
    if [[ -n "${avail_kb}" && "${avail_kb}" -lt 262144 ]]; then
      echo "[cloud-init] WARN: /tmp is tmpfs with only $((avail_kb / 1024)) MiB free; using ${TMPDIR} for Chatcode bootstrap downloads"
    fi
    if [[ -n "${total_kb}" && "${total_kb}" -lt 524288 ]]; then
      echo "[cloud-init] WARN: /tmp is a small tmpfs ($((total_kb / 1024)) MiB total)"
    fi
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "[cloud-init] ERROR: ${name} not set" >&2
    exit 1
  fi
}

require_env GATEWAY_ID
require_env GATEWAY_AUTH_TOKEN
require_env GATEWAY_CP_URL
require_env GATEWAY_VERSION

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q tmux curl ca-certificates git logrotate sudo
warn_small_tmpfs_tmp

install -d -m 755 "${BOOTSTRAP_TMP_DIR}"
curl -fsSL -o "${INSTALLER_PATH}" "${GATEWAY_RELEASE_BASE_URL}/${GATEWAY_VERSION}/gateway-install.sh"
chmod 0755 "${INSTALLER_PATH}"

for dep in update-agent-clis.sh install-git.sh install-claude-code.sh install-codex.sh install-gemini.sh install-opencode.sh; do
  if curl -fsSL -o "${BOOTSTRAP_TMP_DIR}/${dep}" "${GATEWAY_RELEASE_BASE_URL}/${GATEWAY_VERSION}/${dep}"; then
    chmod 0755 "${BOOTSTRAP_TMP_DIR}/${dep}"
  else
    echo "[cloud-init] WARN: unable to download ${dep}; installer will continue without it"
  fi
done

install_args=(
  --version "${GATEWAY_VERSION}"
  --release-base-url "${GATEWAY_RELEASE_BASE_URL}"
  --gateway-id "${GATEWAY_ID}"
  --gateway-auth-token "${GATEWAY_AUTH_TOKEN}"
  --cp-url "${GATEWAY_CP_URL}"
)

if [[ -n "${GATEWAY_BOOTSTRAP_TOKEN:-}" ]]; then
  install_args+=(--bootstrap-token "${GATEWAY_BOOTSTRAP_TOKEN}")
fi

"${INSTALLER_PATH}" "${install_args[@]}"

echo "[cloud-init] Bootstrap complete!"
