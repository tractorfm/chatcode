#!/usr/bin/env bash
# Install or update agent CLIs via per-agent installer scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLED_ONLY=0
BEST_EFFORT=0

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/update-agent-clis.sh [options] [agent...]

Options:
  --installed-only  Update only agents already installed on this machine.
  --best-effort     Continue even if one agent update fails.
  -h, --help        Show this help.

Examples:
  ./scripts/update-agent-clis.sh
  ./scripts/update-agent-clis.sh claude-code codex
  ./scripts/update-agent-clis.sh --installed-only
USAGE
}

log() {
  echo "[vibecode] $*"
}

die() {
  echo "[vibecode] ERROR: $*" >&2
  exit 1
}

supported_agents=(claude-code codex gemini opencode)

bin_for_agent() {
  case "$1" in
    claude-code) echo "claude" ;;
    codex) echo "codex" ;;
    gemini) echo "gemini" ;;
    opencode) echo "opencode" ;;
    *) return 1 ;;
  esac
}

installer_for_agent() {
  case "$1" in
    claude-code) echo "${SCRIPT_DIR}/install-claude-code.sh" ;;
    codex) echo "${SCRIPT_DIR}/install-codex.sh" ;;
    gemini) echo "${SCRIPT_DIR}/install-gemini.sh" ;;
    opencode) echo "${SCRIPT_DIR}/install-opencode.sh" ;;
    *) return 1 ;;
  esac
}

is_supported_agent() {
  local candidate="$1"
  local a
  for a in "${supported_agents[@]}"; do
    if [[ "$a" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --installed-only)
      INSTALLED_ONLY=1
      shift
      ;;
    --best-effort)
      BEST_EFFORT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

requested_agents=("$@")
agents=()

if [[ ${#requested_agents[@]} -gt 0 ]]; then
  for agent in "${requested_agents[@]}"; do
    is_supported_agent "${agent}" || die "unknown agent: ${agent}"
    if [[ "${INSTALLED_ONLY}" -eq 1 ]]; then
      bin="$(bin_for_agent "${agent}")" || die "unknown agent: ${agent}"
      if ! command -v "${bin}" >/dev/null 2>&1; then
        log "skip ${agent} (not installed)"
        continue
      fi
    fi
    agents+=("${agent}")
  done
elif [[ "${INSTALLED_ONLY}" -eq 1 ]]; then
  for agent in "${supported_agents[@]}"; do
    bin="$(bin_for_agent "${agent}")"
    if command -v "${bin}" >/dev/null 2>&1; then
      agents+=("${agent}")
    fi
  done
else
  agents=("${supported_agents[@]}")
fi

if [[ ${#agents[@]} -eq 0 ]]; then
  log "no agents selected"
  exit 0
fi

failures=0
for agent in "${agents[@]}"; do
  installer="$(installer_for_agent "${agent}")" || {
    log "missing installer mapping for ${agent}"
    failures=$((failures + 1))
    continue
  }
  if [[ ! -f "${installer}" ]]; then
    log "missing installer script for ${agent}: ${installer}"
    failures=$((failures + 1))
    continue
  fi
  if [[ ! -x "${installer}" ]]; then
    chmod +x "${installer}" >/dev/null 2>&1 || true
  fi

  log "install/update ${agent}"
  if ! "${installer}"; then
    log "update failed for ${agent}"
    failures=$((failures + 1))
    if [[ "${BEST_EFFORT}" -ne 1 ]]; then
      exit 1
    fi
  fi
done

if [[ "${failures}" -gt 0 ]]; then
  die "${failures} agent update(s) failed"
fi

log "done"
