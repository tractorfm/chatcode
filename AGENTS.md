# AGENTS.md – chatcode monorepo

## Objective
Ship a reliable MVP path:
1. Provision user VPS.
2. Connect gateway to control plane.
3. Run stable terminal sessions.

## Current Focus
- M1–M3 complete and validated.
- Active: M4 reliability + UI polish (`docs/IMPLEMENTATION_M4.md`).
- Next: CLI foundation (`chatcode.sh`) after M4 gate.
- Keep scope narrow: reliability first.

## Architecture Rules
- One DO droplet per user by default.
- Gateway keeps one persistent WebSocket to control-plane.
- One session = tmux-backed workspace terminal.
- MVP limit: max 5 concurrent sessions per VPS.
- Control-plane must not store private SSH keys.
- Protocol schema source of truth: `packages/protocol/schema/`.
- Every protocol message must include `schema_version`.

## Package Boundaries

- `packages/protocol`: schema + shared types.
- `packages/gateway`: session lifecycle, streaming, SSH keys, file transfer, health, updater.
- `packages/control-plane`: Worker/DO orchestration and provisioning flows.
- `packages/web`: browser app and session UX.

## Working Rules
- Prefer stdlib/min deps in `packages/gateway`.
- Keep fixes inside package boundaries; avoid cross-cut shortcuts.
- Update/add tests when behavior changes.
- Never commit secrets.
- Keep `MVP.md` as architecture source; `docs/IMPLEMENTATION_M*.md` as execution docs.
- If push is non-fast-forward, rebase on `origin/main` and push again.

## Required Checks Before Merge

- Control-plane changes:
  - `pnpm --filter @chatcode/control-plane test`
  - `pnpm --filter @chatcode/control-plane build`
- Gateway runtime/deploy changes:
  - `cd packages/gateway && make test`
  - `cd packages/gateway && make test-deploy`
- Web changes:
  - `pnpm --filter @chatcode/web lint`
  - `pnpm --filter @chatcode/web build`
  - staging smoke (when creds available): `pnpm --filter @chatcode/web run e2e:staging:smoke`

## Useful Commands

```bash
# monorepo
pnpm install
pnpm build

# gateway
cd packages/gateway
make build
make test
make test-deploy
./deploy/gateway-install.sh --help
sudo ./deploy/gateway-cleanup.sh --help

# control-plane
cd packages/control-plane
npm run dev
npm run test

# protocol
cd packages/protocol
npm run build
```
