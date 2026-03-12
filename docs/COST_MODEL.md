# Cost Model

## Scope

This document estimates operating cost for the current chatcode MVP architecture on Cloudflare:

- `packages/control-plane` on Workers
- `GatewayHub` Durable Objects
- D1 for metadata
- R2 for release artifacts now, and potentially user file transfer later

It also gives a rough answer to:

- when the free tier breaks
- what active-user cost looks like after that
- whether file transfer should be paid-only

## Current Staging Observations

Observed staging usage as of March 12, 2026:

- Control-plane Worker (`chatcode-cp-staging`)
  - March 11–12: `69,691` requests, `907` subrequests, `0` errors
  - March 1–12: `92,346` requests, `2,405` subrequests, `11` errors
- Durable Objects dashboard (staging)
  - `315k` requests
  - `63.9k GB-s`

These numbers are from staging and are noisy. They are useful as an order-of-magnitude baseline, not as final production unit economics.

## Cloudflare Pricing References

### Workers

- Free plan:
  - `100,000 requests / day`
- Paid Standard:
  - `10 million requests / month included`
  - `+$0.30 / additional million requests`
  - `30 million CPU ms / month included`
  - `+$0.02 / additional million CPU ms`

### Durable Objects

- Free plan:
  - `100,000 requests / day`
  - `13,000 GB-s / day`
- Paid plan:
  - `1 million requests / month included`
  - `+$0.15 / million requests`
  - `400,000 GB-s included`
  - `+$12.50 / million GB-s`

### D1

- Free plan:
  - `5 million rows read / day`
  - `100,000 rows written / day`
- Paid plan:
  - first `25 billion` rows read / month included
  - `+$0.001 / million rows read`
  - first `50 million` rows written / month included
  - `+$1.00 / million rows written`

### R2

- Free tier:
  - `10 GB-month / month` storage
  - `1 million` Class A ops / month
  - `10 million` Class B ops / month
- Standard storage pricing:
  - `$0.015 / GB-month`
  - `$4.50 / million` Class A ops
  - `$0.36 / million` Class B ops
  - Internet egress free

## Working Assumption For User-Level Cost

The best simple assumption right now is:

- one **active user-month** is roughly comparable to the current staging usage footprint:
  - Worker: `~92k` requests / 12 days of testing
  - DO: `315k` requests and `63.9k GB-s`

That is aggressive for an MVP user, but it is a safe planning baseline.

For threshold estimates below, use:

- Worker requests per active user-day: about `7.7k`
  - `92,346 / 12`
- DO requests per active user-day: about `10.5k`
  - `315,000 / 30`
- DO duration per active user-day: about `2,130 GB-s`
  - `63,900 / 30`

The exact numbers will improve once production analytics are tagged per user or per VPS.

## When Free Tier Breaks

### Workers Free Tier

Workers Free allows `100,000 requests / day`.

At about `7.7k` Worker requests per active user-day:

- free-tier ceiling is about `12-13` active users at this usage level

Formula:

```text
100,000 / 7,700 ~= 12.9
```

### Durable Objects Free Tier

DO Free allows:

- `100,000 requests / day`
- `13,000 GB-s / day`

At about `10.5k` DO requests per active user-day:

- request ceiling is about `9` active users

At about `2,130 GB-s` per active user-day:

- duration ceiling is about `6` active users

Formula:

```text
100,000 / 10,500 ~= 9.5
13,000 / 2,130 ~= 6.1
```

### Conclusion

For the current architecture, the **first real free-tier bottleneck is Durable Object duration**, not Worker requests.

Practical answer:

- expect free-tier pain somewhere around **5-6 active users** if their behavior looks like current staging testing

That is the conservative answer.

If real production users are calmer than staging testers, the number will be higher.

## Paid-Tier Cost Per Active User

Using the same staging-derived baseline:

### Workers

Assume roughly `230k` Worker requests / active user-month:

```text
92,346 / 12 * 30 ~= 230,865
```

Marginal request cost:

```text
230,865 * $0.30 / 1,000,000 ~= $0.069
```

Worker CPU cost is unknown from this quick sample and is likely secondary unless the control-plane starts doing expensive per-request compute.

### Durable Objects

Requests:

```text
315,000 * $0.15 / 1,000,000 ~= $0.047
```

Duration:

```text
63,900 * $12.50 / 1,000,000 ~= $0.799
```

So DO cost per active user-month is roughly:

- `~$0.85`

### D1

Current metadata workload should be negligible compared with D1 paid included limits:

- first `25 billion` rows read / month included
- first `50 million` rows written / month included

For current MVP traffic, D1 is not the immediate cost concern.

### Combined Rough Estimate

Current rough estimate after included quotas are exhausted:

- `~$0.9 to $1.2` per active user-month

This is mainly:

- Durable Object duration
- then Worker requests

It excludes:

- the base Workers paid subscription minimum
- future log/analytics/export volume
- future file-transfer storage and operation costs

## Scaling Intuition

Using the conservative `~$1 / active user-month` heuristic:

- `100` active users: roughly `~$100/month` variable usage
- `1,000` active users: roughly `~$1,000/month`
- `10,000` active users: roughly `~$10,000/month`

This is only reasonable if DO duration per user stays close to the current baseline.

If DO duration grows materially because sessions stay hot too long, cost rises quickly.

## What Actually Matters

The primary cost metric to watch is:

- **Durable Object GB-s per active user-month**

Not:

- Worker request count
- D1 reads/writes

Those are second-order for the current product shape.

## File Transfer: Paid Only?

Short answer:

- **yes, paid-only at launch is reasonable**

### Why

Not because raw R2 cost is huge in normal usage. For moderate usage, R2 is cheap.

Example rough standard-storage cost for one user storing `1 GB` for a month with:

- `100` uploads
- `1,000` downloads

would be about:

- storage: `1 * $0.015 = $0.015`
- Class A: `100 / 1,000,000 * $4.50 = $0.00045`
- Class B: `1,000 / 1,000,000 * $0.36 = $0.00036`

Total:

- about `~$0.016`

### The real reasons to make it paid-only first

- abuse surface is much higher
  - arbitrary uploads
  - arbitrarily large downloads
  - bot/script misuse
- support and safety burden increases
  - malware
  - secrets leakage
  - accidental large transfers
- it creates a clean packaging distinction
  - terminals free
  - file transfer paid

### Recommendation

At launch:

- keep file transfer **paid-only**
- impose hard caps even for paid users:
  - max file size
  - max monthly transfer
  - max retained storage

Later, if needed:

- add a very small free allowance
  - for example tiny text uploads/downloads only

But MVP should keep it paid-only.

## Recommended Instrumentation

Before large-scale rollout, add per-user/per-VPS cost telemetry:

- Worker requests per user
- DO requests per VPS
- DO GB-s per VPS
- D1 reads/writes per request type
- future R2 Class A/Class B/storage per user

This should be enough to turn the rough `$1 / active user-month` heuristic into a real pricing model.

## Decision Summary

- Current architecture likely exceeds free-tier practicality around **5-6 active users** at staging-like intensity.
- Main cost driver is **Durable Object duration**.
- Rough marginal cost is about **`$0.9-$1.2` per active user-month** today.
- File transfer being **paid-only** at launch is a reasonable and defensible product decision.

## Sources

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
