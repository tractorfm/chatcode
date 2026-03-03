#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CLEANUP_SCRIPT="${REPO_ROOT}/packages/gateway/deploy/gateway-cleanup.sh"

fail() {
  echo "[gateway-cleanup.test] FAIL: $*" >&2
  exit 1
}

assert_exists() {
  local path="$1"
  [[ -e "${path}" ]] || fail "expected path to exist: ${path}"
}

assert_not_exists() {
  local path="$1"
  [[ ! -e "${path}" ]] || fail "expected path to be removed: ${path}"
}

setup_darwin_stubs() {
  local stub_dir="$1"

  cat > "${stub_dir}/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then
  echo "Darwin"
  exit 0
fi
echo "Darwin"
EOF

  cat > "${stub_dir}/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "${stub_dir}/pkill" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "${stub_dir}/uname" "${stub_dir}/launchctl" "${stub_dir}/pkill"
}

create_darwin_layout() {
  local home_dir="$1"
  mkdir -p "${home_dir}/Library/LaunchAgents"
  mkdir -p "${home_dir}/.config/chatcode"
  mkdir -p "${home_dir}/.local/bin"
  mkdir -p "${home_dir}/workspace"

  cat > "${home_dir}/Library/LaunchAgents/dev.chatcode.gateway.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict></dict></plist>
EOF

  cat > "${home_dir}/.config/chatcode/gateway.env" <<'EOF'
GATEWAY_ID=gw-test
EOF

  cat > "${home_dir}/.local/bin/chatcode-gateway" <<'EOF'
#!/usr/bin/env bash
echo gateway
EOF
  chmod +x "${home_dir}/.local/bin/chatcode-gateway"
}

test_darwin_cleanup_keeps_workspace_by_default() {
  local tmp
  tmp="$(mktemp -d)"

  local stub_dir="${tmp}/stubs"
  local home_dir="${tmp}/home"
  mkdir -p "${stub_dir}" "${home_dir}"
  setup_darwin_stubs "${stub_dir}"
  create_darwin_layout "${home_dir}"
  mkdir -p /tmp/chatcode

  env HOME="${home_dir}" PATH="${stub_dir}:${PATH}" "${CLEANUP_SCRIPT}" --yes

  assert_not_exists "${home_dir}/Library/LaunchAgents/dev.chatcode.gateway.plist"
  assert_not_exists "${home_dir}/.config/chatcode"
  assert_not_exists "${home_dir}/.local/bin/chatcode-gateway"
  assert_exists "${home_dir}/workspace"
  rm -rf "${tmp}"
}

test_darwin_cleanup_remove_workspace() {
  local tmp
  tmp="$(mktemp -d)"

  local stub_dir="${tmp}/stubs"
  local home_dir="${tmp}/home"
  mkdir -p "${stub_dir}" "${home_dir}"
  setup_darwin_stubs "${stub_dir}"
  create_darwin_layout "${home_dir}"
  mkdir -p /tmp/chatcode

  env HOME="${home_dir}" PATH="${stub_dir}:${PATH}" "${CLEANUP_SCRIPT}" --yes --remove-workspace

  assert_not_exists "${home_dir}/workspace"
  assert_not_exists "${home_dir}/Library/LaunchAgents/dev.chatcode.gateway.plist"
  assert_not_exists "${home_dir}/.config/chatcode"
  assert_not_exists "${home_dir}/.local/bin/chatcode-gateway"
  rm -rf "${tmp}"
}

main() {
  test_darwin_cleanup_keeps_workspace_by_default
  test_darwin_cleanup_remove_workspace
  echo "[gateway-cleanup.test] PASS"
}

main "$@"
