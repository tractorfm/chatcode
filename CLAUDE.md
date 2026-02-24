# CLAUDE.md – chatcode monorepo

## What this is
The implementation repo for Chatcode.dev: a free VPS provisioning + browser terminal with AI agent integration.

## Milestone status
- ✅ **M1**: Protocol schemas + Go gateway daemon
- **M2** (current): Control plane (Cloudflare Workers + Durable Objects + D1)
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
- One droplet per user (Linux user `vibe`, passwordless sudo)
- One tmux session per Session (max 5 concurrent per VPS at MVP)
- No private SSH keys stored in control plane
- Gateway connects out to control plane via persistent WebSocket
- Binary frames for terminal output, JSON text frames for commands/events
- Protocol types are hand-written (not codegen) – add codegen when schemas stabilize
- All protocol messages carry `schema_version: "1"`
- `session.ack` sent by CP to acknowledge received terminal output seq

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
- `MVP.md` is architecture source of truth; `IMPLEMENTATION_M1.md` / `IMPLEMENTATION_M2.md` are the milestone plans
- Security-first: no root for agents, SSH keys only, no private keys in control plane
- Gateway writes `CLAUDE.md` + `AGENTS.md` into session workdir before starting agent
- Agent install scripts are embedded in the gateway binary via `go:embed`
