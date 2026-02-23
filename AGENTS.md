# AGENTS.md – chatcode monorepo

## Objective
Build the self-serve Chatcode.dev core: provision user-owned VPS, connect gateway reliably, and run AI agent terminal sessions with minimal friction.

## Current Priority
- Current milestone is M1: protocol schemas and gateway reliability.
- Keep scope intentionally narrow: make "provision VPS -> open terminal -> work reliably" solid before adding surface area.

## Architecture Constraints
- One DigitalOcean droplet per user by default.
- Gateway runs on user VPS and maintains one persistent WebSocket to control plane.
- One session equals one tmux-backed workspace terminal.
- MVP limit is max 5 concurrent sessions per VPS.
- Control plane must never store private SSH keys.
- Agent startup should write instruction files (`CLAUDE.md` and `AGENTS.md`) into the session workdir.

## Protocol Rules
- JSON Schema in `packages/protocol/schema/` is the source of truth.
- All protocol messages must include `schema_version`.
- Use JSON text frames for commands/events.
- Use binary frames for terminal output (`kind=0x01` with session and sequence metadata).
- Keep TS and Go protocol types consistent with schema changes.

## Package Responsibilities
- `packages/protocol`: schema and typed contract shared by all components.
- `packages/gateway`: tmux/session lifecycle, output streaming, ssh key management, file transfer, health, updater.
- `packages/control-plane`: Cloudflare Workers/DO orchestration (next milestone).
- `packages/web`: browser UX and terminal client (later milestone).

## Development Priorities
1. Session lifecycle reliability (create/input/resize/end/snapshot/reconnect).
2. Provisioning and gateway connectivity resilience.
3. Safe SSH key and file transfer paths (20MB MVP limit, chunked flow).
4. Clear offline/health behavior and recovery UX.
5. Agent install and update mechanisms with rollback-safe behavior.

## Workflow Rules
- Prefer minimal dependencies, especially in `packages/gateway` (stdlib-first unless justified).
- Read and extend existing package boundaries instead of cross-cutting quick fixes.
- Add or update tests when behavior changes.
- Never commit secrets or rely on `.env` values being present.
- Keep `MVP.md` as architecture source of truth and `IMPLEMENTATION_M1.md` as execution plan.

## Useful Commands
```bash
# Monorepo
pnpm install
pnpm build

# Gateway
cd packages/gateway
make build
make test
make mock-cp

# Protocol
cd packages/protocol
npm run build
```
