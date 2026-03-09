# chatcode.dev – Implementation Plan: Milestone 4 (Core)

## Objective
Stabilize the terminal runtime path (gateway + control-plane + protocol) so sessions behave like a real terminal under reconnects, long-running agents, and UI restarts.

This document is intentionally UI-agnostic. Frontend work is tracked separately in `IMPLEMENTATION_M4_UI.md`.

---

## Scope (Core Only)

1. Protocol contracts for terminal streaming and control messages.
2. Gateway terminal stream correctness (modes, cursor keys, resize, snapshots, replay).
3. GatewayHub reliability (acks, replay buffering, hibernation/reconnect behavior).
4. Session ownership semantics (single writer, multi-reader).
5. Lifecycle reconciliation (gateway restart, stale session cleanup, state transitions).
6. Observability and test coverage for the above.

---

## Out Of Scope

1. Product UX and styling.
2. Session page design and navigation.
3. Identity/auth product surface changes (already covered in M3).
4. Telegram/miniapp client features (unless directly required by protocol).

## Explicit Dependencies

1. M3 auth/session endpoints must be deployed and stable before M4 UI rollout.
2. M4 core can be implemented independently, but end-to-end sign-off depends on M3 completion.

---

## Architecture Constraints

1. Protocol schema source of truth remains `packages/protocol/schema/`.
2. Gateway remains tmux-backed for session durability.
3. Control-plane keeps durable coordination in `GatewayHub` DO.
4. Keep gateway dependencies minimal (stdlib first).
5. Terminal transport remains `capture-pane -e` plus tmux state polling/events; raw PTY forwarding is out of scope.

---

## Workstreams

## WS1 — Protocol Freeze

### Deliverables
1. Finalized terminal event schema additions/clarifications:
   - mode/state signaling (including cursor key mode / DECCKM semantics)
   - replay metadata fields
   - explicit error codes for terminal channel
2. Freeze binary frame wire format (not only JSON schema):
   - `kind` byte
   - session id encoding
   - sequence number encoding
   - payload encoding rules
3. Explicit ack/replay contract with sequence guarantees.
4. Versioned schema updates + generated/shared types.
5. Protocol documentation page with examples and failure cases (gap/replay_missed/read_only).

### Exit Criteria
1. Schema and types merged.
2. Gateway + control-plane compile against frozen schema without ad-hoc event types.
3. Golden tests cover binary frame encode/decode compatibility.

---

## WS2 — Stream Correctness

### Deliverables
1. Settle stream mechanism explicitly for M4:
   - keep `capture-pane -e` as canonical content source
   - add mode/state polling from tmux format variables (`alternate_on`, `cursor_flag`, cursor position, and available key-mode flags)
   - emit protocol mode events from gateway (hybrid model)
2. Remove client-side hardcoded arrow-key workaround as protocol-mode correctness lands.
3. Ensure terminal mode changes are preserved across:
   - live stream updates
   - redraw/snapshot paths
   - reconnect resume
4. Keep cursor position/visibility behavior consistent under full-screen apps (`htop`, `nano`).

### Exit Criteria
1. `htop` arrow navigation works without client hacks.
2. `nano` cursor and movement stay correct after reconnect/snapshot.
3. Mode events are deterministic across reconnect and redraw boundaries.

---

## WS3 — Replay Buffer & Resume

### Deliverables
1. Durable replay buffer semantics in DO (bounded, sequence-indexed):
   - per-session cap: `max 2 MiB` or `max 1024 frames` (whichever hits first)
   - DO-wide soft cap: `max 10 MiB`, evict oldest frames first across sessions
2. Resume protocol for browser reconnect with `last_seq`.
3. Snapshot fallback decision and ownership in core:
   - if `last_seq < oldest_buffered_seq` => emit `replay_missed`, then send snapshot
   - if within window => replay only missing frames
4. Deterministic replay metadata in stream ack/recovery events.

### Exit Criteria
1. Browser reconnect restores terminal output without missing chunks in normal window.
2. Gap behavior is deterministic and visible (`replay_missed`/snapshot fallback event).
3. Replay behavior stays within configured memory bounds under sustained output.

---

## WS4 — Input Ownership & Concurrency

### Deliverables
1. Single active writer lock per session.
2. Read-only subscribers still receive full output stream.
3. Deterministic lock handoff/expiry rules.
4. Explicit multi-reader ack policy:
   - only controller ack advances replay-eviction watermark
   - read-only ack is optional telemetry only (must not pin buffer retention)

### Exit Criteria
1. Concurrent input sources cannot interleave command bytes.
2. Read-only error paths are schema-defined and tested.
3. Read-only viewers never block replay eviction.

---

## WS5 — Lifecycle Reconciliation

### Deliverables
1. Safe gateway restart behavior:
   - no premature `ended` transitions from partial health snapshots
2. Session state reconciliation between tmux reality, gateway memory, and D1 records.
3. Reliable stale-session cleanup rules.

### Exit Criteria
1. Gateway restart does not incorrectly end live tmux sessions.
2. D1 session status converges to true runtime state.

---

## WS6 — Observability & Hardening

### Deliverables
1. Structured logs for stream/replay/input-lock transitions.
2. Core counters (replay hits/misses, snapshot fallbacks, lock conflicts, reconnects).
3. Failure taxonomy used in logs and API responses.

### Exit Criteria
1. Critical failures are diagnosable from logs without ad-hoc reproduction.

---

## Testing Plan

1. Gateway unit tests:
   - mode handling
   - diff/snapshot edge cases
   - cursor visibility/position under redraw
2. Control-plane/DO tests:
   - ack/replay semantics
   - resume from `last_seq`
   - ownership conflicts
3. Integration tests:
   - gateway restart with active tmux session
   - reconnect with replay then snapshot fallback
4. Staging smoke tests (manual + scripted):
   - `htop`, `nano`, long-running command output, reconnect mid-stream

Required checks before merge:
1. `cd packages/gateway && make test`
2. `cd packages/gateway && make test-deploy`
3. `pnpm --filter @chatcode/control-plane test`
4. `pnpm --filter @chatcode/control-plane build`

---

## Delivery Phases

1. Phase 1: WS1 protocol freeze + WS4 lock formalization.
2. Phase 2: WS2 stream correctness + WS3 replay/resume.
3. Phase 3: WS5 reconciliation + WS6 observability.
4. Phase 4: End-to-end staging validation and release cut.

---

## Release Gate (Core)

1. No client-side arrow-key forcing needed for normal terminal behavior.
2. Replay + snapshot fallback tested and deterministic.
3. Session lock behavior stable under parallel clients.
4. Gateway restart/reconnect does not corrupt session status.
5. All required tests pass in CI and local smoke checks.

---

## Trade-offs & Deferred Improvements

These are intentional MVP decisions with follow-up items tracked for post-M4 hardening.

1. Terminal transport:
   - Current: `capture-pane -e` + tmux state polling (durable/simple).
   - Deferred: raw PTY stream path only if proven necessary by concrete app gaps.
2. Session create path latency:
   - Current: managed-agent preflight (`agents.list`) before `session.create`.
   - Deferred: short TTL cache per-gateway or status piggyback in `gateway.health`.
3. Trust model:
   - Current: no end-to-end encryption between browser and gateway.
   - Deferred: optional E2E mode for terminal payloads.
4. Gateway self-update safety:
   - Current: checksum verification + restart, no automatic rollback on bad restart.
   - Deferred: staged health check + automatic rollback to previous binary.
5. Multi-client session control:
   - Current: single active writer lock per session; others are read-only.
   - Deferred: explicit UX/API for lock take-over policies and telemetry.
6. Staging auth ergonomics:
   - Current: `AUTH_MODE=dev` header auth protected by `DEV_AUTH_SECRET`.
   - Deferred: stricter staging policy parity with production where useful.
7. Release publishing operations:
   - Current: manual R2 publish fallback exists when tag workflow misses.
   - Deferred: make tag-trigger path deterministic and add release smoke gate.
8. Agent install error UX:
   - Current: `agents.install` is acked immediately; failures are logged on gateway.
   - Deferred: schema-defined `agent.install_failed` event and client handling.
