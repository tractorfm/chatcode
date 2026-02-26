#!/usr/bin/env bash
# Update installed agent CLIs to the latest versions.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/update-agent-clis.sh [agent...]

Examples:
  ./scripts/update-agent-clis.sh
  ./scripts/update-agent-clis.sh codex opencode

Supported agents:
  claude-code codex gemini opencode
USAGE
}

log() {
  echo "[vibecode] $*"
}

die() {
  echo "[vibecode] ERROR: $*" >&2
  exit 1
}

ensure_node() {
  local os
  os="$(uname -s)"

  if command -v node >/dev/null 2>&1; then
    local node_major
    node_major="$(node --version | cut -d. -f1 | tr -d 'v')"
    if [[ "${node_major}" -ge 24 ]]; then
      return 0
    fi
    log "Node.js version too old ($(node --version)), upgrading..."
  else
    log "Node.js not found, installing..."
  fi

  case "${os}" in
    Linux)
      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        die "Homebrew is required on macOS to install Node.js"
      fi
      brew install node@24
      export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:${PATH}"
      ;;
    *)
      die "unsupported OS ${os} for automatic Node.js install"
      ;;
  esac
}

pkg_for_agent() {
  case "$1" in
    claude-code) echo "@anthropic-ai/claude-code@latest" ;;
    codex) echo "@openai/codex@latest" ;;
    gemini) echo "@google/gemini-cli@latest" ;;
    opencode) echo "opencode-ai@latest" ;;
    *) return 1 ;;
  esac
}

bin_for_agent() {
  case "$1" in
    claude-code) echo "claude" ;;
    codex) echo "codex" ;;
    gemini) echo "gemini" ;;
    opencode) echo "opencode" ;;
    *) return 1 ;;
  esac
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ensure_node

agents=("$@")
if [[ ${#agents[@]} -eq 0 ]]; then
  agents=(claude-code codex gemini opencode)
fi

for agent in "${agents[@]}"; do
  pkg="$(pkg_for_agent "${agent}")" || die "unknown agent: ${agent}"
  bin="$(bin_for_agent "${agent}")" || die "unknown agent: ${agent}"

  log "updating ${agent} (${pkg})"
  npm install -g "${pkg}"

  if ! command -v "${bin}" >/dev/null 2>&1; then
    die "${bin} not found in PATH after install"
  fi
  log "${agent} version: $(${bin} --version | head -n 1)"
done

log "done"
