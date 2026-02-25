#!/usr/bin/env bash
# cloud-init.sh – Bootstrap a DigitalOcean droplet for Chatcode.dev
#
# This script is intended to be passed as cloud-init user-data or run
# manually on a fresh Ubuntu 22.04 droplet.
#
# Required environment variables (set before running):
#   GATEWAY_ID         – assigned by control plane
#   GATEWAY_AUTH_TOKEN – assigned by control plane
#   GATEWAY_CP_URL     – e.g. wss://cp.chatcode.dev/gw/connect
#   GATEWAY_VERSION    – release tag to install, e.g. "v0.1.0"
#
# Optional:
#   GATEWAY_RELEASE_BASE_URL – defaults to https://releases.chatcode.dev/gateway
set -euo pipefail

GATEWAY_RELEASE_BASE_URL="${GATEWAY_RELEASE_BASE_URL:-https://releases.chatcode.dev/gateway}"
BINARY_PATH="/usr/local/bin/chatcode-gateway"
SERVICE_NAME="chatcode-gateway"
CONFIG_DIR="/etc/chatcode"
VIBE_USER="vibe"
VIBE_HOME="/home/vibe"

echo "[cloud-init] Chatcode.dev gateway bootstrap starting..."

# ----- System setup -----

# Update and install dependencies
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q tmux curl ca-certificates git

# Create vibe user if it doesn't exist
if ! id "$VIBE_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$VIBE_USER"
    echo "$VIBE_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vibe
    chmod 0440 /etc/sudoers.d/vibe
fi

# Set up SSH directory
mkdir -p "$VIBE_HOME/.ssh"
chmod 700 "$VIBE_HOME/.ssh"
touch "$VIBE_HOME/.ssh/authorized_keys"
chmod 600 "$VIBE_HOME/.ssh/authorized_keys"
chown -R "$VIBE_USER:$VIBE_USER" "$VIBE_HOME/.ssh"

# ----- Install gateway binary -----

if [ -z "${GATEWAY_VERSION:-}" ]; then
    echo "[cloud-init] ERROR: GATEWAY_VERSION not set" >&2
    exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64) RELEASE_ARCH="amd64" ;;
    aarch64|arm64) RELEASE_ARCH="arm64" ;;
    *)
        echo "[cloud-init] ERROR: unsupported architecture: $ARCH" >&2
        exit 1
        ;;
esac

BINARY_URL="$GATEWAY_RELEASE_BASE_URL/$GATEWAY_VERSION/chatcode-gateway-linux-$RELEASE_ARCH"
SHA256_URL="$BINARY_URL.sha256"

echo "[cloud-init] Downloading gateway $GATEWAY_VERSION..."
curl -fsSL -o "${BINARY_PATH}.new" "$BINARY_URL"
curl -fsSL -o "${BINARY_PATH}.sha256" "$SHA256_URL"

# Verify checksum
EXPECTED_SHA256=$(awk '{print $1}' "${BINARY_PATH}.sha256")
ACTUAL_SHA256=$(sha256sum "${BINARY_PATH}.new" | awk '{print $1}')
if [ "$EXPECTED_SHA256" != "$ACTUAL_SHA256" ]; then
    echo "[cloud-init] ERROR: checksum mismatch" >&2
    echo "  expected: $EXPECTED_SHA256" >&2
    echo "  actual:   $ACTUAL_SHA256" >&2
    rm -f "${BINARY_PATH}.new" "${BINARY_PATH}.sha256"
    exit 1
fi

mv "${BINARY_PATH}.new" "$BINARY_PATH"
chmod 755 "$BINARY_PATH"
rm -f "${BINARY_PATH}.sha256"

echo "[cloud-init] Gateway binary installed: $BINARY_PATH"

# ----- Write config -----

mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

cat > "$CONFIG_DIR/gateway.env" <<EOF
GATEWAY_ID=${GATEWAY_ID}
GATEWAY_AUTH_TOKEN=${GATEWAY_AUTH_TOKEN}
GATEWAY_CP_URL=${GATEWAY_CP_URL}
GATEWAY_BINARY_PATH=${BINARY_PATH}
GATEWAY_LOG_LEVEL=info
EOF

chmod 600 "$CONFIG_DIR/gateway.env"

# ----- Install systemd unit -----

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<'UNIT'
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

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo "[cloud-init] Gateway service started."
systemctl status "$SERVICE_NAME" --no-pager || true

echo "[cloud-init] Bootstrap complete!"
