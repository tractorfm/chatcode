# CLAUDE.md – chatcode monorepo

## What this is
The implementation repo for Chatcode.dev: a free VPS provisioning + browser terminal with AI agent integration.

## Milestone status
- ✅ **M1**: Protocol schemas + Go gateway daemon
- **M2** (current): Control plane implemented; now in hardening/test-coverage phase
- **M3**: Static landing + magic link auth
- **M4**: Full web app (React + xterm.js)

## Monorepo layout
```
packages/
├── protocol/       # JSON Schema source of truth → hand-written TS + Go types
├── control-plane/  # TypeScript – Cloudflare Workers + Durable Objects (M2)
├── web/            # React + Vite + Tailwind + shadcn/ui (M4)
└── gateway/        # Go static binary – runs on user VPS (M1)
```

## Tech stack
| Package | Stack |
|---|---|
| protocol | JSON Schema, hand-written TS types, hand-written Go types |
| gateway | Go 1.22+, `nhooyr.io/websocket`, stdlib only otherwise |
| control-plane | TypeScript, Cloudflare Workers, Durable Objects, D1, KV |
| web | React, Vite, Tailwind CSS, shadcn/ui, Cloudflare Pages |

## Key architectural decisions

### Protocol + Gateway (M1)
- One droplet per user (Linux user `vibe`, passwordless sudo)
- One tmux session per Session (max 5 concurrent per VPS at MVP)
- No private SSH keys stored in control plane
- Gateway connects out to control plane via persistent WebSocket: `<CPURL>/<gateway_id>` (e.g. `wss://cp.chatcode.dev/gw/connect/gw-abc123`)
- Binary frames for terminal output, JSON text frames for commands/events
- Protocol types are hand-written (not codegen) – add codegen when schemas stabilize
- All protocol messages carry `schema_version: "1"`
- `session.ack` sent by CP to relay browser acknowledgement of terminal output seq to gateway

### Control plane (M2)
- One **GatewayHub** Durable Object per gateway, keyed by `idFromName(gateway_id)` – WS terminus + fan-out hub
- Gateway auth: `Authorization: Bearer <token>` header; Worker verifies via timing-safe HMAC-SHA256 against hash stored in D1
- Worker forwards authenticated `gateway_id` into GatewayHub and GatewayHub rejects mismatched `gateway.hello` payload IDs
- `session.input` / `session.resize` / `session.ack` are **fire-and-forget** (`sendRealtime`); all other commands use ack-tracked `sendCommand` with 10s timeout and pending map
- `session.snapshot` now resolves command path with snapshot payload (not just ack) for HTTP snapshot route behavior
- All pending map entries rejected on gateway disconnect
- Provisioning timeout: Scheduled Worker (cron `* * * * *`) + `provisioning_deadline_at` column in D1 – durable, no in-memory state
- VPS status transitions: `provisioning` → `active` on first `gateway.hello`; `active` → `deleting` when destroy is initiated
- VPS destroy is **cloud-first, DB-second**: droplet deleted via DO API before D1 rows are removed; rows retained on API failure for reconciliation
- Auth: HttpOnly HMAC session cookie in prod; `X-Dev-User` header accepted only when `AUTH_MODE=dev` – no global bypass
- DO OAuth tokens: AES-256-GCM encrypted in D1; key (`DO_TOKEN_KEK`) stored as Wrangler secret, never in D1
- Standard DO WebSocket API for M2 (hibernation mode deferred post-M2)

## Go module path
`github.com/tractorfm/chatcode/packages/gateway`

## Commands
```bash
# Gateway
cd packages/gateway
make build              # build for current OS
make build-linux        # cross-compile for linux/amd64
make test               # run all tests
make lint               # golangci-lint
make mock-cp            # start mock control plane on :8080

# Control plane
cd packages/control-plane
npm run dev             # wrangler dev (local, with D1/KV/DO emulation)
npm run deploy          # wrangler deploy to Cloudflare
npm run migrate         # apply D1 migrations (local)
npm run migrate:remote  # apply D1 migrations (production)
npm run test            # vitest unit tests

# Protocol (TypeScript types)
cd packages/protocol
npm run build           # tsc compile

# Full monorepo (from chatcode/)
pnpm install
pnpm build              # turbo build all packages
```

## Rules
- **Never read or commit `.env`**
- `MVP.md` is architecture source of truth; `IMPLEMENTATION_M2.md` is the current milestone plan (M1 is complete)
- Security-first: no root for agents, SSH keys only, no private keys in control plane
- Gateway writes `CLAUDE.md` + `AGENTS.md` into session workdir before starting agent
- Agent install scripts are embedded in the gateway binary via `go:embed`
