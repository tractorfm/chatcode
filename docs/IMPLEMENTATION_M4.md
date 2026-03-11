# chatcode.dev – Implementation Plan: Milestone 4 (Consolidated)

## Objective
Deliver a production-credible web MVP by combining core runtime hardening and UI polish:
1. Stable terminal sessions
2. Reliable reconnect/resume behavior
3. File send/receive
4. Clean onboarding/landing flow

This milestone is the gate before Telegram integration.

---

## Scope

### In scope
1. Protocol/runtime hardening for terminal sessions (gateway + control-plane + DO).
2. Web UI reliability and error handling for session workflows.
3. File upload/download flows (web ↔ control-plane ↔ gateway).
4. Basic product landing page connected to auth entry.
5. E2E staging smoke coverage for session continuity basics.

### Out of scope
1. Telegram bot UX implementation.
2. Miniapp/native clients.
3. Full portability rendering system rollout (only interface and readiness decisions in M4).

---

## Workstreams

## WS1 — Core Session Reliability
1. Freeze protocol semantics used by web runtime (`ack`, replay/snapshot behavior, error codes, lock semantics).
2. Keep tmux-backed durability as source of truth.
3. Ensure reconnect paths are deterministic:
   - normal replay path
   - snapshot fallback when replay window is missed
4. Reconcile lifecycle state safely (gateway restart, stale states, session status convergence).
5. Keep multi-client safety: single writer lock, read-only followers.

### Exit criteria
1. No frequent stale/racy session states after reconnect/restart.
2. Lock behavior prevents concurrent input corruption.
3. Session status converges correctly in D1 and UI.

---

## WS2 — Web UX Reliability & Polish
1. Remove stale state bugs in session/tab management.
2. Show actionable errors (no silent failures in core user flows).
3. Make reconnect behavior explicit in terminal UX.
4. Improve session list usability for large numbers of ended sessions.
5. Keep staging test tooling useful but separate from end-user UX.
6. Keep session creation lightweight but structured:
   - workspace-relative folder selection
   - folder grouping in sidebar
   - path-aware tab titles

### Exit criteria
1. Core flows are debuggable without checking browser console logs.
2. Session create/select/close behavior is deterministic under rapid user actions.
3. Terminal reconnect behavior is visible and predictable.
4. Session list is navigable once multiple folders/sessions exist on the same VPS.

---

## WS3 — File Send/Receive
1. Finalize web API and client UX for upload/download in active sessions.
2. Enforce limits, timeout, and clear errors (size cap, transfer timeout, cancel behavior).
3. Add end-to-end tests for:
   - upload text/binary sample
   - download verification
   - error paths (too large, timeout, offline gateway)

### Exit criteria
1. File transfer works reliably in staging for standard workflows.
2. Failure cases are user-visible and recoverable.

---

## WS4 — Landing + Auth Funnel
1. Ship a simple landing page with clear value proposition and single primary CTA.
2. Ensure auth transitions are robust:
   - magic link
   - OAuth (Google/GitHub)
   - safe redirect validation
3. Keep staging/prod origin behavior explicit and secure.

### Exit criteria
1. User can start from landing and reach authenticated app without redirect confusion.
2. Callback redirects are validated at callback time.

---

## WS5 — Testing, Observability, and Release Readiness
1. Keep staging smoke e2e stable (session create/input/reload/cleanup).
2. Ensure smoke tests are cleanup-safe on failure.
3. Expand structured logs for continuity debugging (session_id/vps_id/gateway_id correlation).
4. Validate deploy pipeline and staging runtime after each merge.

### Exit criteria
1. CI + staging smoke pass consistently.
2. Regressions are diagnosable from logs without manual guesswork.

---

## Telegram Readiness Gate (Before M5)
All items below should be complete before starting Telegram implementation:
1. Session continuity primitives are stable (`ack`, replay/snapshot fallback, reconnect semantics).
2. Multi-client control model is enforced (single writer + read-only watchers).
3. File send/receive is stable via the same backend APIs used by web.
4. Web UX is operationally reliable (clear errors, deterministic state sync).
5. Basic landing/auth funnel is in place.
6. Staging smoke tests cover create → interact → reconnect → cleanup.
7. Observability includes enough correlation data to debug cross-channel session issues.

---

## Suggested Delivery Order
1. WS1 core reliability closure.
2. WS2 web reliability closure.
3. WS3 file send/receive.
4. WS4 landing/auth polish.
5. WS5 final hardening + release checklist.

---

## Notes
1. This file consolidates planning previously split across `IMPLEMENTATION_M4_CORE.md` and `IMPLEMENTATION_M4_UI.md`.
2. Those files can remain as detailed historical context, but this is the active M4 execution plan.
