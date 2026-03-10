# chatcode.dev

Provision a VPS, connect a gateway, and use AI agents in a browser terminal.

- Website: [chatcode.dev](https://chatcode.dev)
- Architecture plan: [`MVP.md`](MVP.md)
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Self-host guide: [`docs/CLOUDFLARE_SELF_HOST.md`](docs/CLOUDFLARE_SELF_HOST.md)
- Self-host release model: [`SELFHOSTING.md`](SELFHOSTING.md)
- Frontend Pages deploy: [`docs/FRONTEND_PAGES.md`](docs/FRONTEND_PAGES.md)

## Why chatcode.dev

chatcode.dev focuses on one reliable path for MVP:

1. Provision user-owned VPS.
2. Keep one persistent gateway connection to control plane.
3. Run tmux-backed sessions for AI coding agents.

Current status:

- `M1` complete (protocol + gateway core).
- `M2` complete and hardened (control plane + reconciliation).
- `M3` auth/session staging flows validated.
- `M4` in progress: core terminal reliability + app UI integration on `app.staging.chatcode.dev`.

## Architecture (MVP)

```text
Browser <-> Control Plane (Cloudflare Worker + Durable Object) <-> Gateway (user VPS) <-> tmux/PTY <-> AI agent process
```

## App URLs

- Production app: `https://app.chatcode.dev`
- Staging app: `https://app.staging.chatcode.dev`
- Control plane APIs: `https://cp.chatcode.dev`, `https://cp.staging.chatcode.dev`
- Staging previews: `https://<branch>.chatcode-app-staging.pages.dev`

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

## Gateway Bootstrap Defaults

Linux gateway installs currently:

- create/use `vibe` user and `~/workspace`
- preinstall `claude-code` and `codex`
- install reusable agent installers (`claude-code`, `codex`, `gemini`, `opencode`) plus `install-git.sh`
- enable daily maintenance timer to update gateway + installed agent CLIs
- enable sudo command logging for `vibe` (root-owned log)

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

- [`docs/IMPLEMENTATION_M4.md`](docs/IMPLEMENTATION_M4.md)
- [`docs/IMPLEMENTATION_M4_CORE.md`](docs/IMPLEMENTATION_M4_CORE.md) (detailed core reference)
- [`docs/IMPLEMENTATION_M4_UI.md`](docs/IMPLEMENTATION_M4_UI.md) (detailed UI reference)

## Self-Host in Your Own Cloudflare Account

You can run chatcode.dev control-plane and release distribution in your own Cloudflare account and domain.

Guide:

- [`docs/CLOUDFLARE_SELF_HOST.md`](docs/CLOUDFLARE_SELF_HOST.md)

## Repository Layout

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared schema and typed contract (TS + Go). |
| `packages/gateway` | Gateway daemon running on user VPS. |
| `packages/control-plane` | Cloudflare Worker + Durable Object + D1 control plane. |
| `packages/web` | Browser app (`app.*`) and terminal UI components. |

## Star History

<a href="https://star-history.com/#tractorfm/chatcode&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=tractorfm/chatcode&type=Date" />
  </picture>
</a>

## License

Copyright (c) 2026 **Holy Traction OÜ**.

Licensed under **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**.

- Commercial use is allowed.
- If you modify and run this software as a network service, you must provide complete corresponding source code of your modifications to users of that service.

See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
