#!/usr/bin/env bash
# cloud-init.sh – Bootstrap a DigitalOcean droplet for Chatcode.dev by
# delegating to gateway-install.sh from the selected release.
set -euo pipefail

GATEWAY_RELEASE_BASE_URL="${GATEWAY_RELEASE_BASE_URL:-https://releases.chatcode.dev/gateway}"
BOOTSTRAP_TMP_DIR="/tmp/chatcode-bootstrap"
INSTALLER_PATH="${BOOTSTRAP_TMP_DIR}/gateway-install.sh"

echo "[cloud-init] Chatcode.dev bootstrap starting..."

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

install -d -m 755 "${BOOTSTRAP_TMP_DIR}"
curl -fsSL -o "${INSTALLER_PATH}" "${GATEWAY_RELEASE_BASE_URL}/${GATEWAY_VERSION}/gateway-install.sh"
chmod 0755 "${INSTALLER_PATH}"

for dep in update-agent-clis.sh install-claude-code.sh install-codex.sh install-gemini.sh install-opencode.sh; do
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
