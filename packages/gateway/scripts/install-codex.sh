#!/usr/bin/env bash
# Install OpenAI Codex CLI on the vibe user's VPS.
set -euo pipefail

echo "[vibecode] Installing Codex CLI..."

# Ensure Node.js >= 18 is available
if ! command -v node &>/dev/null; then
    echo "[vibecode] Node.js not found, installing via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node --version | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "[vibecode] Node.js version too old ($(node --version)), upgrading..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install Codex CLI globally
npm install -g @openai/codex

# Verify installation
if ! command -v codex &>/dev/null; then
    echo "[vibecode] ERROR: codex not found in PATH after install" >&2
    exit 1
fi

echo "[vibecode] Codex CLI installed: $(codex --version)"
