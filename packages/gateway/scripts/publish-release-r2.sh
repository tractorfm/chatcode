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
  RELEASE_PREFIX         Object key prefix (default: gateway)
  R2_ACCOUNT_ID          Cloudflare account id for R2 S3 endpoint
  R2_ACCESS_KEY_ID       R2 access key id
  R2_SECRET_ACCESS_KEY   R2 secret access key
  R2_ENDPOINT            Optional custom endpoint (default: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com)
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

command -v aws >/dev/null 2>&1 || {
  echo "[publish-release-r2] aws CLI is required in PATH" >&2
  exit 1
}

R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
R2_ENDPOINT="${R2_ENDPOINT:-}"

if [[ -z "${R2_ENDPOINT}" ]]; then
  if [[ -z "${R2_ACCOUNT_ID}" ]]; then
    echo "[publish-release-r2] set R2_ACCOUNT_ID (or R2_ENDPOINT)" >&2
    exit 1
  fi
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi

if [[ -z "${R2_ACCESS_KEY_ID}" || -z "${R2_SECRET_ACCESS_KEY}" ]]; then
  echo "[publish-release-r2] set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"

put_object() {
  local src_file="$1"
  local key="$2"
  echo "[publish-release-r2] put ${BUCKET}/${key}"
  aws --endpoint-url "${R2_ENDPOINT}" s3 cp "${src_file}" "s3://${BUCKET}/${key}" --only-show-errors
}

for file in "${DIST_DIR}"/*; do
  [[ -f "${file}" ]] || continue
  key="${RELEASE_PREFIX}/${VERSION}/$(basename "${file}")"
  put_object "${file}" "${key}"
done

TMP_LATEST="$(mktemp)"
printf '%s\n' "${VERSION}" > "${TMP_LATEST}"
put_object "${TMP_LATEST}" "${RELEASE_PREFIX}/latest.txt"
rm -f "${TMP_LATEST}"

for name in gateway-install.sh gateway-cleanup.sh cloud-init.sh chatcode-gateway.service checksums.txt manifest.json; do
  src="${DIST_DIR}/${name}"
  [[ -f "${src}" ]] || continue
  put_object "${src}" "${RELEASE_PREFIX}/latest/${name}"
done

echo "[publish-release-r2] done"
