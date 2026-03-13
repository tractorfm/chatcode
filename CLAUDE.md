# CLAUDE.md – chatcode monorepo

## Objective
Ship the reliable MVP path:
1. Provision user VPS.
2. Connect gateway to control plane.
3. Run stable terminal sessions.

## Current Focus
- M1–M3 complete.
- Active: M4 reliability + UI polish (`docs/IMPLEMENTATION_M4.md`).
- Next: CLI foundation (`chatcode.sh`) after M4.

## Architecture Rules
- One DO droplet per user by default.
- Gateway keeps one persistent WebSocket to control-plane.
- One session = tmux-backed terminal rooted under `~/workspace`.
- Control-plane soft limit: 10 concurrent sessions per VPS on free plan; gateway safety cap: 50.
- Control-plane must not store private SSH keys.
- Protocol schema source of truth: `packages/protocol/schema/`.
- Every protocol message must include `schema_version`.

## Package Boundaries
- `packages/protocol`: schema + shared types.
- `packages/gateway`: session lifecycle, streaming, SSH keys, updater, file transfer, health.
- `packages/control-plane`: Worker/DO orchestration and provisioning.
- `packages/web`: browser app and session UX.

## Working Rules
- Prefer stdlib/min deps in `packages/gateway`.
- Keep fixes inside package boundaries; avoid cross-cut shortcuts.
- Update/add tests when behavior changes.
- Never commit secrets.
- `MVP.md` is the architecture source of truth; execution plans live under `docs/IMPLEMENTATION_M*.md`.
- Gateway no longer writes workspace-local `AGENTS.md` / `CLAUDE.md`; agent installers seed global guidance files only if missing.

## Required Checks
- `pnpm --filter @chatcode/control-plane test`
- `pnpm --filter @chatcode/control-plane build`
- `cd packages/gateway && make test`
- `cd packages/gateway && make test-deploy`
- `pnpm --filter @chatcode/web lint`
- `pnpm --filter @chatcode/web build`

## Local Staging Auth
- Local-only staging helper secrets live in `.dev-secrets.env` at the repo root.
- Use it for `POST /auth/dev/login`, staging smoke, and local staging helper scripts.
- Never commit this file.
