# VibeCode – Implementation Plan: Milestone 2

## Context

M1 delivered: protocol JSON schemas, hand-written TS + Go types, and the full Go gateway daemon (WS client, tmux sessions, SSH keys, file transfer, health metrics, agent installers, self-update, systemd deploy).

M2 delivers the **control plane**: the Cloudflare Workers + Durable Objects layer that sits between the browser and the gateway. After M2, the gateway can be tested end-to-end against a real CP without the browser – the mock CP (`cmd/mockcp`) can be retired.

---

## What gets created

### `packages/control-plane/`

```
packages/control-plane/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── src/
│   ├── index.ts                  # Worker entry – request routing
│   ├── types.ts                  # Env bindings, shared types
│   ├── durables/
│   │   └── GatewayHub.ts         # Durable Object: one per gateway
│   ├── routes/
│   │   ├── auth.ts               # DO OAuth connect + callback + token refresh
│   │   ├── vps.ts                # VPS CRUD + power off/on
│   │   └── sessions.ts           # Session CRUD + WS terminal upgrade
│   ├── db/
│   │   ├── schema.ts             # D1 query helpers (typed wrappers)
│   │   └── migrations/
│   │       └── 0001_initial.sql  # Full initial schema
│   └── lib/
│       ├── do-api.ts             # DigitalOcean API client (typed)
│       ├── do-tokens.ts          # AES-GCM encrypt/decrypt for DO OAuth tokens
│       ├── ids.ts                # Nano ID generation
│       └── auth.ts               # Request auth (session cookie validation)
└── test/
    ├── gateway-hub.test.ts       # DO unit tests (miniflare)
    ├── vps.test.ts
    └── sessions.test.ts
```

---

## D1 Schema

```sql
-- Users
CREATE TABLE users (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_identities (
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL UNIQUE,
  verified_at INTEGER,
  PRIMARY KEY (user_id, email)
);

-- DigitalOcean OAuth tokens (one row per user).
-- access_token and refresh_token are AES-GCM encrypted at application layer
-- using DO_TOKEN_KEK wrangler secret. See lib/do-tokens.ts.
CREATE TABLE do_connections (
  user_id           TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_enc  TEXT    NOT NULL,   -- base64(iv || ciphertext)
  refresh_token_enc TEXT    NOT NULL,   -- base64(iv || ciphertext)
  token_key_version INTEGER NOT NULL DEFAULT 1,  -- for KEK rotation
  team_uuid         TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- VPS / Droplet records
CREATE TABLE vps (
  id                     TEXT    PRIMARY KEY,
  user_id                TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  droplet_id             INTEGER NOT NULL,
  region                 TEXT    NOT NULL,
  size                   TEXT    NOT NULL,
  ipv4                   TEXT,
  status                 TEXT    NOT NULL DEFAULT 'provisioning',
  provisioning_deadline_at INTEGER,     -- unix seconds; used by Scheduled Worker
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- Gateway daemon records (one per VPS)
CREATE TABLE gateways (
  id              TEXT    PRIMARY KEY,
  vps_id          TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  auth_token_hash TEXT    NOT NULL,   -- HMAC-SHA256(token, GATEWAY_TOKEN_SALT)
  version         TEXT,
  last_seen_at    INTEGER,
  connected       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Sessions (tmux sessions)
CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vps_id           TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  title            TEXT    NOT NULL,
  agent_type       TEXT    NOT NULL DEFAULT 'claude-code',
  workdir          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'starting',
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER
);

-- Authorized SSH keys (no private keys stored)
CREATE TABLE authorized_keys (
  id          TEXT    PRIMARY KEY,
  vps_id      TEXT    NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  fingerprint TEXT    NOT NULL,
  public_key  TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  key_type    TEXT    NOT NULL DEFAULT 'user',  -- user | support
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (vps_id, fingerprint)
);

CREATE INDEX idx_sessions_vps  ON sessions(vps_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_vps_user      ON vps(user_id);
```

**Delete safety**: all child tables carry `ON DELETE CASCADE` from `vps`. The VPS destroy handler marks the VPS as `deleting`, signals GatewayHub shutdown, deletes the cloud droplet first, then runs the explicit ordered delete transaction (authorized_keys → sessions → gateways → vps) only after cloud deletion succeeds.

---

## wrangler.toml bindings

```toml
name = "chatcode-cp"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "chatcode"
database_id = "..."   # fill after `wrangler d1 create chatcode`

[[kv_namespaces]]
binding = "KV"
id = "..."            # fill after `wrangler kv namespace create chatcode-kv`

[[durable_objects.bindings]]
name = "GATEWAY_HUB"
class_name = "GatewayHub"

[[migrations]]
tag = "v1"
new_classes = ["GatewayHub"]

[triggers]
crons = ["* * * * *"]   # Scheduled Worker: provisioning timeout check

[vars]
DO_CLIENT_ID = ""       # DigitalOcean OAuth app client ID (non-secret)

# Secrets (set via `wrangler secret put`):
# DO_CLIENT_SECRET      – DigitalOcean OAuth app secret
# JWT_SECRET            – signs session cookies
# GATEWAY_TOKEN_SALT    – HMAC salt for gateway auth token hashing
# DO_TOKEN_KEK          – AES-256 key for encrypting DO OAuth tokens (base64)
```

---

## Auth model

**Production / staging**: signed HttpOnly session cookie. On DO OAuth callback, the Worker:
1. Creates or looks up the user row in D1
2. Issues an HMAC-SHA256 session token (`HMAC(userId + expires, JWT_SECRET)`)
3. Sets `Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`

Every subsequent request validates the cookie before routing. No unauthenticated request reaches VPS/session routes.

**Local dev only**: set `AUTH_MODE=dev` in `wrangler.toml` vars. Worker accepts `X-Dev-User: <user_id>` header as identity, skipping cookie validation. This header is ignored unless `AUTH_MODE=dev`. There is no global "always pass" path in any environment.

---

## DO OAuth token security

DO `access_token` and `refresh_token` are encrypted at application layer using **AES-256-GCM** before being stored in D1:

```typescript
// lib/do-tokens.ts
async function encryptToken(plaintext: string, kek: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, encode(plaintext));
  return b64(concat(iv, enc));  // store: base64(iv || ciphertext)
}

async function decryptToken(stored: string, kek: CryptoKey): Promise<string> {
  const buf = decode(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  return decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, ct));
}
```

`DO_TOKEN_KEK` is a 256-bit key stored as a Wrangler secret (never in D1). `token_key_version` in `do_connections` enables future KEK rotation without forcing all users to reconnect.

---

## HTTP API

### DO OAuth
| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/do` | Redirect to DigitalOcean OAuth authorize URL |
| `GET` | `/auth/do/callback` | Exchange code → encrypt + store tokens → set session cookie |
| `POST` | `/auth/do/disconnect` | Delete DO tokens from D1 |

### VPS
| Method | Path | Description |
|---|---|---|
| `GET` | `/vps` | List user's VPS instances |
| `POST` | `/vps` | Create droplet + generate gateway credentials |
| `GET` | `/vps/:id` | VPS detail + health from D1 |
| `DELETE` | `/vps/:id` | Ordered delete + destroy droplet |
| `POST` | `/vps/:id/power-off` | Power off droplet |
| `POST` | `/vps/:id/power-on` | Power on droplet |

### Sessions
| Method | Path | Description |
|---|---|---|
| `GET` | `/vps/:id/sessions` | List sessions |
| `POST` | `/vps/:id/sessions` | Create session (relays `session.create` to gateway via DO) |
| `DELETE` | `/vps/:id/sessions/:sid` | End session |
| `GET` | `/vps/:id/sessions/:sid/snapshot` | Request and return terminal snapshot |
| `GET` | `/vps/:id/terminal?session_id=:sid` | WS upgrade → attach to GatewayHub |

### Gateway-facing
| Method | Path | Description |
|---|---|---|
| `GET` | `/gw/connect/:gateway_id` | WS upgrade for gateway → routed to GatewayHub |

---

## Gateway connect auth

Gateway URL format: `<CPURL>/<gateway_id>` (e.g. `wss://cp.chatcode.dev/gw/connect/gw-abc123`).

The gateway already sends `Authorization: Bearer <auth_token>`. The Worker:
1. Extracts `gateway_id` from the URL path
2. Looks up the `gateways` row by `gateway_id` in D1
3. Verifies bearer token with a **timing-safe** HMAC check:
   - compute `candidate = HMAC-SHA256(auth_token, GATEWAY_TOKEN_SALT)`
   - compare `candidate` to `auth_token_hash` using constant-time verification (no string `==`)
4. On match: upgrades to WebSocket, routes to `GATEWAY_HUB.get(env.GATEWAY_HUB.idFromName(gateway_id))`

No separate `X-Gateway-ID` header is needed. The gateway binary constructs its WS URL as `strings.TrimRight(GATEWAY_CP_URL, "/") + "/" + GATEWAY_ID` at startup.

---

## GatewayHub Durable Object

One DO instance per gateway, keyed by `gateway_id` via `idFromName`. This is the core of M2.

### WebSocket API mode

M2 uses the **standard Durable Object WebSocket API** (event listeners) for simpler pending-map and subscriber lifecycle logic. Hibernation mode is deferred until post-M2 optimization, after control-plane behavior is stable and benchmarked.

### State

```typescript
// In-memory (reset on DO cold start; gateway reconnect restores live state)
gatewaySocket: WebSocket | null

// sessionId → set of subscribed browser WebSockets
subscribers: Map<string, Set<WebSocket>>

// Pending commands awaiting gateway ack: request_id → resolver
pending: Map<string, {
  resolve: (ack: AckEvent) => void,
  reject:  (err: Error) => void,
  startedAt: number,      // Date.now()
  sourceSocket: WebSocket | null,  // browser WS to reply to, null for HTTP callers
}>

// Last heartbeat per browser WS (ms timestamp), for idle cleanup
lastActivity: Map<WebSocket, number>
```

### Gateway WS (`/gw/connect/:gateway_id`)

Validated upstream by Worker (auth check). On open: store socket, update `Gateway.connected = 1` and `last_seen_at` in D1.

On message (text):
- `gateway.hello` → update D1 `Gateway.version`; set `vps.status = 'active'` for this gateway's `vps_id` (idempotent: only transition when current status is `provisioning`)
- `gateway.health` → update D1 `Gateway.last_seen_at`
- `ack` → resolve or reject `pending[request_id]`; forward ack to `sourceSocket` if set
- `session.started` / `session.ended` / `session.error` → update D1 Session status; fan-out to `subscribers[session_id]`
- `session.snapshot` → fan-out to `subscribers[session_id]`
- `ssh.keys` / `file.content.*` / `agent.installed` / `gateway.updated` → forward via `pending[request_id].sourceSocket`
- malformed/invalid JSON text messages: log and ignore (gateway is trusted peer in M2)

On message (binary): enforce max payload size, decode `session_id` from frame header, fan-out raw bytes to every socket in `subscribers[session_id]` via `safeSend`.

On close: set `Gateway.connected = 0` in D1. Reject all entries in `pending` with `Error("gateway disconnected")`. Start 30s grace period; if not reconnected, mark gateway offline in D1.

### Browser WS (`/vps/:id/terminal?session_id=:sid`)

Validated upstream (session cookie). On open: add to `subscribers[session_id]`, record `lastActivity[ws] = Date.now()`, request snapshot from gateway via `sendCommand`.

On message from browser:
- `session.input`, `session.resize`, `session.ack`: update `lastActivity[ws]`; relay via `sendRealtime` (fire-and-forget, no pending map entry).
- Any stateful/browser-initiated command that requires command outcome (if introduced later) goes through `sendCommand`.
- malformed browser message policy: respond with structured error frame (`{type:"error", code:"invalid_payload", message:"..."}`) and keep socket open. Oversize payloads are rejected and socket is closed with policy violation code.

On close: remove from `subscribers[session_id]` and `lastActivity`.

**Idle cleanup** (scheduled interval via `setInterval` at DO startup, every 60s): close browser WebSockets where `Date.now() - lastActivity[ws] > 600_000` (10 minutes), then remove from maps.

### Command relay (`safeSend` + `sendRealtime` + `sendCommand`)

Two relay paths are used:

```typescript
function safeSend(ws: WebSocket, data: string | ArrayBufferLike | ArrayBufferView): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(data);
  } catch (err) {
    // best-effort fan-out; failures are isolated to this subscriber
    console.warn("ws send failed", err);
  }
}
```

1. **Realtime path (fire-and-forget, no ack tracking)**  
Used for high-frequency terminal traffic:
- `session.input`
- `session.resize`
- `session.ack`

```typescript
function sendRealtime(cmd: SessionInput | SessionResize | SessionAck): void {
  if (!gatewaySocket) throw new Error("gateway not connected");
  safeSend(gatewaySocket, JSON.stringify(cmd));
}
```

2. **Ack-tracked path (`pending` + timeout)**  
Used for stateful/observable commands:
- `session.create`
- `session.end`
- `session.snapshot`
- `ssh.authorize` / `ssh.revoke` / `ssh.list`
- `file.upload.begin` / `file.upload.chunk` / `file.upload.end` / `file.download` / `file.cancel`
- `agents.install`
- `gateway.update`

```typescript
async function sendCommand(
  cmd: AckTrackedCommand,
  sourceSocket: WebSocket | null = null,
  timeoutMs = 10_000,
): Promise<AckEvent> {
  if (!gatewaySocket) throw new Error("gateway not connected");

  return new Promise((resolve, reject) => {
    pending.set(cmd.request_id, { resolve, reject, startedAt: Date.now(), sourceSocket });

    // Timeout cleanup
    setTimeout(() => {
      if (pending.has(cmd.request_id)) {
        pending.delete(cmd.request_id);
        reject(new Error(`command ${cmd.request_id} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    safeSend(gatewaySocket, JSON.stringify(cmd));
  });
}
```

HTTP callers (VPS/session route handlers) call the DO via `stub.fetch("/cmd", { body })`, which internally calls `sendCommand` and awaits ack before returning a response.

### Keepalive

- Browser clients send periodic ping (~20s); GatewayHub replies pong.
- GatewayHub closes idle/missed-heartbeat browser sockets early in addition to 10-minute activity cleanup.
- Gateway socket liveness is still tracked via `gateway.health` and WS close events.

---

## VPS provisioning flow

```
POST /vps { region, size }
  1. Verify user has DO connection (D1)
  2. Generate: vps_id (nanoid), gateway_id (nanoid), auth_token (32 random bytes hex)
     Store auth_token_hash = HMAC-SHA256(auth_token, GATEWAY_TOKEN_SALT) in D1
  3. Build cloud-init userdata:
       GATEWAY_ID=<gateway_id>
       GATEWAY_AUTH_TOKEN=<auth_token_plaintext>
       GATEWAY_CP_URL=wss://cp.chatcode.dev/gw/connect
       GATEWAY_VERSION=<current_release_tag>
  4. Decrypt DO access_token from D1
  5. POST /v2/droplets to DO API
  6. Write VPS row (status='provisioning', provisioning_deadline_at=now+600) + Gateway row to D1
  7. Return { vps_id, status: 'provisioning' }
```

**Provisioning timeout** is handled by a Scheduled Worker (cron `* * * * *`), not by `waitUntil`. Every minute:

```sql
SELECT id FROM vps
WHERE status = 'provisioning'
  AND provisioning_deadline_at < unixepoch()
```

For each match, check `gateways.connected`. If still `0`, set `vps.status = 'provisioning_timeout'`. This is durable across Worker restarts and requires no in-memory state.

---

## VPS destroy flow

Ordered to avoid FK failures, prevent cloud-resource leaks, and close gateway WS cleanly before rows are removed:

```
DELETE /vps/:id
  1. Auth check: vps.user_id == authenticated user
  2. Mark vps.status = 'deleting' (keep metadata while cloud delete is in-flight)
  3. Signal GatewayHub DO to close gateway WS (stub.fetch("/shutdown"))
  4. Decrypt DO access_token from D1
  5. DELETE /v2/droplets/:droplet_id via DO API
  6. If droplet delete succeeded, D1 transaction:
       DELETE FROM authorized_keys WHERE vps_id = :id
       DELETE FROM sessions       WHERE vps_id = :id
       DELETE FROM gateways       WHERE vps_id = :id
       DELETE FROM vps            WHERE id = :id
  7. Return 204
```

If DO delete fails, rows are retained (status remains `deleting`) so cleanup can be retried safely by a Scheduled Worker reconciliation pass.

ON DELETE CASCADE is present as a safety net but the explicit ordered delete after successful cloud deletion is canonical.

---

## DO OAuth flow

```
GET /auth/do
  → generate state nonce (16 random bytes hex), store in KV (TTL 10 min)
  → redirect to https://cloud.digitalocean.com/v1/oauth/authorize?
      client_id=...&redirect_uri=...&scope=read+write&state=<nonce>

GET /auth/do/callback?code=...&state=...
  → validate state from KV (delete after use; reject if missing)
  → POST /v1/oauth/token to exchange code for tokens
  → encrypt access_token + refresh_token with DO_TOKEN_KEK (AES-GCM)
  → upsert do_connections row in D1
  → issue session cookie
  → redirect to /dashboard
```

Token refresh: called by VPS route handlers when DO API returns 401. Decrypts current refresh_token, exchanges for new tokens, re-encrypts and updates D1.

Race handling for concurrent refreshes (M2):
- Use a per-user in-memory `refreshInFlight` lock/map in the Worker isolate (best-effort; not cross-isolate/distributed).
- If a second request hits 401 while refresh is in progress, await the same promise instead of issuing another refresh request.
- If lock state is stale (isolate restart), retry once by reloading latest encrypted tokens from D1.
- Concurrent 401s handled by different Worker isolates may still race; fallback behavior is recoverable for MVP and intentionally accepted.

---

## Implementation order

1. **Scaffold** – `package.json`, `tsconfig.json`, `wrangler.toml`, `src/index.ts` (stub router)
2. **D1 migrations** – `0001_initial.sql` + `npm run migrate` scripts
3. **`db/schema.ts`** – typed D1 query helpers for every table
4. **`lib/do-tokens.ts`** – AES-GCM encrypt/decrypt for DO OAuth tokens
5. **`lib/auth.ts`** – session cookie sign/verify; gateway HMAC token check; `AUTH_MODE=dev` passthrough
6. **`lib/do-api.ts`** – DigitalOcean API client (droplet CRUD, power actions, token refresh)
7. **`routes/auth.ts`** – DO OAuth connect + callback + disconnect
8. **`routes/vps.ts`** – VPS create/list/get/destroy/power + provisioning flow
9. **`GatewayHub`** – gateway WS + safe fan-out + payload guards + malformed-frame policy + keepalive + `sendRealtime` + `sendCommand` (pending map + timeout) + idle cleanup + shutdown
10. **`routes/sessions.ts`** – session CRUD + WS terminal upgrade → GatewayHub subscriber
11. **Scheduled Worker** – provisioning timeout check + deleting-VPS reconciliation (cron every 1 min)
12. **Tests** – miniflare-based unit tests for DO, vps, sessions routes

---

## Key decisions

- **Gateway ID in URL path** – `GET /gw/connect/:gateway_id`; Worker extracts ID from path, no extra header needed. Gateway binary constructs URL as `GATEWAY_CP_URL + "/" + GATEWAY_ID`.
- **DO keyed by `gateway_id`** via `idFromName` – stable across VPS reprovisioning.
- **Auth token: plaintext in gateway env, HMAC hash in D1** – compromising D1 yields hashes only.
- **DO OAuth tokens: AES-GCM encrypted in D1 with Wrangler-secret KEK** – compromising D1 yields ciphertext only. `token_key_version` enables zero-downtime KEK rotation.
- **Standard DO WebSocket API for M2** – simpler lifecycle semantics for pending map and subscriber fan-out; hibernation optimization deferred.
- **Realtime relay is fire-and-forget** – `session.input` / `session.resize` / `session.ack` bypass pending map and timeout logic.
- **Pending map keyed by `request_id` for ack-tracked commands only** – deterministic ack routing; all pending entries rejected on gateway disconnect; 10s per-entry timeout.
- **Gateway token verification is timing-safe** – no direct string equality for HMAC comparison.
- **GatewayHub fan-out uses safe send semantics** – dead subscribers are isolated; one socket failure cannot break broadcast loops.
- **Payload guards are enforced on both WS directions** – oversized gateway/browser frames are rejected deterministically.
- **Malformed browser frames return structured errors** – no silent drops for browser-originated invalid payloads.
- **Keepalive (ping/pong) is explicit for browser sockets** – faster dead-connection detection than idle-timeout-only cleanup.
- **Provisioning timeout via Scheduled Worker + `provisioning_deadline_at`** – durable, survives Worker restarts, requires no in-memory state.
- **VPS becomes active on first successful gateway hello** – GatewayHub sets `vps.status = 'active'` (from `provisioning`) when `gateway.hello` arrives.
- **No DO persistent storage** – gateway resends snapshots on reconnect; all durable state lives in D1.
- **Auth: HttpOnly HMAC cookie in prod, `X-Dev-User` only when `AUTH_MODE=dev`** – no global auth bypass in any non-dev environment.
- **VPS delete is cloud-first, DB-second** – metadata is retained while droplet deletion is in-flight; DB rows are removed only after confirmed cloud deletion.
- **GatewayHub instance lifecycle is unmanaged by design** – DO instances may accumulate after VPS destroy (Cloudflare limitation), but with no DO storage this is accepted for MVP.

---

## Local dev setup

```bash
cd packages/control-plane

# First time
npx wrangler d1 create chatcode --local
npm run migrate          # applies migrations against local D1

# Dev server (emulates D1 + KV + DO locally via miniflare)
npm run dev              # wrangler dev --local

# Test against local CP with real gateway
cd ../gateway
GATEWAY_CP_URL=ws://localhost:8787/gw/connect \
  GATEWAY_ID=gw-dev \
  GATEWAY_AUTH_TOKEN=devtoken \
  ./gateway

# Auth in dev
# Set [vars] AUTH_MODE = "dev" in wrangler.toml (local only, not committed to prod config)
# Then pass X-Dev-User: <user_id> header in requests
```

---

## Testing strategy

- **Unit (vitest + miniflare)**: GatewayHub state transitions (`sendRealtime` vs `sendCommand`, pending map, safe fan-out, disconnect cleanup), payload-size guards, malformed-browser-frame errors, keepalive ping/pong behavior, D1 query helpers, DO API client (mock fetch), auth token/cookie sign/verify, AES-GCM encrypt/decrypt round-trip, refresh-lock race behavior
- **Integration (wrangler dev)**: full flow with real gateway binary connecting to local CP over WS; provision a VPS record manually, send session.create, verify output fan-out
- **E2E**: deploy to Cloudflare staging environment, provision a real DO droplet via cloud-init, verify full session lifecycle from browser → CP → gateway → tmux

---

## What M2 does NOT include

- Magic link auth (M3) – DO OAuth callback sets the session cookie; users reach it only after connecting DigitalOcean
- React web UI (M4)
- SSH key UI (M4)
- File transfer UI (M4)
- Telegram bot (Phase 2)
