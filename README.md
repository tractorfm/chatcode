# Chatcode

Provision a VPS, connect a gateway, and use AI agents in a browser terminal.

- Website: [chatcode.dev](https://chatcode.dev)
- Architecture plan: [`MVP.md`](MVP.md)
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Self-host guide: [`docs/CLOUDFLARE_SELF_HOST.md`](docs/CLOUDFLARE_SELF_HOST.md)
- Self-host release model: [`SELFHOSTING.md`](SELFHOSTING.md)
- Frontend Pages deploy: [`docs/FRONTEND_PAGES.md`](docs/FRONTEND_PAGES.md)

## Why Chatcode

Chatcode focuses on one reliable path for MVP:

1. Provision user-owned VPS.
2. Keep one persistent gateway connection to control plane.
3. Run tmux-backed sessions for AI coding agents.

Current status:

- `M1` complete (protocol + gateway core).
- `M2` complete and hardened (control plane + reconciliation).
- `M3` auth/session staging flows validated.
- Active work: `M4` terminal reliability and reusable UI components.

## Architecture (MVP)

```text
Browser <-> Control Plane (Cloudflare Worker + Durable Object) <-> Gateway (user VPS) <-> tmux/PTY <-> AI agent process
```

## Quick Start (Developers)

```bash
pnpm install
pnpm build

# control-plane checks
pnpm --filter @chatcode/control-plane test
pnpm --filter @chatcode/control-plane build

# gateway checks
cd packages/gateway
make test
make test-deploy
```

## Install Gateway Manually

For manual/BYO testing on Linux or macOS:

```bash
# Linux
curl -fsSL https://chatcode.dev/install.sh | sudo bash -s -- \
  --version latest \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# macOS (no sudo)
curl -fsSL https://chatcode.dev/install.sh | bash -s -- \
  --version latest \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect
```

Cleanup:

```bash
# Linux
curl -fsSL https://chatcode.dev/cleanup.sh | sudo bash -s -- --yes

# macOS
curl -fsSL https://chatcode.dev/cleanup.sh | bash -s -- --yes
```

Details: [`packages/gateway/deploy/README.md`](packages/gateway/deploy/README.md)

## Security and Trust Model

Short version:

- Traffic is TLS-protected on each hop.
- **There is no end-to-end encryption between browser and gateway in MVP.**
- Control plane relays terminal streams and can inspect command/output payloads.
- Control plane does not store private SSH keys.

This is a conscious MVP tradeoff (simplicity + operability). We are explicit about it and open to improvements.

Security details, verification checklist, and roadmap:

- [`docs/SECURITY.md`](docs/SECURITY.md)

## Known MVP Trade-offs

Product/runtime trade-offs and deferred hardening items are tracked in:

- [`IMPLEMENTATION_M4_CORE.md`](IMPLEMENTATION_M4_CORE.md) ("Trade-offs & Deferred Improvements")

## Self-Host in Your Own Cloudflare Account

You can run Chatcode control-plane and release distribution in your own Cloudflare account and domain.

Guide:

- [`docs/CLOUDFLARE_SELF_HOST.md`](docs/CLOUDFLARE_SELF_HOST.md)

## Repository Layout

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared schema and typed contract (TS + Go). |
| `packages/gateway` | Gateway daemon running on user VPS. |
| `packages/control-plane` | Cloudflare Worker + Durable Object + D1 control plane. |
| `packages/web` | Browser app (later milestone). |

## Star History

<a href="https://star-history.com/#tractorfm/chatcode&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date" />
  </picture>
</a>
