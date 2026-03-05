# Gateway Deploy Scripts

## `gateway-install.sh`

Installs gateway on Linux (systemd, dedicated `vibe` user) or macOS (launchd, current user):

```bash
# Option A: from local binary
sudo ./gateway-install.sh \
  --binary-source /path/to/chatcode-gateway \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# Option B: download from release host
sudo ./gateway-install.sh \
  --version v0.1.0 \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# macOS (do NOT use sudo)
./gateway-install.sh \
  --version v0.1.0 \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect
```

Automated script tests:
```bash
cd packages/gateway
make test-deploy
```
Coverage includes:
- darwin-mode install with local binary (`--no-start`)
- darwin-mode install with release download (`--version latest`)
- linux non-root guard behavior
- darwin-mode cleanup behavior with and without workspace removal

Linux mode:
- creates `vibe` user (if missing)
- prepares `~vibe/.ssh/authorized_keys` and `~/workspace`
- installs binary to `/usr/local/bin/chatcode-gateway`
- writes `/etc/chatcode/gateway.env`
- preinstalls default agent CLIs: `claude-code` and `codex`
- installs reusable helper scripts in `/usr/local/sbin`:
  - `chatcode-update-agent-clis`
  - `install-git.sh`, `install-claude-code.sh`, `install-codex.sh`, `install-gemini.sh`, `install-opencode.sh`
- configures sudo logging for `vibe` at `/var/log/chatcode/sudo-vibe.log`
- installs log rotation policy at `/etc/logrotate.d/chatcode-sudo-vibe`
- installs `chatcode-gateway.service` and starts it
- installs and enables `chatcode-maintenance.timer` (daily):
  - updates all installed agent CLIs (`--installed-only`)
  - updates gateway binary to latest release and restarts service

Sudo logging details (Linux):
- `vibe` has passwordless sudo for operational workflows
- every `sudo` command from `vibe` is logged to `/var/log/chatcode/sudo-vibe.log`
- log file is root-owned and read-only for `vibe` (`root:vibe`, mode `0640`)
- if supported, installer sets append-only flag (`chattr +a`) on the log file
- logrotate temporarily removes append-only, rotates, and restores append-only
- systemd filesystem sandboxing is intentionally relaxed so explicitly-approved
  `sudo` workflows behave like a normal shell session
- cloud-init bootstrap installs `logrotate`; manual installs should ensure `logrotate` is present

macOS mode:
- uses the current user (no `vibe` user creation)
- prepares `~/.ssh/authorized_keys` and `~/workspace`
- installs binary to `~/.local/bin/chatcode-gateway` by default
- writes `~/.config/chatcode/gateway.env`
- installs `~/Library/LaunchAgents/dev.chatcode.gateway.plist` and starts it
- installs `~/.local/bin/chatcode-update-agent-clis` and per-agent installer scripts
- installs `~/Library/LaunchAgents/dev.chatcode.maintenance.plist` (daily maintenance)

Legacy alias:
- `manual-install.sh` is now a wrapper to `gateway-install.sh`.

Release-download defaults:
- `--version latest`
- `--release-base-url https://releases.chatcode.dev/gateway`

## `gateway-cleanup.sh`

Removes gateway install artifacts. Destructive by default:

```bash
sudo ./gateway-cleanup.sh --yes
# macOS:
./gateway-cleanup.sh --yes
```

Linux cleanup (default) removes:
- `chatcode-gateway` systemd service
- `chatcode-maintenance` systemd service/timer and maintenance script
- `chatcode-update-agent-clis` and per-agent installer scripts from `/usr/local/sbin`
- `/usr/local/bin/chatcode-gateway`
- `/etc/chatcode`
- `/tmp/chatcode` and `/opt/chatcode`
- `vibe` sudoers entry
- `/etc/logrotate.d/chatcode-sudo-vibe`
- `/var/log/chatcode/sudo-vibe.log`
- `vibe` user and home directory

macOS cleanup removes:
- `dev.chatcode.gateway` launchd agent
- `dev.chatcode.maintenance` launchd agent
- `~/.local/bin/chatcode-gateway`
- `~/.local/bin/chatcode-maintenance`
- `~/.local/bin/chatcode-update-agent-clis` + installer scripts
- `~/.config/chatcode`
- `/tmp/chatcode`
- keeps `~/workspace` by default

Optional flags:
- `--keep-user` keep `vibe` user/home
- `--keep-workspace` keep `~/workspace` (requires `--keep-user`)
- `--remove-workspace` (macOS) remove `~/workspace`

## Agent CLIs

Gateway supports installing these CLIs:
- `claude-code`
- `codex`
- `gemini`
- `opencode`

Node.js baseline for installer scripts is Node 24 (LTS on current timeline).

Default behavior:
- new installs preinstall `claude-code` + `codex`
- periodic automated updates target all installed agent CLIs + gateway binary
- automation uses the same installer scripts for both preinstall and updates
- `update-agent-clis.sh` ensures `git` is installed first (`install-git.sh`)

Update all installed CLIs to latest:
```bash
cd packages/gateway
./scripts/update-agent-clis.sh --installed-only
```

Update specific CLIs:
```bash
./scripts/update-agent-clis.sh codex opencode
```

## Release build/publish

```bash
# Build local release bundle
cd packages/gateway
./scripts/build-release.sh v0.1.1

# Publish to R2 (requires R2 S3 access key/secret in env)
export R2_ACCOUNT_ID="<cloudflare-account-id>"
export R2_ACCESS_KEY_ID="<r2-access-key-id>"
export R2_SECRET_ACCESS_KEY="<r2-secret-access-key>"
./scripts/publish-release-r2.sh v0.1.1 chatcode-releases
```

Recommended release URLs:
- versioned: `https://releases.chatcode.dev/gateway/v0.1.1/...`
- mutable latest pointer: `https://releases.chatcode.dev/gateway/latest/...`
- main-domain installer redirect: `https://chatcode.dev/install.sh` -> `https://releases.chatcode.dev/gateway/latest/gateway-install.sh`
- main-domain cleanup redirect: `https://chatcode.dev/cleanup.sh` -> `https://releases.chatcode.dev/gateway/latest/gateway-cleanup.sh`

Cloudflare setup suggestion:
1. Serve release files from an R2 bucket bound to `releases.chatcode.dev`.
2. Use `setup-cloudflare-release.sh` to deploy worker routes for both installer and cleanup redirects.

Wrangler setup example:
```bash
# Create bucket
wrangler r2 bucket create chatcode-releases

# Connect custom domain
wrangler r2 bucket domain add chatcode-releases \
  --domain releases.chatcode.dev \
  --zone-id <chatcode.dev-zone-id> \
  --min-tls 1.2
```

Fully scripted setup (R2 + custom domain + installer redirect worker route):
```bash
cd packages/gateway
./scripts/setup-cloudflare-release.sh \
  --bucket chatcode-releases \
  --release-domain releases.chatcode.dev \
  --install-domain chatcode.dev \
  --zone-id <chatcode.dev-zone-id>
```

The script deploys dedicated worker routes:
- `chatcode.dev/install.sh*` -> `https://releases.chatcode.dev/gateway/latest/gateway-install.sh`
- `chatcode.dev/cleanup.sh*` -> `https://releases.chatcode.dev/gateway/latest/gateway-cleanup.sh`
- If either URL still resolves elsewhere, remove/adjust older zone redirect rules (they can override worker routes).

## GitHub Actions secrets

Workflow `.github/workflows/gateway-release.yml` expects:
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_RELEASE_BUCKET`

Upload credentials should come from an R2 API token/access key pair scoped to the release bucket.

With GitHub CLI (after `gh auth login`):
```bash
gh secret set R2_ACCOUNT_ID --body "<cloudflare-account-id>" --repo tractorfm/chatcode
gh secret set R2_ACCESS_KEY_ID --body "<r2-access-key-id>" --repo tractorfm/chatcode
gh secret set R2_SECRET_ACCESS_KEY --body "<r2-secret-access-key>" --repo tractorfm/chatcode
gh secret set R2_RELEASE_BUCKET --body "chatcode-releases" --repo tractorfm/chatcode
```
