#!/usr/bin/env bash
# Build versioned multi-arch gateway release artifacts.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/build-release.sh <version>

Example:
  ./scripts/build-release.sh v0.1.1

Environment:
  TARGETS="linux/amd64 linux/arm64 darwin/arm64"  # optional override
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PKG_DIR}/dist/${VERSION}"

if [[ "${VERSION}" != v* ]]; then
  echo "[build-release] WARN: version '${VERSION}' does not start with 'v'" >&2
fi

TARGETS_STR="${TARGETS:-linux/amd64 linux/arm64 darwin/arm64}"
read -r -a TARGETS <<<"${TARGETS_STR}"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  echo "[build-release] ERROR: sha256sum or shasum is required" >&2
  exit 1
}

cd "${PKG_DIR}"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

for target in "${TARGETS[@]}"; do
  goos="${target%/*}"
  goarch="${target#*/}"
  out="${DIST_DIR}/chatcode-gateway-${goos}-${goarch}"

  echo "[build-release] building ${goos}/${goarch} -> ${out}"
  CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
    go build -ldflags "-X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -s -w" \
    -o "${out}" ./cmd/gateway

  hash="$(hash_file "${out}")"
  printf '%s\n' "${hash}" > "${out}.sha256"
done

: > "${DIST_DIR}/checksums.txt"
for file in "${DIST_DIR}"/chatcode-gateway-*; do
  [[ -f "${file}" ]] || continue
  [[ "${file}" == *.sha256 ]] && continue
  hash="$(hash_file "${file}")"
  printf '%s  %s\n' "${hash}" "$(basename "${file}")" >> "${DIST_DIR}/checksums.txt"
done

cp deploy/gateway-install.sh "${DIST_DIR}/gateway-install.sh"
cp deploy/gateway-cleanup.sh "${DIST_DIR}/gateway-cleanup.sh"
cp deploy/cloud-init.sh "${DIST_DIR}/cloud-init.sh"
cp deploy/chatcode-gateway.service "${DIST_DIR}/chatcode-gateway.service"
chmod +x "${DIST_DIR}/gateway-install.sh" "${DIST_DIR}/gateway-cleanup.sh" "${DIST_DIR}/cloud-init.sh"
printf '%s\n' "${VERSION}" > "${DIST_DIR}/latest.txt"

cat > "${DIST_DIR}/manifest.json" <<JSON
{
  "version": "${VERSION}",
  "targets": [
    $(printf '"%s",' "${TARGETS[@]}" | sed 's/,$//')
  ],
  "files": [
    "gateway-install.sh",
    "gateway-cleanup.sh",
    "cloud-init.sh",
    "chatcode-gateway.service",
    "checksums.txt"
  ]
}
JSON

echo "[build-release] done: ${DIST_DIR}"
ls -1 "${DIST_DIR}"
