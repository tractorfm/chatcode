# Postmortem: Codex Onboarding Message Flood

Date: 2026-03-12

## Summary

Opening Codex inside a Chatcode terminal on staging triggered an unexpected spike in GatewayHub Durable Object message volume.

The immediate user symptom was terminal corruption on the Codex onboarding screen:

- the ASCII animation kept re-rendering
- the auth URL never finished drawing
- the screen appeared to restart from the top repeatedly

At the same time, the staging Durable Object request count rose sharply from roughly 300-400k to about 1M.

## What Happened

Codex renders the browser-login URL as an OSC-8 hyperlink.

Our gateway session capture path used:

- `tmux capture-pane -e -N`
- a `50ms` polling interval
- full redraws for non-append screen diffs

On the problematic Codex screen, tmux capture output was not close to the visible screen size.
The visible screen content was about 1.1 KB, but the raw captured pane was about 232 KB because the hyperlink metadata was repeated through the pane capture.

That oversized capture then flowed through the rest of the stack:

1. The gateway treated non-append changes as full redraws.
2. The redraw payload was split into many binary terminal frames.
3. The browser sent one `session.ack` per binary frame.
4. GatewayHub relayed every ack and every realtime message.

This created a high-rate feedback loop of gateway frames plus browser acks.

## Why Request Volume Spiked

This is an engineering inference from the measured payload sizes and the current code path.

Approximate math on the failing screen:

- raw tmux capture: about 232,555 bytes
- gateway frame size: 16 KB max
- chunks per redraw: about 15
- poll frequency: 20 times/second

That yields about:

- about 300 gateway binary frames/second
- about 300 browser ack messages/second
- about 600 GatewayHub WebSocket messages/second before snapshot/resize noise

At that rate, a single stuck session can drive hundreds of thousands of Durable Object messages in a short period.

## Root Cause

Primary root cause:

- the gateway streamed OSC-8 hyperlink metadata captured from tmux instead of normalizing it away before diffing and snapshotting

Contributing factors:

- non-append changes forced full-screen redraws
- redraw polling was aggressive at `50ms`
- browser acking was one message per binary frame
- GatewayHub relayed realtime messages without batching or rate limiting
- there was no circuit breaker for pathological redraw sessions

## Immediate Fix

We fixed the gateway to strip OSC-8 hyperlink control sequences from both:

- the capture path used for streaming diffs
- the snapshot path used for initial/recovery renders

Measured result on the same Codex auth screen:

- before normalization: about 232,555 bytes
- after normalization: about 1,153 bytes

This removes the payload explosion that caused the redraw starvation and the message flood.

Release:

- gateway fix committed and tagged as `v0.0.19`

## Aftermath

- the staging droplet was upgraded to the fixed gateway build during investigation
- the pre-existing active Codex session did not survive the manual service restart used for deployment
- the reproduced validation session was cleaned up after confirmation
- a separate web-only fit fix was prepared to address right-edge line cropping in the browser terminal

## What We Propose Next

### Highest Priority

1. Batch or coalesce `session.ack` messages.
   One ack per binary frame is too expensive under bursty redraw conditions.

2. Add a per-session redraw circuit breaker in the gateway.
   If redraw payloads exceed a threshold repeatedly, degrade that session to a safer mode:
   snapshots only, slower polling, or temporary redraw suppression.

3. Make session output polling adaptive.
   The current fixed `50ms` cadence is too aggressive for pathological full-screen redraw workloads.

### Control-Plane / DO Hardening

4. Add per-session and per-gateway message-rate metrics.
   We should be able to answer:
   which session, which VPS, which gateway, what message type, what sustained rate.

5. Add rate-based alerts.
   At minimum:
   DO request threshold
   DO message-rate threshold
   abnormal ack-rate threshold

6. Add server-side protection for realtime relays.
   GatewayHub should be able to detect and shed or downgrade runaway sessions instead of relaying indefinitely.

### Product / UX

7. Prefer snapshot recovery over high-frequency redraw replay when reconnecting to large dynamic screens.

8. Improve terminal sizing validation in the web app.
   Long wrapped lines should never extend past the visible terminal viewport.

## Follow-Up Questions To Review

- Should browser acks move from per-frame to periodic cumulative sequence acking?
- Should the gateway drop redraw frequency for sessions whose changed bytes per second exceed a cap?
- Should GatewayHub maintain per-session message budgets and temporarily mute nonessential realtime traffic?
- Which Cloudflare usage thresholds should page us before cost becomes material?

## Status

- gateway hyperlink normalization fix: done
- release tag for gateway fix: done (`v0.0.19`)
- browser terminal fit guard: prepared separately
- ack batching / rate limiting / alerting: not yet implemented
