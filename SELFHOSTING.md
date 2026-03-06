# Self-Hosted Control Plane Builds

This repo supports self-hosted gateway releases that are pinned to your control-plane domain at build time.

## Why this exists

- We keep managed builds strict (`cp.chatcode.dev` / `cp.staging.chatcode.dev`) to reduce SSRF risk.
- Self-host builds stay secure by baking your CP URL into the binary, instead of accepting arbitrary runtime targets.

## Build a self-host release

Use GitHub Actions workflow:
- `.github/workflows/gateway-selfhost-release.yml`

Required inputs:
- `release_tag` (example: `v0.2.0-selfhost.1`)
- `cp_domain` (example: `cp.example.com`)

Optional:
- `publish_r2=true` to upload bundle to R2.
- `release_prefix` to override default R2 prefix (`gateway-selfhost/<cp_domain>`).

The workflow bakes this URL into binaries:
- `wss://<cp_domain>/gw/connect`

## Install self-host build

Use matching CP URL at install time:

```bash
./gateway-install.sh \
  --version v0.2.0-selfhost.1 \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.example.com/gw/connect
```

If `--cp-url` does not match the baked self-host URL (or managed URLs), gateway startup fails config validation.

## Local build (without GitHub Actions)

```bash
cd packages/gateway
GATEWAY_SELFHOST_CP_URL="wss://cp.example.com/gw/connect" \
  ./scripts/build-release.sh v0.2.0-selfhost.1
```
