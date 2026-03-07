# Self-Host in Your Cloudflare Account

This guide makes Chatcode run under your Cloudflare account and your domains.

Recommended domain split:

- control-plane API: `cp.<your-domain>`
- frontend app: `app.<your-domain>`
- release files: `releases.<your-domain>`
- install entrypoints: `<your-domain>/install.sh` and `<your-domain>/cleanup.sh`

## 1. Prerequisites

- Cloudflare account + zone
- Node 24 + pnpm + corepack
- Wrangler authenticated (`wrangler whoami`)
- OAuth apps prepared (DigitalOcean required, Google/GitHub optional)

## 2. Create Cloudflare Resources

From `packages/control-plane`:

```bash
# D1
wrangler d1 create chatcode-selfhost

# KV (prod + preview)
wrangler kv namespace create KV --env selfhost
wrangler kv namespace create KV --preview --env selfhost
```

Copy generated IDs.

## 3. Configure `wrangler.toml`

Add a new environment (example):

```toml
[env.selfhost]
name = "chatcode-cp-selfhost"
workers_dev = true
routes = [{ pattern = "cp.example.com/*", zone_name = "example.com" }]

[[env.selfhost.durable_objects.bindings]]
name = "GATEWAY_HUB"
class_name = "GatewayHub"

[[env.selfhost.migrations]]
tag = "v1"
new_classes = ["GatewayHub"]

[[env.selfhost.d1_databases]]
binding = "DB"
database_name = "chatcode-selfhost"
database_id = "<D1_DATABASE_ID>"

[[env.selfhost.kv_namespaces]]
binding = "KV"
id = "<KV_NAMESPACE_ID>"

[env.selfhost.vars]
DO_CLIENT_ID = "<digitalocean-oauth-client-id>"
APP_ENV = "prod"
AUTH_MODE = ""
DEFAULT_DROPLET_REGION = "nyc1"
DEFAULT_DROPLET_SIZE = "s-1vcpu-512mb-10gb"
DEFAULT_DROPLET_IMAGE = "ubuntu-24-04-x64"
GATEWAY_VERSION = "v0.0.2"
GATEWAY_RELEASE_BASE_URL = "https://releases.example.com/gateway"
```

## 4. Set Secrets with Wrangler

```bash
wrangler secret put DO_CLIENT_SECRET --env selfhost
wrangler secret put JWT_SECRET --env selfhost
wrangler secret put GATEWAY_TOKEN_SALT --env selfhost
wrangler secret put DO_TOKEN_KEK --env selfhost

# Optional providers
wrangler secret put GOOGLE_CLIENT_SECRET --env selfhost
wrangler secret put GITHUB_CLIENT_SECRET --env selfhost

# Optional magic-link mail
wrangler secret put SES_ACCESS_KEY_ID --env selfhost
wrangler secret put SES_SECRET_ACCESS_KEY --env selfhost
wrangler secret put SES_REGION --env selfhost
wrangler secret put SES_FROM_ADDRESS --env selfhost
```

## 5. Deploy Control Plane

```bash
# apply schema
wrangler d1 execute chatcode-selfhost --remote --file=src/db/migrations/0001_initial.sql

# deploy worker
wrangler deploy --env selfhost
```

## 6. OAuth Redirect URLs

Use your control-plane domain in all providers:

- DigitalOcean: `https://cp.example.com/auth/do/callback`
- Google: `https://cp.example.com/auth/google/callback`
- GitHub: `https://cp.example.com/auth/github/callback`

## 7. Set Up Release Distribution + Installer URLs

From `packages/gateway`:

```bash
./scripts/setup-cloudflare-release.sh \
  --bucket chatcode-releases \
  --release-domain releases.example.com \
  --install-domain example.com \
  --zone-id <CLOUDFLARE_ZONE_ID>
```

This configures:

- R2-backed release domain (`releases.example.com`)
- Redirect worker routes:
  - `https://example.com/install.sh`
  - `https://example.com/cleanup.sh`

## 8. Optional: Automate Release Upload from GitHub Actions

Set repo secrets:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_RELEASE_BUCKET`

Then push a tag (`vX.Y.Z`) to trigger `.github/workflows/gateway-release.yml`.

For self-hosted control-plane domains, prefer `.github/workflows/gateway-selfhost-release.yml`:
- input `release_tag` (example: `v0.2.0-selfhost.1`)
- input `cp_domain` (example: `cp.example.com`)
- optional `publish_r2=true`

This workflow bakes `wss://<cp_domain>/gw/connect` into the gateway binary.
Runtime `--cp-url` must match that baked URL (or managed prod/staging URLs).

## 9. Quick Verification

```bash
curl -I https://example.com/install.sh
curl -I https://example.com/cleanup.sh
curl -i https://cp.example.com/vps
```

In production auth mode, `/vps` should return `401 unauthorized` without a session.

## 10. Frontend App Hosting

Use Cloudflare Pages for the app surface and keep API on `cp.*`.

Reference:
- [`docs/FRONTEND_PAGES.md`](./FRONTEND_PAGES.md)
