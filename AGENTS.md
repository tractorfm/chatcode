# AGENTS.md – chatcode monorepo

## Objective
Build the self-serve Chatcode.dev core: provision user-owned VPS, connect gateway reliably, and run AI agent terminal sessions with minimal friction.

## Current Priority
- ✅ M1 complete: protocol schemas + gateway reliability.
- ✅ M2 core implemented: control plane scaffold, D1 schema/helpers, routes, GatewayHub DO, scheduled reconciliation worker.
- ✅ M2 hardening pass completed: gateway-id validation, snapshot path fix, and broader route/DO test coverage.
- Current focus is M2 staging validation: remote D1/KV/DO setup, deploy smoke tests, and reconciliation verification against real cloud resources.
- Gateway release distribution is automated: GitHub tag builds publish multi-arch bundles, and optional R2 upload mirrors releases under `releases.chatcode.dev/gateway/`.
- Keep scope intentionally narrow: make "provision VPS -> connect gateway -> open terminal reliably" solid before adding broader UX surface area.

## Architecture Constraints
- One DigitalOcean droplet per user by default.
- Gateway runs on user VPS and maintains one persistent WebSocket to control plane.
- One session equals one tmux-backed workspace terminal.
- MVP limit is max 5 concurrent sessions per VPS.
- Control plane must never store private SSH keys.
- Agent startup should write instruction files (`CLAUDE.md` and `AGENTS.md`) into the session workdir.
- BYO roadmap is prepared (not fully enabled): `gateway.hello` includes optional `bootstrap_token` and required `system_info`; gateway has service-manager abstraction seam for systemd/launchd.

## Protocol Rules
- JSON Schema in `packages/protocol/schema/` is the source of truth.
- All protocol messages must include `schema_version`.
- Use JSON text frames for commands/events.
- Use binary frames for terminal output (`kind=0x01` with session and sequence metadata).
- Keep TS and Go protocol types consistent with schema changes.

## Package Responsibilities
- `packages/protocol`: schema and typed contract shared by all components.
- `packages/gateway`: tmux/session lifecycle, output streaming, ssh key management, file transfer, health, updater.
- `packages/control-plane`: Cloudflare Workers/DO orchestration and gateway registration flow (current milestone).
- `packages/web`: browser UX and terminal client (later milestone).

## Development Priorities
1. Staging deploy readiness: wrangler bindings/secrets, remote migrations, and safe rollout checks.
2. End-to-end staging verification: OAuth, provisioning, gateway connect, session lifecycle, terminal stream, destroy flow.
3. D1 state transition correctness for provisioning/deleting reconciliation under real scheduler conditions.
4. Provisioning robustness (DO create flow, timeout/retry/error states).
5. Keep gateway and protocol compatibility stable while M2 matures.

## Workflow Rules
- Prefer minimal dependencies, especially in `packages/gateway` (stdlib-first unless justified).
- Read and extend existing package boundaries instead of cross-cutting quick fixes.
- Add or update tests when behavior changes.
- Never commit secrets or rely on `.env` values being present.
- Keep `MVP.md` as architecture source of truth and milestone docs (`IMPLEMENTATION_M1.md`, `IMPLEMENTATION_M2.md`) as execution plans.
- For control-plane changes, run `pnpm --filter @chatcode/control-plane test` and `pnpm --filter @chatcode/control-plane build` before merge.
- For gateway release automation, keep GitHub repo secrets in sync: `CF_ACCOUNT_ID`, `CF_API_TOKEN_R2_RELEASES`, and `R2_RELEASE_BUCKET`.

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
./scripts/build-release.sh v0.1.1
./scripts/publish-release-r2.sh v0.1.1 chatcode-releases
sudo ./deploy/manual-install.sh --help
sudo ./deploy/gateway-cleanup.sh --help

# Control plane
cd packages/control-plane
npm run dev
npm run test

# Protocol
cd packages/protocol
npm run build
```
