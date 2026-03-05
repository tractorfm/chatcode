#!/usr/bin/env bash
# Ensure git is installed on the gateway host.
set -euo pipefail

log() {
  echo "[vibecode] $*"
}

if command -v git >/dev/null 2>&1; then
  log "Git already installed: $(git --version)"
  exit 0
fi

os="$(uname -s)"
log "Git not found, installing for ${os}..."

if [[ "${os}" == "Linux" ]]; then
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q git
  else
    if ! command -v sudo >/dev/null 2>&1; then
      echo "[vibecode] ERROR: sudo is required to install git on Linux" >&2
      exit 1
    fi
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q git
  fi
elif [[ "${os}" == "Darwin" ]]; then
  if command -v brew >/dev/null 2>&1; then
    brew install git
  else
    echo "[vibecode] ERROR: Homebrew is required on macOS to install git" >&2
    exit 1
  fi
else
  echo "[vibecode] ERROR: unsupported OS ${os} for automatic git install" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[vibecode] ERROR: git not found in PATH after install" >&2
  exit 1
fi

log "Git installed: $(git --version)"
