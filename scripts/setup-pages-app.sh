#!/usr/bin/env bash
# Create/update Cloudflare Pages projects for Chatcode app UI.
#
# This script prepares:
# - production project (app.chatcode.dev)
# - staging/preview project (app.staging.chatcode.dev + branch previews on *.pages.dev)
#
# Notes:
# - Wrangler can create projects, but custom-domain attach is done via Cloudflare API.
# - Branch previews are automatic on Pages when deploying with --branch.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/setup-pages-app.sh \
    --account-id <cloudflare-account-id> \
    --api-token <cloudflare-api-token> \
    --prod-project chatcode-app \
    --staging-project chatcode-app-staging \
    --prod-domain app.chatcode.dev \
    --staging-domain app.staging.chatcode.dev

Options:
  --account-id ID           Cloudflare account id (required)
  --api-token TOKEN         Cloudflare API token (required; Pages Edit + Zone Read/Edit)
  --prod-project NAME       Pages project name for production app (default: chatcode-app)
  --staging-project NAME    Pages project name for staging/preview app (default: chatcode-app-staging)
  --prod-branch NAME        Production branch for prod project (default: main)
  --staging-branch NAME     Production branch for staging project (default: staging)
  --prod-domain DOMAIN      Custom domain for prod project (default: app.chatcode.dev)
  --staging-domain DOMAIN   Custom domain for staging project (default: app.staging.chatcode.dev)
  -h, --help                Show this help
USAGE
}

ACCOUNT_ID=""
API_TOKEN=""
PROD_PROJECT="chatcode-app"
STAGING_PROJECT="chatcode-app-staging"
PROD_BRANCH="main"
STAGING_BRANCH="staging"
PROD_DOMAIN="app.chatcode.dev"
STAGING_DOMAIN="app.staging.chatcode.dev"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --api-token)
      API_TOKEN="${2:-}"
      shift 2
      ;;
    --prod-project)
      PROD_PROJECT="${2:-}"
      shift 2
      ;;
    --staging-project)
      STAGING_PROJECT="${2:-}"
      shift 2
      ;;
    --prod-branch)
      PROD_BRANCH="${2:-}"
      shift 2
      ;;
    --staging-branch)
      STAGING_BRANCH="${2:-}"
      shift 2
      ;;
    --prod-domain)
      PROD_DOMAIN="${2:-}"
      shift 2
      ;;
    --staging-domain)
      STAGING_DOMAIN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[setup-pages-app] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "${ACCOUNT_ID}" ]] || { echo "[setup-pages-app] --account-id is required" >&2; exit 1; }
[[ -n "${API_TOKEN}" ]] || { echo "[setup-pages-app] --api-token is required" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || { echo "[setup-pages-app] curl is required" >&2; exit 1; }
command -v corepack >/dev/null 2>&1 || { echo "[setup-pages-app] corepack is required" >&2; exit 1; }

CF_API_BASE="https://api.cloudflare.com/client/v4"

cf_api() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  if [[ -n "${payload}" ]]; then
    curl -fsS -X "${method}" \
      -H "Authorization: Bearer ${API_TOKEN}" \
      -H "Content-Type: application/json" \
      "${CF_API_BASE}${path}" \
      --data "${payload}"
    return
  fi
  curl -fsS -X "${method}" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${CF_API_BASE}${path}"
}

ensure_project() {
  local project="$1"
  local branch="$2"
  if corepack pnpm --filter @chatcode/control-plane exec wrangler pages project list | grep -qE "^${project}[[:space:]]"; then
    echo "[setup-pages-app] project exists: ${project}"
    return
  fi
  echo "[setup-pages-app] creating project: ${project} (production branch: ${branch})"
  corepack pnpm --filter @chatcode/control-plane exec wrangler pages project create "${project}" --production-branch "${branch}"
}

ensure_domain() {
  local project="$1"
  local domain="$2"
  local list
  list="$(cf_api GET "/accounts/${ACCOUNT_ID}/pages/projects/${project}/domains")"
  if echo "${list}" | grep -q "\"name\":\"${domain}\""; then
    echo "[setup-pages-app] domain exists: ${domain} -> ${project}"
    return
  fi
  echo "[setup-pages-app] attaching domain: ${domain} -> ${project}"
  cf_api POST "/accounts/${ACCOUNT_ID}/pages/projects/${project}/domains" "{\"name\":\"${domain}\"}" >/dev/null
}

echo "[setup-pages-app] verifying wrangler auth"
corepack pnpm --filter @chatcode/control-plane exec wrangler whoami >/dev/null

ensure_project "${PROD_PROJECT}" "${PROD_BRANCH}"
ensure_project "${STAGING_PROJECT}" "${STAGING_BRANCH}"

ensure_domain "${PROD_PROJECT}" "${PROD_DOMAIN}"
ensure_domain "${STAGING_PROJECT}" "${STAGING_DOMAIN}"

cat <<EOF
[setup-pages-app] done

Projects:
- prod:    ${PROD_PROJECT} (branch: ${PROD_BRANCH}, domain: ${PROD_DOMAIN})
- staging: ${STAGING_PROJECT} (branch: ${STAGING_BRANCH}, domain: ${STAGING_DOMAIN})

Next:
1. Set GitHub Actions secrets for Pages deploy (see docs/FRONTEND_PAGES.md).
2. Push web changes; non-main/staging branches deploy as previews to:
   https://<branch>.<staging-project>.pages.dev
EOF
