#!/usr/bin/env bash
# Publish a built gateway release bundle to Cloudflare R2.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/publish-release-r2.sh <version> <bucket>

Example:
  ./scripts/publish-release-r2.sh v0.1.1 chatcode-releases

Environment:
  RELEASE_PREFIX   Object key prefix (default: gateway)
USAGE
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

VERSION="$1"
BUCKET="$2"
RELEASE_PREFIX="${RELEASE_PREFIX:-gateway}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PKG_DIR}/dist/${VERSION}"

[[ -d "${DIST_DIR}" ]] || {
  echo "[publish-release-r2] missing bundle: ${DIST_DIR}" >&2
  echo "[publish-release-r2] build first: ./scripts/build-release.sh ${VERSION}" >&2
  exit 1
}

command -v wrangler >/dev/null 2>&1 || {
  echo "[publish-release-r2] wrangler is required in PATH" >&2
  exit 1
}

for file in "${DIST_DIR}"/*; do
  [[ -f "${file}" ]] || continue
  key="${RELEASE_PREFIX}/${VERSION}/$(basename "${file}")"
  echo "[publish-release-r2] put ${BUCKET}/${key}"
  wrangler r2 object put "${BUCKET}/${key}" --file "${file}" --remote
done

TMP_LATEST="$(mktemp)"
printf '%s\n' "${VERSION}" > "${TMP_LATEST}"
wrangler r2 object put "${BUCKET}/${RELEASE_PREFIX}/latest.txt" --file "${TMP_LATEST}" --remote
rm -f "${TMP_LATEST}"

for name in install.sh manual-install.sh gateway-cleanup.sh cloud-init.sh checksums.txt manifest.json; do
  src="${DIST_DIR}/${name}"
  [[ -f "${src}" ]] || continue
  wrangler r2 object put "${BUCKET}/${RELEASE_PREFIX}/latest/${name}" --file "${src}" --remote
done

echo "[publish-release-r2] done"
