# VibeTunnel Review For Chatcode

## Verdict

`vibetunnel/` is relevant to `chatcode/`, especially for terminal transport, fan-out, reconnect behavior, and protocol hardening.

## What Is Directly Reusable

1. Separate realtime vs ack-tracked command paths.
   - VibeTunnel routes input/resize/kill as direct websocket actions (`INPUT_TEXT`, `RESIZE`, `KILL`) without per-message command ack waiting.
   - Reference: `vibetunnel/web/src/server/services/ws-v3-hub.ts:154`, `:168`, `:176`.
   - Chatcode mapping: keep `sendRealtime` for `session.input` / `session.resize` / `session.ack`; reserve pending-map only for state-changing commands.

2. Strong frame validation on binary protocol boundaries.
   - VibeTunnel validates magic/version/length before accepting a frame.
   - Reference: `vibetunnel/web/src/shared/ws-v3.ts:79`.
   - Chatcode mapping: if/when we move beyond JSON payloads, keep explicit versioned frame format and reject malformed frames early.

3. Subscription/fan-out model with explicit channel flags.
   - VibeTunnel uses per-session subscription flags (`Stdout`, `Snapshots`, `Events`) and fan-out from one hub.
   - Reference: `vibetunnel/web/src/shared/ws-v3.ts:110`, `vibetunnel/web/src/server/services/ws-v3-hub.ts:198`.
   - Chatcode mapping: current subscriber sets are good; if we add richer channels, copy flag-based subscriptions to avoid redundant traffic.

4. Client reconnect + resubscribe + queued send.
   - Exponential backoff reconnect, message queue during reconnect, and automatic re-subscription.
   - Reference: `vibetunnel/web/src/client/services/terminal-socket-client.ts:121`, `:180`, `:206`, `:127`.
   - Chatcode mapping: browser terminal client should implement this to survive transient gateway/control-plane disconnects cleanly.

5. Keepalive ping/pong.
   - Client sends periodic `PING`, server replies `PONG`.
   - Reference: `vibetunnel/web/src/client/services/terminal-socket-client.ts:190`, `vibetunnel/web/src/server/services/ws-v3-hub.ts:137`.
   - Chatcode mapping: useful for detecting dead browser sockets faster than idle timeout.

6. Late-joiner bootstrap behavior.
   - VibeTunnel gives new subscribers historical/initial output context and then streams live.
   - Reference: `vibetunnel/web/src/server/services/cast-output-hub.ts:91`, `:261`.
   - Chatcode mapping: keep snapshot-on-attach and consider a small recent-output bootstrap later.

7. Socket parser hardening and message size ceilings.
   - Handles partial frames and enforces a max message size.
   - Reference: `vibetunnel/web/src/server/pty/socket-protocol.ts:182`, `vibetunnel/web/src/server/websocket/control-unix-handler.ts:302`.
   - Chatcode mapping: add payload size limits on gateway/browser WS messages to avoid memory abuse.

## What To Avoid Copying As-Is

1. Query-string token auth for browser WS when avoidable.
   - VibeTunnel uses `?token=...` for `/ws`.
   - Reference: `vibetunnel/web/src/client/services/terminal-socket-client.ts:109`, `vibetunnel/web/src/server/middleware/auth.ts:236`.
   - Chatcode stance: prefer cookie/session auth for browser WS and bearer header for gateway WS (less leakage risk in logs/URLs).

2. Non-timing-safe secret comparisons.
   - Some local/bearer checks use direct `===`.
   - Reference: `vibetunnel/web/src/server/middleware/auth.ts:168`, `:196`, `:225`.
   - Chatcode stance: keep constant-time comparison for token/HMAC checks.

3. Response matching by message type only for request/response socket APIs.
   - `sendMessageWithResponse` waits on response type, not request correlation ID.
   - Reference: `vibetunnel/web/src/server/pty/socket-client.ts:274`.
   - Chatcode stance: keep `request_id`-keyed pending map (already in M2 plan) for deterministic matching under concurrency.

## Additional Reusable Patterns

1. `safeSend` pattern for fan-out.
   - Every broadcast checks `ws.readyState !== WebSocket.OPEN` before calling `ws.send()`, wrapped in try/catch; failures are logged and skipped.
   - Reference: `vibetunnel/web/src/server/services/ws-v3-hub.ts:660`.
   - Chatcode mapping: apply in GatewayHub’s binary fan-out and all subscriber sends so one dead socket cannot break the fan-out loop.

2. Handler-level error recovery (with explicit malformed-frame policy).
   - When a decoded frame handler throws, the error is caught and an `ERROR` frame is sent back; connection stays open.
   - Reference: `vibetunnel/web/src/server/services/ws-v3-hub.ts:103`.
   - Important nuance: truly malformed frames are currently dropped (`if (!frame) return`) rather than error-framed.
   - Reference: `vibetunnel/web/src/server/services/ws-v3-hub.ts:100`.
   - Chatcode mapping: choose explicit behavior for malformed browser frames (structured error vs close), not silent drop.

3. SIGTERM -> SIGKILL escalation for session termination.
   - Sends SIGTERM once, polls every 500ms, and escalates to SIGKILL if still running after up to 3s.
   - Reference: `vibetunnel/web/src/server/pty/pty-manager.ts:1517`, `vibetunnel/web/src/server/pty/pty-manager.ts:1566`.
   - Chatcode mapping: gateway `session.end` should verify termination and escalate when graceful stop fails.

4. Serialized write queue for ordered async writes.
   - A promise-chain queue (`queue = queue.then(writeFn).catch(log)`) serializes async writes while keeping queue continuity on errors.
   - Reference: `vibetunnel/web/src/server/utils/write-queue.ts`.
   - Important nuance: in VibeTunnel this is used for PTY/stdout/input write paths, not WebSocket fan-out.
   - Reference: `vibetunnel/web/src/server/pty/pty-manager.ts:621`, `vibetunnel/web/src/server/pty/pty-manager.ts:675`.
   - Chatcode mapping: use this pattern where we have async ordered writes (e.g., file/log/PTY boundaries). Add WS outbox queue only if profiling shows ordering/backpressure issues.

## High-Value Additions For Chatcode M2/M3

1. Add WS ping/pong to GatewayHub + browser client.
2. Add explicit max message size checks on inbound WS payloads.
3. Add reconnect/resubscribe semantics in browser terminal transport.
4. Apply `safeSend` pattern (readyState check + try/catch) to every GatewayHub fan-out send.
5. Define malformed-frame policy explicitly (return structured error or close), instead of silent drop behavior.
6. Add SIGTERM -> SIGKILL escalation (3s window, 500ms checks) to gateway session.end handler.
7. Add tests mirroring VibeTunnel’s WS hub tests:
   - welcome/connected handshake,
   - invalid payload handling,
   - fire-and-forget routing for input/resize,
   - subscriber cleanup on close.
   - Reference pattern: `vibetunnel/web/src/server/services/ws-v3-hub.test.ts:138`.

## Not Very Relevant To Chatcode

- macOS app lifecycle and native integration (`mac/`, `ios/`).
- Git follow mode and local developer workflow automation.
- Sparkle/update/distribution pipeline.
