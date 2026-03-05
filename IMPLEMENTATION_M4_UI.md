# VibeCode – Implementation Plan: Milestone 4 (UI)

## Objective
Build a minimal but reliable session UI on top of M4 core contracts, without changing gateway/control-plane behavior from the frontend layer.

This document assumes core work is tracked in `IMPLEMENTATION_M4_CORE.md`.

---

## Scope (UI Only)

1. Session list/create/connect/end flows.
2. Reusable terminal component for product UI.
3. Reconnect and replay-state UX.
4. Input ownership UX (controller vs read-only).
5. Operator-grade diagnostics for staging.

---

## Out Of Scope

1. Protocol design changes.
2. Gateway transport semantics.
3. DO replay buffer internals.
4. Provisioning backend behavior changes.

---

## UI/Core Contract Boundary

UI may consume only frozen contract fields/events and must not depend on internal transport hacks.

Required stable contract inputs:
1. Session stream events + binary frame format.
2. Ack/replay semantics and `last_seq` resume behavior.
3. Session mode/state events (cursor mode, ended/error states).
4. Read-only/input-lock events and error codes.

UI contract dependencies:
1. Blocked by Core WS1 for protocol freeze (including binary frame format).
2. Blocked by Core WS2 for mode semantics (DECCKM/alternate/cursor behavior).
3. Blocked by Core WS3 for replay-vs-snapshot fallback events.
4. Blocked by Core WS4 for lock/ack semantics.

---

## Workstreams

## WS1 — Terminal Component Productization

### Deliverables
1. Acknowledge migration path explicitly:
   - current base: server-rendered staging template (`staging-terminal-component.ts`)
   - target base: reusable React terminal component for `packages/web`
   - keep a thin compatibility wrapper so staging can use the same core module during migration
2. Extract terminal component from staging page into reusable module for `packages/web`.
3. Support theme profiles (`default`, `iterm2`, others) via config.
3. Keep terminal API surface small:
   - `connect`
   - `disconnect`
   - `setReadOnly`
   - `fit`
   - `dispose`
4. Keep newline handling aligned with core transport:
   - terminal input/output remains `capture-pane` based for M4
   - keep `convertEol` behavior consistent with this transport

### Exit Criteria
1. Staging and product pages can reuse the same terminal base component.
2. Terminal behavior remains correct under the M4 core transport contract.

---

## WS2 — Session UX Flows

### Deliverables
1. Session list panel with status and last activity.
2. Create session flow with title/agent/workdir.
3. Connect/disconnect/end controls.
4. Clear user feedback for provisioning/gateway offline states.

### Exit Criteria
1. Full session lifecycle usable without raw JSON tools.

---

## WS3 — Reconnect & Recovery UX

### Deliverables
1. Auto-reconnect on websocket drop.
2. UI indicators:
   - reconnecting
   - replaying buffered output
   - snapshot fallback used
3. Deterministic behavior when resume is not possible (driven by Core WS3 event contract).

### Exit Criteria
1. User can recover view state after refresh/network flap without confusion.

---

## WS4 — Input Ownership UX

### Deliverables
1. Explicit mode badge: `Controller` / `Read-only`.
2. Acquire/release control action when lock semantics are active.
3. Clear handling for lock conflict errors.

### Exit Criteria
1. Multi-window behavior is understandable and safe.

---

## WS5 — Diagnostics & Test Hooks

### Deliverables
1. Lightweight diagnostics panel (session id, vps id, cols/rows, connection state, last seq).
2. Optional debug toggles for staging only.
3. Minimal keyboard test helper for control sequences.

### Exit Criteria
1. Terminal regressions can be triaged quickly from browser-side signals.

---

## Testing Plan

1. Component tests:
   - terminal lifecycle and cleanup
   - read-only transitions
2. E2E tests (Playwright):
   - create/connect session
   - reconnect/resume flow
   - ownership conflict flow
   - `htop` and `nano` interaction smoke checks
3. Staging smoke checklist before release:
   - refresh/reconnect while command running
   - open second tab as read-only
   - end session from another tab

---

## Delivery Phases

1. Phase 1: WS1 component extraction + WS2 baseline flows (blocked by Core WS1 contract freeze).
2. Phase 2: WS3 reconnect/recovery UX (blocked by Core WS3 replay/snapshot semantics).
3. Phase 3: WS4 ownership UX + WS5 diagnostics (blocked by Core WS4 lock/ack semantics).
4. Phase 4: E2E hardening and staging sign-off.

---

## Release Gate (UI)

1. No staging-only hacks required for normal terminal input behavior.
2. Reconnect/replay states are visible and predictable.
3. Read-only/controller UX prevents accidental concurrent input.
4. E2E smoke suite passes against staging.
