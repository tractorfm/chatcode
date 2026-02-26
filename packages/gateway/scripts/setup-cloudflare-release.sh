#!/usr/bin/env bash
# Provision Cloudflare release distribution for gateway artifacts.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/setup-cloudflare-release.sh [options]

Options:
  --bucket <name>             R2 bucket name (default: chatcode-releases)
  --release-domain <fqdn>     R2 custom domain for release files (default: releases.chatcode.dev)
  --install-domain <fqdn>     Main domain for installer route (default: chatcode.dev)
  --release-prefix <prefix>   Object prefix in the bucket (default: gateway)
  --worker-name <name>        Redirect worker name (default: chatcode-install-redirect)
  --zone-id <id>              Cloudflare zone id (required if release domain is not already attached)
  --skip-redirect             Only configure bucket/domain, skip installer redirect worker deploy
  -h, --help                  Show help

Notes:
  - Requires Wrangler auth (`wrangler whoami` must succeed).
  - Uses `wrangler` in PATH, or falls back to repo-local:
      corepack pnpm --dir <repo> --filter @chatcode/control-plane exec wrangler
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

BUCKET="chatcode-releases"
RELEASE_DOMAIN="releases.chatcode.dev"
INSTALL_DOMAIN="chatcode.dev"
RELEASE_PREFIX="gateway"
WORKER_NAME="chatcode-install-redirect"
ZONE_ID="${CF_ZONE_ID:-}"
SKIP_REDIRECT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      BUCKET="${2:-}"
      shift 2
      ;;
    --release-domain)
      RELEASE_DOMAIN="${2:-}"
      shift 2
      ;;
    --install-domain)
      INSTALL_DOMAIN="${2:-}"
      shift 2
      ;;
    --release-prefix)
      RELEASE_PREFIX="${2:-}"
      shift 2
      ;;
    --worker-name)
      WORKER_NAME="${2:-}"
      shift 2
      ;;
    --zone-id)
      ZONE_ID="${2:-}"
      shift 2
      ;;
    --skip-redirect)
      SKIP_REDIRECT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[setup-cloudflare-release] unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

WRANGLER_CMD=()
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER_CMD=(wrangler)
elif command -v corepack >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  WRANGLER_CMD=(corepack pnpm --dir "${REPO_ROOT}" --filter @chatcode/control-plane exec wrangler)
else
  echo "[setup-cloudflare-release] wrangler not found (and no corepack/pnpm fallback available)" >&2
  exit 1
fi

wr() {
  "${WRANGLER_CMD[@]}" "$@"
}

echo "[setup-cloudflare-release] validating wrangler auth"
WHOAMI_JSON="$(wr whoami --json)"

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  CLOUDFLARE_ACCOUNT_ID="$(
    printf '%s\n' "${WHOAMI_JSON}" | awk -F'"' '
      /"accounts": \[/ { in_accounts = 1 }
      in_accounts && /"id":/ { print $4; exit }
    '
  )"
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID}" ]]; then
    echo "[setup-cloudflare-release] could not infer CLOUDFLARE_ACCOUNT_ID from wrangler whoami" >&2
    exit 1
  fi
  export CLOUDFLARE_ACCOUNT_ID
fi

echo "[setup-cloudflare-release] account: ${CLOUDFLARE_ACCOUNT_ID}"

echo "[setup-cloudflare-release] ensuring R2 bucket '${BUCKET}'"
BUCKET_NAMES="$(wr r2 bucket list | awk '/^name:/{print $2}')"
if printf '%s\n' "${BUCKET_NAMES}" | grep -Fxq "${BUCKET}"; then
  echo "[setup-cloudflare-release] bucket already exists"
else
  wr r2 bucket create "${BUCKET}"
fi

echo "[setup-cloudflare-release] ensuring custom domain '${RELEASE_DOMAIN}' for bucket '${BUCKET}'"
DOMAIN_LIST="$(wr r2 bucket domain list "${BUCKET}" || true)"
if printf '%s\n' "${DOMAIN_LIST}" | awk '/^domain:/{print $2}' | grep -Fxq "${RELEASE_DOMAIN}"; then
  echo "[setup-cloudflare-release] custom domain already attached"
else
  if [[ -z "${ZONE_ID}" ]]; then
    echo "[setup-cloudflare-release] --zone-id is required to attach '${RELEASE_DOMAIN}'" >&2
    exit 1
  fi
  wr r2 bucket domain add "${BUCKET}" \
    --domain "${RELEASE_DOMAIN}" \
    --zone-id "${ZONE_ID}" \
    --min-tls 1.2
fi

if [[ "${SKIP_REDIRECT}" -eq 1 ]]; then
  echo "[setup-cloudflare-release] skip redirect worker deploy (--skip-redirect)"
else
  INSTALL_TARGET_URL="https://${RELEASE_DOMAIN}/${RELEASE_PREFIX}/latest/gateway-install.sh"
  CLEANUP_TARGET_URL="https://${RELEASE_DOMAIN}/${RELEASE_PREFIX}/latest/gateway-cleanup.sh"
  INSTALL_ROUTE="${INSTALL_DOMAIN}/install.sh*"
  CLEANUP_ROUTE="${INSTALL_DOMAIN}/cleanup.sh*"
  COMPAT_DATE="$(date -u +%Y-%m-%d)"

  TMP_DIR="$(mktemp -d)"
  TMP_WORKER="${TMP_DIR}/install-redirect.mjs"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  cat > "${TMP_WORKER}" <<'JS'
export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    let target;
    switch (reqUrl.pathname) {
      case "/install.sh":
        target = new URL(env.INSTALL_TARGET_URL);
        break;
      case "/cleanup.sh":
        target = new URL(env.CLEANUP_TARGET_URL);
        break;
      default:
        return new Response("Not found", { status: 404 });
    }
    target.search = reqUrl.search;
    return Response.redirect(target.toString(), 302);
  },
};
JS

  echo "[setup-cloudflare-release] deploying redirect worker '${WORKER_NAME}' on routes '${INSTALL_ROUTE}' and '${CLEANUP_ROUTE}'"
  wr deploy "${TMP_WORKER}" \
    --name "${WORKER_NAME}" \
    --compatibility-date "${COMPAT_DATE}" \
    --routes "${INSTALL_ROUTE}" \
    --routes "${CLEANUP_ROUTE}" \
    --var "INSTALL_TARGET_URL:${INSTALL_TARGET_URL}" \
    --var "CLEANUP_TARGET_URL:${CLEANUP_TARGET_URL}"

  if command -v curl >/dev/null 2>&1; then
    LIVE_INSTALL_LOCATION="$(
      curl -I -sS "https://${INSTALL_DOMAIN}/install.sh" \
        | awk 'tolower($1) == "location:" {print $2; exit}' \
        | tr -d '\r'
    )"
    if [[ -n "${LIVE_INSTALL_LOCATION}" && "${LIVE_INSTALL_LOCATION}" != "${INSTALL_TARGET_URL}" ]]; then
      echo "[setup-cloudflare-release] WARNING: install.sh currently redirects to ${LIVE_INSTALL_LOCATION}" >&2
      echo "[setup-cloudflare-release] WARNING: an existing zone redirect/rule may override worker routes" >&2
    fi

    LIVE_CLEANUP_LOCATION="$(
      curl -I -sS "https://${INSTALL_DOMAIN}/cleanup.sh" \
        | awk 'tolower($1) == "location:" {print $2; exit}' \
        | tr -d '\r'
    )"
    if [[ -n "${LIVE_CLEANUP_LOCATION}" && "${LIVE_CLEANUP_LOCATION}" != "${CLEANUP_TARGET_URL}" ]]; then
      echo "[setup-cloudflare-release] WARNING: cleanup.sh currently redirects to ${LIVE_CLEANUP_LOCATION}" >&2
      echo "[setup-cloudflare-release] WARNING: an existing zone redirect/rule may override worker routes" >&2
    fi
  fi
fi

echo "[setup-cloudflare-release] done"
echo "[setup-cloudflare-release] release domain: https://${RELEASE_DOMAIN}/${RELEASE_PREFIX}/"
echo "[setup-cloudflare-release] installer URL: https://${INSTALL_DOMAIN}/install.sh"
echo "[setup-cloudflare-release] cleanup URL: https://${INSTALL_DOMAIN}/cleanup.sh"
