#!/usr/bin/env bash
# Install Claude Code CLI on the vibe user's VPS.
# Claude Code requires Node.js 18+ and is installed via npm.
set -euo pipefail

echo "[vibecode] Installing Claude Code..."

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

# Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# Verify installation
if ! command -v claude &>/dev/null; then
    echo "[vibecode] ERROR: claude not found in PATH after install" >&2
    exit 1
fi

echo "[vibecode] Claude Code installed: $(claude --version)"
