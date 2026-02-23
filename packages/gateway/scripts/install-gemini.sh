#!/usr/bin/env bash
# Install Google Gemini CLI on the vibe user's VPS.
set -euo pipefail

echo "[vibecode] Installing Gemini CLI..."

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

# Install Gemini CLI globally
npm install -g @google/gemini-cli

# Verify installation
if ! command -v gemini &>/dev/null; then
    echo "[vibecode] ERROR: gemini not found in PATH after install" >&2
    exit 1
fi

echo "[vibecode] Gemini CLI installed: $(gemini --version)"
