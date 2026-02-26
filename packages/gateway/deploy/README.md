# Gateway Deploy Scripts

## `manual-install.sh`

Installs gateway on an existing Linux host (systemd):

```bash
# Option A: from local binary
sudo ./manual-install.sh \
  --binary-source /path/to/chatcode-gateway \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# Option B: download from release host
sudo ./manual-install.sh \
  --version v0.1.0 \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect
```

What it does:
- creates `vibe` user (if missing)
- prepares `~vibe/.ssh/authorized_keys` and `~/workspace`
- installs binary to `/usr/local/bin/chatcode-gateway`
- writes `/etc/chatcode/gateway.env`
- installs `chatcode-gateway.service` and starts it

Release-download defaults:
- `--version latest`
- `--release-base-url https://releases.chatcode.dev/gateway`

## `gateway-cleanup.sh`

Removes gateway install artifacts. Destructive by default:

```bash
sudo ./gateway-cleanup.sh --yes
```

By default it removes:
- `chatcode-gateway` systemd service
- `/usr/local/bin/chatcode-gateway`
- `/etc/chatcode`
- `/tmp/chatcode` and `/opt/chatcode`
- `vibe` sudoers entry
- `vibe` user and home directory

Optional safety flags:
- `--keep-user` keep `vibe` user/home
- `--keep-workspace` keep `~/workspace` (requires `--keep-user`)

## Release build/publish

```bash
# Build local release bundle
cd packages/gateway
./scripts/build-release.sh v0.1.1

# Publish to R2 (requires wrangler auth and bucket)
./scripts/publish-release-r2.sh v0.1.1 chatcode-releases
```

Recommended release URLs:
- versioned: `https://releases.chatcode.dev/gateway/v0.1.1/...`
- mutable latest pointer: `https://releases.chatcode.dev/gateway/latest/...`
- main-domain installer redirect: `https://chatcode.dev/install.sh` -> `https://releases.chatcode.dev/gateway/latest/install.sh`

Cloudflare setup suggestion:
1. Serve release files from an R2 bucket bound to `releases.chatcode.dev`.
2. Create a redirect rule on `chatcode.dev`:
  - if `http.request.uri.path == "/install.sh"`
  - redirect (302/307) to `https://releases.chatcode.dev/gateway/latest/install.sh`

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

The script deploys a dedicated worker route `chatcode.dev/install.sh*` that redirects to:
- `https://releases.chatcode.dev/gateway/latest/install.sh`
- If `chatcode.dev/install.sh` still resolves elsewhere, remove/adjust older zone redirect rules (they can override worker routes).

## GitHub Actions secrets

Workflow `.github/workflows/gateway-release.yml` expects:
- `CF_ACCOUNT_ID`
- `CF_API_TOKEN_R2_RELEASES`
- `R2_RELEASE_BUCKET`

`CF_API_TOKEN_R2_RELEASES` should have (account-scoped) R2 write access:
- Account > Cloudflare R2 > Edit
- Account > Account Settings > Read (recommended for tooling compatibility)

With GitHub CLI (after `gh auth login`):
```bash
gh secret set CF_ACCOUNT_ID --body "<cloudflare-account-id>" --repo tractorfm/chatcode
gh secret set CF_API_TOKEN_R2_RELEASES --body "<cloudflare-api-token>" --repo tractorfm/chatcode
gh secret set R2_RELEASE_BUCKET --body "chatcode-releases" --repo tractorfm/chatcode
```
