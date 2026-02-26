# chatcode

Implementation monorepo for [Chatcode.dev](https://chatcode.dev) – provision a VPS, open a terminal in the browser, start coding with your AI agent.

## Packages

| Package | Description | Status |
|---|---|---|
| `packages/protocol` | Shared protocol definitions (JSON Schema + TS + Go types) | M1 |
| `packages/gateway` | Go daemon running on user VPS | M1 |
| `packages/control-plane` | Cloudflare Workers + Durable Objects | M2 |
| `packages/web` | React + xterm.js web app | M4 |

## Quick start

```bash
# Install JS dependencies
pnpm install

# Build everything
pnpm build

# Develop gateway
cd packages/gateway
make mock-cp    # terminal 1: start mock control plane
make build && ./gateway  # terminal 2: run gateway
```

## Manual gateway install (Linux/systemd + macOS/launchd)

Use this for BYO-style testing on an existing machine:

```bash
cd packages/gateway
make build

# local binary install
sudo ./deploy/gateway-install.sh \
  --binary-source ./gateway \
  --gateway-id gw-local-test \
  --gateway-auth-token tok-local-test \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# or install directly from published release
sudo ./deploy/gateway-install.sh \
  --version latest \
  --gateway-id gw-local-test \
  --gateway-auth-token tok-local-test \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect

# macOS (run as your user, not sudo)
./deploy/gateway-install.sh \
  --version latest \
  --gateway-id gw-local-test \
  --gateway-auth-token tok-local-test \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect
```

Cleanup script (destructive, removes service/binary/config and `vibe` user by default):

```bash
cd packages/gateway
sudo ./deploy/gateway-cleanup.sh --yes
# macOS:
./deploy/gateway-cleanup.sh --yes
```

## Gateway releases

```bash
cd packages/gateway

# Build release bundle (linux/amd64, linux/arm64, darwin/arm64)
./scripts/build-release.sh v0.1.1
```

Tagging `v*` pushes runs `.github/workflows/gateway-release.yml` to build and attach release assets on GitHub.

## Architecture

```
Browser ←─ WebSocket ─→ Control Plane (Cloudflare Workers + DO)
                                ↕ WebSocket
                        Gateway daemon (Go, on user VPS)
                                ↕ tmux/PTY
                          AI Agent process
```

See `MVP.md` for full architecture details and `IMPLEMENTATION_M1.md` for M1 plan.
