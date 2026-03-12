# GatewayHub Traffic Alerting

Date: 2026-03-12

## What Landed

`packages/control-plane/src/durables/GatewayHub.ts` now keeps lightweight in-memory rolling counters per gateway DO instance and per session for:

- gateway text events
- gateway binary terminal frames
- browser text messages
- browser `session.ack` messages
- DO fetch requests

The counters are exposed on the internal DO `GET /status` response under `traffic`, including:

- aggregate per-gateway counters and 10-second / 60-second rates
- a `realtime_events` view for websocket traffic only
- `hot_sessions`, sorted by the strongest runaway signal
- per-session frame, ack, and incoming-message totals/bytes

This is intentionally in-memory only. It resets on DO cold start/hibernation and is meant for fast detection, not long-term billing reconciliation.

## Default Thresholds

The control-plane Wrangler config now carries these defaults:

- `GATEWAY_HUB_GATEWAY_EVENT_RATE_WARN_PER_SEC = "400"`
- `GATEWAY_HUB_SESSION_RUNAWAY_RATE_WARN_PER_SEC = "200"`
- `GATEWAY_HUB_SESSION_ACK_RATE_WARN_PER_SEC = "120"`

These are set below the March 12, 2026 flood model:

- about 600 incoming GatewayHub messages/sec overall
- about 300 gateway frames/sec
- about 300 browser acks/sec

Setting any threshold to `0` disables that warning.

`GATEWAY_HUB_SESSION_MESSAGE_RATE_WARN_PER_SEC` is still accepted as a compatibility alias, but new config should use `GATEWAY_HUB_SESSION_RUNAWAY_RATE_WARN_PER_SEC`.

## Warning Logs

When thresholds are crossed, `GatewayHub` emits structured warning logs with stable event names:

- `gatewayhub.incoming_traffic_threshold_exceeded`
- `gatewayhub.session_traffic_threshold_exceeded`

The log payload includes `gatewayId`, `vpsId`, `sessionId` where available, plus 10-second and 60-second counts/bytes.

The gateway-level warning compares against websocket traffic only. It does not include HTTP fetch requests in the threshold calculation, although `traffic.incoming_events` still reports the broader total inbound count for debugging.

This is intentionally JSON-shaped because Cloudflare Workers Logs indexes structured log fields well, which makes filtering and grouping much easier.

## Cloudflare Guidance

Current Cloudflare docs to use for this setup:

- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Workers Query Builder: https://developers.cloudflare.com/workers/observability/query-builder/
- Durable Objects metrics and analytics: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- Notifications overview: https://developers.cloudflare.com/notifications/
- Available Notifications: https://developers.cloudflare.com/notifications/notification-available/

Relevant points from those docs as of March 12, 2026:

- Workers Logs can be queried in the Cloudflare dashboard and structured JSON logs are indexed by field.
- Query Builder can search Workers Logs, group by fields, and save reusable queries.
- Durable Object analytics are available in the dashboard and via GraphQL.
- Durable Object WebSocket message metrics appear in `durableObjectsPeriodicGroups`; for hibernated WebSocket flows, incoming WebSocket messages may instead appear in `durableObjectsInvocationsAdaptiveGroups`.
- Cloudflare Notifications supports usage-based billing notifications with product-specific thresholds, but the public docs do not enumerate Workers/Durable Objects as named products.

That last point is an inference from the current docs. Verify what products are exposed in your dashboard before relying on Notifications for Workers/DO usage paging.

## Recommended Alert Setup

1. Save a Query Builder query for `event = "gatewayhub.session_traffic_threshold_exceeded"`.
2. Group by `sessionId`, `gatewayId`, and `vpsId`.
3. Save a second query for `event = "gatewayhub.incoming_traffic_threshold_exceeded"`.
4. Add `$workers.durableObjectId` to the event view when debugging a specific DO instance.
5. If your account exposes Workers or Durable Objects under Usage Based Billing notifications, create a billing alert there as the coarse cost backstop.
6. If your account does not expose those products in Notifications, run a small external poller against Cloudflare GraphQL and page on:
   - sustained `durableObjectsPeriodicGroups` / `durableObjectsInvocationsAdaptiveGroups` request spikes
   - any appearance of the structured GatewayHub threshold events above

## Suggested Initial Thresholds

Use these as the first pass:

- DO usage/billing alert: page when the control-plane worker or Durable Objects exceed 2x normal hourly request volume
- GatewayHub incoming traffic: page on any sustained `gatewayhub.incoming_traffic_threshold_exceeded`
- Session runaway traffic: page on any sustained `gatewayhub.session_traffic_threshold_exceeded`
- Query Builder sanity check: alert on `browserAcks10s >= 100` or `gatewayFrames10s >= 150` even if the combined threshold has not fired yet

These are intentionally conservative. The March 12 flood should trip them quickly.

## Server-Side Cap Evaluation

I do not recommend adding a GatewayHub-side mute/budget cap in this slice.

Reason:

- the known root flood source was already fixed in the gateway
- ack batching and the existing gateway redraw breaker already reduce the main pathological loop
- a DO-side relay cap risks muting valid terminal recovery/replay traffic without enough semantic context

If warnings fire again after this change, the first low-risk cap to revisit is not a general output mute. It is a narrow safeguard on nonessential realtime control traffic, especially browser ack relays, with a short cooldown and explicit logging.
