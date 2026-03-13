#!/usr/bin/env bash
# Install OpenAI Codex CLI on the gateway host for the target user.
# Copyright (c) 2026 Chatcode contributors.
# Project: https://github.com/tractorfm/chatcode
set -euo pipefail

echo "[chatcode] Installing Codex CLI for the Chatcode gateway host..."

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    echo "[chatcode] ERROR: run this installer as the target non-root user so Codex CLI is installed under that user's home" >&2
    exit 1
fi

LOCAL_PREFIX="${HOME}/.local"
LOCAL_BIN="${LOCAL_PREFIX}/bin"
CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
CODEX_GUIDANCE_FILE="${CODEX_HOME_DIR}/AGENTS.md"

ensure_node() {
    local os
    os="$(uname -s)"
    if command -v node &>/dev/null; then
        local node_major
        node_major="$(node --version | cut -d. -f1 | tr -d 'v')"
        if [ "${node_major}" -ge 24 ]; then
            return 0
        fi
        echo "[chatcode] Node.js version too old ($(node --version)), upgrading..."
    else
        echo "[chatcode] Node.js not found, installing..."
    fi

    if [ "${os}" = "Linux" ]; then
        # Linux package install path assumes Debian/Ubuntu (our managed VPS image).
        if ! command -v sudo >/dev/null 2>&1; then
            echo "[chatcode] ERROR: sudo is required on Linux to install Node.js" >&2
            exit 1
        fi
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
        sudo apt-get install -y nodejs
        return 0
    fi

    if [ "${os}" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            cat >&2 <<'EOF'
[chatcode] ERROR: Homebrew is required on macOS to install Node.js 24 for Codex CLI.
[chatcode] Run:
[chatcode]   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
[chatcode]   brew install git node@24
[chatcode]   export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:$PATH"
EOF
            exit 1
        fi
        brew install node@24
        export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:${PATH}"
        return 0
    fi

    echo "[chatcode] ERROR: unsupported OS ${os} for automatic Node.js install" >&2
    exit 1
}

ensure_node

npm_user_install() {
    local pkg="$1"
    install -d -m 755 "${LOCAL_BIN}" "${LOCAL_PREFIX}/lib"
    export PATH="${LOCAL_BIN}:${PATH}"
    npm install -g --prefix "${LOCAL_PREFIX}" "${pkg}"
}

seed_default_codex_guidance() {
    install -d -m 755 "${CODEX_HOME_DIR}"
    if [ -e "${CODEX_GUIDANCE_FILE}" ]; then
        echo "[chatcode] Codex global guidance already exists at ${CODEX_GUIDANCE_FILE}; leaving it untouched"
        return 0
    fi

    cat > "${CODEX_GUIDANCE_FILE}" <<'EOF'
# Chatcode Global AGENTS.md

You are running inside a Chatcode-managed terminal session on a user-controlled machine.

- Scope: prefer changes inside the current repo/workspace and the user's home directory.
- Safety: ask before `sudo`, system package installs, service changes, or destructive deletes.
- Secrets: never print, copy, or persist tokens, keys, or credentials.
- Session model: the terminal is tmux-backed already; do not start nested tmux sessions.
- Workflow: inspect before editing, keep patches minimal, run relevant tests, and report concrete changes plus remaining risk.
EOF
}

# Install/upgrade Codex CLI in the target user's local prefix.
npm_user_install "@openai/codex@latest"
seed_default_codex_guidance

# Verify installation
if ! command -v codex &>/dev/null; then
    echo "[chatcode] ERROR: codex not found in PATH after install" >&2
    exit 1
fi

echo "[chatcode] Codex CLI installed: $(codex --version)"
