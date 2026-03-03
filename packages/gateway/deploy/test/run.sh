#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/gateway-install.test.sh"
"${SCRIPT_DIR}/gateway-cleanup.test.sh"

echo "[gateway-deploy.test] PASS"
