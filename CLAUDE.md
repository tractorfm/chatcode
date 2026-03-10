# CLAUDE.md – chatcode monorepo

## What this is
The implementation repo for Chatcode.dev: a user-owned VPS agent platform that provisions a VM, installs a gateway daemon, and exposes persistent terminal sessions across clients (web first, then CLI/Telegram).

## Milestone status
- ✅ **M1**: Protocol schemas + Go gateway daemon
- ✅ **M2**: Control plane + hardening
- ✅ **M3**: Static landing + magic link auth
- **M4** (active): Reliability + UI polish (`docs/IMPLEMENTATION_M4.md`)
- Next: CLI foundation (`chatcode.sh`) after M4 gate

## Monorepo layout
```
packages/
├── protocol/       # JSON Schema source of truth → hand-written TS + Go types
├── control-plane/  # TypeScript – Cloudflare Workers + Durable Objects
├── web/            # React + Vite + Tailwind + shadcn/ui (Cloudflare Pages)
└── gateway/        # Go static binary – runs on user VPS
```

## Tech stack
| Package | Stack |
|---|---|
| protocol | JSON Schema, hand-written TS types, hand-written Go types |
| gateway | Go 1.22+, `nhooyr.io/websocket`, stdlib only otherwise |
| control-plane | TypeScript, Cloudflare Workers, Durable Objects, D1, KV |
| web | React, Vite, Tailwind CSS, shadcn/ui, Cloudflare Pages |

## Key architectural decisions
- One DO droplet per user (Linux user `vibe`, passwordless sudo)
- Gateway keeps one persistent WebSocket to control-plane
- One session = one tmux-backed workspace terminal (max 5 concurrent per VPS at MVP)
- No private SSH keys stored in control plane
- Binary frames for terminal output, JSON text frames for commands/events
- Protocol types are hand-written (not codegen); all messages carry `schema_version`
- Protocol schema source of truth: `packages/protocol/schema/`
- `session.input` / `session.resize` / `session.ack` are fire-and-forget; all other commands use ack-tracked `sendCommand` with 10s timeout
- Auth: HttpOnly HMAC session cookie in prod; `X-Dev-User` header only when `AUTH_MODE=dev`
- DO OAuth tokens: AES-256-GCM encrypted in D1; key (`DO_TOKEN_KEK`) as Wrangler secret
- One GatewayHub Durable Object per gateway, keyed by `idFromName(gateway_id)`
- VPS destroy is cloud-first, DB-second (droplet deleted via DO API before D1 rows removed)
- Control-plane toolchain pinned to Wrangler v4

## Go module path
`github.com/tractorfm/chatcode/packages/gateway`

## Commands
```bash
# Monorepo
pnpm install
pnpm build              # turbo build all packages

# Gateway
cd packages/gateway
make build              # build for current OS
make build-linux        # cross-compile for linux/amd64
make test               # run all tests
make test-deploy        # test deploy scripts
make lint               # golangci-lint
make mock-cp            # start mock control plane on :8080
./deploy/gateway-install.sh --help
sudo ./deploy/gateway-cleanup.sh --help

# Control plane
cd packages/control-plane
npm run dev             # wrangler dev (local, with D1/KV/DO emulation)
npm run deploy          # wrangler deploy to Cloudflare
npm run migrate         # apply D1 migrations (local)
npm run migrate:remote  # apply D1 migrations (production)
npm run test            # vitest unit tests

# Protocol
cd packages/protocol
npm run build           # tsc compile
```

## Required checks before merge
- Control-plane: `pnpm --filter @chatcode/control-plane test` + `build`
- Gateway: `cd packages/gateway && make test` + `make test-deploy`
- Web: `pnpm --filter @chatcode/web lint` + `build`
- Staging smoke (when creds available): `pnpm --filter @chatcode/web run e2e:staging:smoke`

## Rules
- **Never read or commit `.env`**
- `MVP.md` is architecture source of truth; execution plans live under `docs/IMPLEMENTATION_M*.md`
- Security-first: no root for agents, SSH keys only, no private keys in control plane
- Gateway writes `CLAUDE.md` + `AGENTS.md` into session workdir before starting agent
- Agent install scripts are embedded in the gateway binary via `go:embed`
- Prefer stdlib/min deps in `packages/gateway`
- Keep fixes inside package boundaries; avoid cross-cut shortcuts
- Update/add tests when behavior changes
- If push is non-fast-forward, rebase on `origin/main` and push again
