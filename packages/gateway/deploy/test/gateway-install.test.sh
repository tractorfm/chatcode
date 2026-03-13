#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_SCRIPT="${REPO_ROOT}/packages/gateway/deploy/gateway-install.sh"
SERVICE_TEMPLATE="${REPO_ROOT}/packages/gateway/deploy/chatcode-gateway.service"
CLAUDE_INSTALLER="${REPO_ROOT}/packages/gateway/scripts/install-claude-code.sh"
CODEX_INSTALLER="${REPO_ROOT}/packages/gateway/scripts/install-codex.sh"
OPENCODE_INSTALLER="${REPO_ROOT}/packages/gateway/scripts/install-opencode.sh"
GEMINI_INSTALLER="${REPO_ROOT}/packages/gateway/scripts/install-gemini.sh"

fail() {
  echo "[gateway-install.test] FAIL: $*" >&2
  exit 1
}

assert_file_exists() {
  local path="$1"
  [[ -f "${path}" ]] || fail "expected file to exist: ${path}"
}

assert_dir_exists() {
  local path="$1"
  [[ -d "${path}" ]] || fail "expected dir to exist: ${path}"
}

assert_contains() {
  local path="$1"
  local pattern="$2"
  grep -Fq "${pattern}" "${path}" || fail "expected '${pattern}' in ${path}"
}

setup_darwin_stubs() {
  local stub_dir="$1"

  cat > "${stub_dir}/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then
  echo "Darwin"
  exit 0
fi
if [[ "${1:-}" == "-m" ]]; then
  echo "arm64"
  exit 0
fi
echo "Darwin"
EOF

  cat > "${stub_dir}/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "${stub_dir}/tmux" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "${stub_dir}/uname" "${stub_dir}/launchctl" "${stub_dir}/tmux"
}

test_darwin_binary_source_no_start() {
  local tmp
  tmp="$(mktemp -d)"

  local stub_dir="${tmp}/stubs"
  local home_dir="${tmp}/home"
  local chatcode_tmp_dir="${tmp}/chatcode-tmp"
  local src_bin="${tmp}/chatcode-gateway-src"
  mkdir -p "${stub_dir}" "${home_dir}"
  setup_darwin_stubs "${stub_dir}"

  cat > "${src_bin}" <<'EOF'
#!/usr/bin/env bash
echo "gateway test binary"
EOF
  chmod +x "${src_bin}"

  env \
    HOME="${home_dir}" \
    PATH="${stub_dir}:${PATH}" \
    CHATCODE_TMP_DIR="${chatcode_tmp_dir}" \
    "${INSTALL_SCRIPT}" \
      --binary-source "${src_bin}" \
      --gateway-id "gw-test-binary-source" \
      --gateway-auth-token "tok-test-binary-source" \
      --cp-url "wss://cp.staging.chatcode.dev/gw/connect" \
      --skip-agent-preinstall \
      --no-start

  local installed_bin="${home_dir}/.local/bin/chatcode-gateway"
  local env_file="${home_dir}/.config/chatcode/gateway.env"
  local plist_file="${home_dir}/Library/LaunchAgents/dev.chatcode.gateway.plist"

  assert_file_exists "${installed_bin}"
  assert_file_exists "${env_file}"
  assert_file_exists "${plist_file}"
  assert_dir_exists "${chatcode_tmp_dir}"

  cmp -s "${src_bin}" "${installed_bin}" || fail "installed binary differs from source"
  assert_contains "${env_file}" "GATEWAY_ID=gw-test-binary-source"
  assert_contains "${env_file}" "TMUX_TMPDIR=${chatcode_tmp_dir}"
  rm -rf "${tmp}"
}

test_darwin_release_download_latest() {
  local tmp
  tmp="$(mktemp -d)"

  local stub_dir="${tmp}/stubs"
  local home_dir="${tmp}/home"
  local chatcode_tmp_dir="${tmp}/chatcode-tmp"
  mkdir -p "${stub_dir}" "${home_dir}"
  setup_darwin_stubs "${stub_dir}"

  cat > "${stub_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

out_file=""
url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

[[ -n "${url}" ]] || { echo "missing url" >&2; exit 1; }

if [[ "${url}" == *"/latest.txt" ]]; then
  if [[ -n "${out_file}" ]]; then
    printf 'v9.9.9-test\n' > "${out_file}"
  else
    printf 'v9.9.9-test\n'
  fi
  exit 0
fi

if [[ "${url}" == *"/chatcode-gateway-darwin-arm64" ]]; then
  if [[ -n "${out_file}" ]]; then
    printf '#!/usr/bin/env bash\necho release-binary\n' > "${out_file}"
  else
    printf '#!/usr/bin/env bash\necho release-binary\n'
  fi
  exit 0
fi

if [[ "${url}" == *"/chatcode-gateway-darwin-arm64.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    sha="$(printf '#!/usr/bin/env bash\necho release-binary\n' | sha256sum | awk '{print $1}')"
  else
    sha="$(printf '#!/usr/bin/env bash\necho release-binary\n' | shasum -a 256 | awk '{print $1}')"
  fi
  if [[ -n "${out_file}" ]]; then
    printf '%s\n' "${sha}" > "${out_file}"
  else
    printf '%s\n' "${sha}"
  fi
  exit 0
fi

echo "unexpected url: ${url}" >&2
exit 1
EOF
  chmod +x "${stub_dir}/curl"

  env \
    HOME="${home_dir}" \
    PATH="${stub_dir}:${PATH}" \
    CHATCODE_TMP_DIR="${chatcode_tmp_dir}" \
    "${INSTALL_SCRIPT}" \
      --version latest \
      --release-base-url "https://releases.example.test/gateway" \
      --gateway-id "gw-test-download" \
      --gateway-auth-token "tok-test-download" \
      --cp-url "wss://cp.staging.chatcode.dev/gw/connect" \
      --skip-agent-preinstall \
      --no-start

  local installed_bin="${home_dir}/.local/bin/chatcode-gateway"
  local env_file="${home_dir}/.config/chatcode/gateway.env"

  assert_file_exists "${installed_bin}"
  assert_file_exists "${env_file}"
  assert_contains "${env_file}" "GATEWAY_VERSION=v9.9.9-test"
  assert_contains "${env_file}" "TMUX_TMPDIR=${chatcode_tmp_dir}"

  grep -Fq "release-binary" "${installed_bin}" || fail "downloaded binary content mismatch"
  rm -rf "${tmp}"
}

test_linux_requires_root() {
  local tmp
  tmp="$(mktemp -d)"

  local src_bin="${tmp}/chatcode-gateway-src"
  cat > "${src_bin}" <<'EOF'
#!/usr/bin/env bash
echo "gateway test binary"
EOF
  chmod +x "${src_bin}"

  set +e
  output="$(
    "${INSTALL_SCRIPT}" \
      --binary-source "${src_bin}" \
      --gateway-id "gw-test-linux" \
      --gateway-auth-token "tok-test-linux" \
      --cp-url "wss://cp.staging.chatcode.dev/gw/connect" \
      2>&1
  )"
  status=$?
  set -e

  [[ ${status} -ne 0 ]] || fail "expected non-zero exit for non-root Linux install"
  [[ "${output}" == *"linux install must run as root"* ]] || fail "unexpected error output: ${output}"
  rm -rf "${tmp}"
}

test_service_template_preserves_tmux_children() {
  assert_contains "${SERVICE_TEMPLATE}" "KillMode=process"
}

test_linux_installer_service_unit_preserves_tmux_children() {
  assert_contains "${INSTALL_SCRIPT}" "KillMode=process"
  assert_contains "${INSTALL_SCRIPT}" "PrivateTmp=false"
  if grep -Fq "ExecStartPre=/usr/bin/install -d -m 700 -o \${TARGET_USER} -g \${TARGET_USER} /tmp/chatcode" "${INSTALL_SCRIPT}"; then
    fail "installer still embeds ExecStartPre tmp dir setup in service unit"
  fi
}

test_linux_installer_bootstraps_base_packages() {
  assert_contains "${INSTALL_SCRIPT}" "ensure_linux_base_packages"
  assert_contains "${INSTALL_SCRIPT}" "missing+=(\"tmux\")"
  assert_contains "${INSTALL_SCRIPT}" "apt-get install -y -q"
  assert_contains "${INSTALL_SCRIPT}" 'TMPDIR="${TMPDIR:-/var/tmp}"'
  assert_contains "${INSTALL_SCRIPT}" 'TMPDIR=${TMPDIR}'
  assert_contains "${INSTALL_SCRIPT}" 'warn_small_tmpfs_tmp'
}

test_installer_uses_user_local_agent_cli_updates() {
  assert_contains "${INSTALL_SCRIPT}" 'sudo -u "${TARGET_USER}" -H env HOME="${TARGET_HOME}" PATH="${path_value}" "${AGENT_UPDATE_HELPER_PATH}" "$@"'
  assert_contains "${INSTALL_SCRIPT}" 'TARGET_PATH="__CHATCODE_RUNTIME_PATH__"'
  assert_contains "${INSTALL_SCRIPT}" 'sudo -u "$TARGET_USER" -H env HOME="$TARGET_HOME" PATH="$TARGET_PATH" \'
}

test_installer_sets_local_bin_path() {
  assert_contains "${INSTALL_SCRIPT}" 'PATH=$(runtime_path_value)'
  assert_contains "${INSTALL_SCRIPT}" 'export PATH="$HOME/.local/bin:$PATH"'
  assert_contains "${INSTALL_SCRIPT}" '$(xml_escape "$(runtime_path_value)")'
  assert_contains "${INSTALL_SCRIPT}" '/opt/homebrew/bin'
}

test_agent_installers_seed_global_guidance_without_overwrite() {
  assert_contains "${CLAUDE_INSTALLER}" 'CLAUDE_GUIDANCE_FILE="${CLAUDE_DIR}/CLAUDE.md"'
  assert_contains "${CLAUDE_INSTALLER}" 'Claude global guidance already exists'
  assert_contains "${CODEX_INSTALLER}" 'CODEX_GUIDANCE_FILE="${CODEX_HOME_DIR}/AGENTS.md"'
  assert_contains "${CODEX_INSTALLER}" 'Codex global guidance already exists'
  assert_contains "${GEMINI_INSTALLER}" 'GEMINI_GUIDANCE_FILE="${GEMINI_DIR}/GEMINI.md"'
  assert_contains "${GEMINI_INSTALLER}" 'Gemini global guidance already exists'
  assert_contains "${OPENCODE_INSTALLER}" 'OPENCODE_GUIDANCE_FILE="${OPENCODE_CONFIG_DIR}/AGENTS.md"'
  assert_contains "${OPENCODE_INSTALLER}" 'OpenCode global guidance already exists'
}

main() {
  test_darwin_binary_source_no_start
  test_darwin_release_download_latest
  test_linux_requires_root
  test_linux_installer_bootstraps_base_packages
  test_installer_uses_user_local_agent_cli_updates
  test_installer_sets_local_bin_path
  test_agent_installers_seed_global_guidance_without_overwrite
  test_service_template_preserves_tmux_children
  test_linux_installer_service_unit_preserves_tmux_children
  echo "[gateway-install.test] PASS"
}

main "$@"
