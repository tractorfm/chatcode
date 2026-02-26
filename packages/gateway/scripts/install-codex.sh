#!/usr/bin/env bash
# Install OpenAI Codex CLI on the vibe user's VPS.
set -euo pipefail

echo "[vibecode] Installing Codex CLI..."

ensure_node() {
    local os
    os="$(uname -s)"
    if command -v node &>/dev/null; then
        local node_major
        node_major="$(node --version | cut -d. -f1 | tr -d 'v')"
        if [ "${node_major}" -ge 24 ]; then
            return 0
        fi
        echo "[vibecode] Node.js version too old ($(node --version)), upgrading..."
    else
        echo "[vibecode] Node.js not found, installing..."
    fi

    if [ "${os}" = "Linux" ]; then
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
        sudo apt-get install -y nodejs
        return 0
    fi

    if [ "${os}" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            echo "[vibecode] ERROR: Homebrew is required on macOS to install Node.js" >&2
            exit 1
        fi
        brew install node@24
        export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:${PATH}"
        return 0
    fi

    echo "[vibecode] ERROR: unsupported OS ${os} for automatic Node.js install" >&2
    exit 1
}

ensure_node

# Install/upgrade Codex CLI globally
npm install -g @openai/codex@latest

# Verify installation
if ! command -v codex &>/dev/null; then
    echo "[vibecode] ERROR: codex not found in PATH after install" >&2
    exit 1
fi

echo "[vibecode] Codex CLI installed: $(codex --version)"
