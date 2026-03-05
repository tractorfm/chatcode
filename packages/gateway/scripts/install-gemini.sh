#!/usr/bin/env bash
# Install Google Gemini CLI on the vibe user's VPS.
set -euo pipefail

echo "[vibecode] Installing Gemini CLI..."

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
        # Linux package install path assumes Debian/Ubuntu (our managed VPS image).
        if [ "${EUID:-$(id -u)}" -eq 0 ]; then
            curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
            apt-get install -y nodejs
        else
            curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
            sudo apt-get install -y nodejs
        fi
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

npm_global_install() {
    local pkg="$1"
    local os
    os="$(uname -s)"
    if [ "${os}" = "Linux" ] && [ "${EUID:-$(id -u)}" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            sudo -n npm install -g "${pkg}"
            return 0
        fi
        echo "[vibecode] ERROR: sudo is required for global npm install on Linux" >&2
        exit 1
    fi
    npm install -g "${pkg}"
}

# Install/upgrade Gemini CLI globally
npm_global_install "@google/gemini-cli@latest"

# Verify installation
if ! command -v gemini &>/dev/null; then
    echo "[vibecode] ERROR: gemini not found in PATH after install" >&2
    exit 1
fi

echo "[vibecode] Gemini CLI installed: $(gemini --version)"
