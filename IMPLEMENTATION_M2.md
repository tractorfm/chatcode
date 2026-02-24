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
│   │   ├── auth.ts               # DO OAuth connect + callback + refresh
│   │   ├── vps.ts                # VPS CRUD + power off/on
│   │   └── sessions.ts           # Session CRUD + WS terminal upgrade
│   ├── db/
│   │   ├── schema.ts             # D1 query helpers (typed wrappers)
│   │   └── migrations/
│   │       └── 0001_initial.sql  # Full initial schema
│   └── lib/
│       ├── do-api.ts             # DigitalOcean API client (typed)
│       ├── ids.ts                # Nano ID generation
│       └── auth.ts               # Request auth (JWT cookie validation)
└── test/
    ├── gateway-hub.test.ts       # DO unit tests (miniflare)
    ├── vps.test.ts
    └── sessions.test.ts
```

---

## D1 Schema

```sql
-- Users (email added in M3; exists here so DO OAuth can create a user row)
CREATE TABLE users (
  id        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_identities (
  user_id    TEXT NOT NULL REFERENCES users(id),
  email      TEXT NOT NULL UNIQUE,
  verified_at INTEGER,
  PRIMARY KEY (user_id, email)
);

-- DigitalOcean OAuth tokens (one row per user)
CREATE TABLE do_connections (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  team_uuid     TEXT,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- VPS / Droplet records
CREATE TABLE vps (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  droplet_id INTEGER NOT NULL,
  region     TEXT NOT NULL,
  size       TEXT NOT NULL,
  ipv4       TEXT,
  status     TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Gateway daemon records (one per VPS)
CREATE TABLE gateways (
  id           TEXT PRIMARY KEY,
  vps_id       TEXT NOT NULL REFERENCES vps(id),
  auth_token   TEXT NOT NULL,       -- hashed; gateway uses plaintext in env
  version      TEXT,
  last_seen_at INTEGER,
  connected    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- Sessions (tmux sessions)
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  vps_id          TEXT NOT NULL REFERENCES vps(id),
  title           TEXT NOT NULL,
  agent_type      TEXT NOT NULL DEFAULT 'claude-code',
  workdir         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'starting',
  created_at      INTEGER NOT NULL,
  last_activity_at INTEGER
);

-- Authorized SSH keys (no private keys stored)
CREATE TABLE authorized_keys (
  id          TEXT PRIMARY KEY,
  vps_id      TEXT NOT NULL REFERENCES vps(id),
  fingerprint TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  label       TEXT NOT NULL,
  key_type    TEXT NOT NULL DEFAULT 'user',  -- user | support
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_authorized_keys_vps_fp ON authorized_keys(vps_id, fingerprint);
CREATE INDEX idx_sessions_vps ON sessions(vps_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_vps_user ON vps(user_id);
```

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

[vars]
DO_CLIENT_ID = ""         # DigitalOcean OAuth app client ID (non-secret)

# Secrets (set via `wrangler secret put`):
# DO_CLIENT_SECRET
# JWT_SECRET              # for signing session cookies
# GATEWAY_TOKEN_SALT      # for hashing gateway auth tokens
```

---

## HTTP API (Workers routing)

### DO OAuth
| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/do` | Redirect to DigitalOcean OAuth authorize URL |
| `GET` | `/auth/do/callback` | Exchange code → store token → set session cookie |
| `POST` | `/auth/do/disconnect` | Delete DO token from D1 |

### VPS
| Method | Path | Description |
|---|---|---|
| `GET` | `/vps` | List user's VPS instances |
| `POST` | `/vps` | Create droplet + generate gateway credentials |
| `GET` | `/vps/:id` | VPS detail + health from D1 |
| `DELETE` | `/vps/:id` | Destroy droplet + delete D1 records |
| `POST` | `/vps/:id/power-off` | Power off droplet |
| `POST` | `/vps/:id/power-on` | Power on droplet |

### Sessions
| Method | Path | Description |
|---|---|---|
| `GET` | `/vps/:id/sessions` | List sessions |
| `POST` | `/vps/:id/sessions` | Create session (relays `session.create` to gateway) |
| `DELETE` | `/vps/:id/sessions/:sid` | End session |
| `GET` | `/vps/:id/sessions/:sid/snapshot` | Request and return terminal snapshot |
| `GET` | `/vps/:id/terminal` | WS upgrade → attach to GatewayHub as subscriber |

### Internal (gateway-facing)
| Method | Path | Description |
|---|---|---|
| `GET` | `/gw/connect` | WS upgrade for gateway → routed to GatewayHub |

---

## GatewayHub Durable Object

One DO instance per gateway, keyed by `gateway_id`. This is the core of M2.

### State

```typescript
// In-memory (reset on DO restart)
gatewaySocket: WebSocket | null           // the gateway's WS
subscribers: Map<string, Set<WebSocket>>  // sessionId → browser WS clients
lastActivity: Map<string, number>         // clientWS → last heartbeat (ms)

// Durable storage (DO storage API)
// Not needed for MVP – gateway reconnects and resends snapshots
```

### Connections accepted

**Gateway WS** (`/gw/connect`, routed here by Worker):
- Validated upstream by Worker (auth token check against hashed token in D1)
- On open: store socket, update `Gateway.connected = 1`, `last_seen_at` in D1
- On text message: parse event type:
  - `gateway.hello` → update D1 `Gateway.version`
  - `gateway.health` → update D1 `Gateway.last_seen_at`, fan-out to any health subscriber
  - `session.started` / `session.ended` / `session.error` → update D1 Session status, notify subscriber
  - `session.snapshot` → send to matching session subscribers
  - `ack` → forward to originating subscriber (if tracked)
  - `ssh.keys` / `file.content.*` / `agent.installed` / `gateway.updated` → forward to subscriber
- On binary message: decode `session_id` from frame header, fan-out to `subscribers[session_id]`
- On close: `Gateway.connected = 0`; start 30s reconnect grace period before marking offline

**Web client WS** (`/vps/:id/terminal?session_id=...`, routed here by Worker):
- Validated upstream (session auth cookie)
- On open: add to `subscribers[session_id]`; request snapshot from gateway
- On text message from client (`session.input`, `session.resize`, `session.ack`) → forward to gateway WS
- On ping / any message: update `lastActivity[ws]`
- On close: remove from subscribers
- **Idle cleanup goroutine**: every 60s, close subscriber WS connections silent for > 10 minutes

### Command relay (CP → gateway)

All HTTP-triggered gateway commands (session.create, session.end, ssh.*, file.*) go through the DO:

```
Worker handler
  → DO stub.fetch("/cmd", { body: command JSON })
  → DO writes to gatewaySocket
  → returns ack or timeout error
```

Timeout: 10s. If no ack received, return 504 to caller.

### Provisioning timeout

When a VPS is created, Worker schedules a `waitUntil` that:
1. Waits 10 minutes for `gateway.hello` (polls D1 `Gateway.connected`)
2. If not received: sets `VPS.status = 'provisioning_timeout'`

---

## DO OAuth flow

```
User clicks "Connect DigitalOcean"
  → GET /auth/do
  → Worker generates state nonce, stores in KV (TTL 10 min)
  → Redirect to https://cloud.digitalocean.com/v1/oauth/authorize?
      client_id=...&redirect_uri=...&scope=read+write&state=...

DigitalOcean redirects to /auth/do/callback?code=...&state=...
  → Worker validates state from KV (delete after use)
  → POST https://cloud.digitalocean.com/v1/oauth/token (code exchange)
  → Store access_token + refresh_token in D1 do_connections
  → Redirect to /dashboard
```

Token refresh: called by VPS API handlers when DO API returns 401. Exchanges refresh_token for new access_token, updates D1.

---

## VPS provisioning flow

```
POST /vps { region, size }
  1. Verify user has DO connection (D1)
  2. Generate: vps_id, gateway_id, auth_token (random 32 bytes, store hash in D1)
  3. Build cloud-init userdata:
       GATEWAY_ID=<gateway_id>
       GATEWAY_AUTH_TOKEN=<auth_token_plaintext>  # written to /etc/chatcode/gateway.env
       GATEWAY_CP_URL=wss://cp.chatcode.dev/gw/connect
       GATEWAY_VERSION=<current_release_tag>
  4. POST /v2/droplets to DO API
  5. Write VPS + Gateway rows to D1 (status='provisioning')
  6. Return { vps_id, status: 'provisioning' }
  7. Background (waitUntil): poll for gateway.hello → timeout after 10 min
```

---

## Gateway auth

Gateways authenticate the WS upgrade with `Authorization: Bearer <auth_token>`.

The Worker:
1. Extracts gateway_id from a header (`X-Gateway-ID`) set by the gateway
2. Looks up `Gateway` in D1 by `gateway_id`
3. Compares `HMAC-SHA256(auth_token, GATEWAY_TOKEN_SALT)` against stored hash
4. On match: upgrades WS, routes to `GATEWAY_HUB.get(env.GATEWAY_HUB.idFromName(gateway_id))`

---

## Implementation order

1. **Scaffold** – `package.json`, `tsconfig.json`, `wrangler.toml`, `src/index.ts` (stub router)
2. **D1 migrations** – `0001_initial.sql` + migration runner
3. **`db/schema.ts`** – typed D1 query helpers for every table
4. **`lib/do-api.ts`** – DigitalOcean API client (droplet CRUD, power actions, token refresh)
5. **`lib/auth.ts`** – JWT session cookie sign/verify; gateway token hash check
6. **`routes/auth.ts`** – DO OAuth connect + callback + disconnect
7. **`routes/vps.ts`** – VPS create/list/get/destroy/power + provisioning flow
8. **`GatewayHub`** – gateway WS + subscriber fan-out + command relay + idle cleanup
9. **`routes/sessions.ts`** – session CRUD + WS terminal upgrade → GatewayHub subscriber
10. **Provisioning timeout** – `waitUntil` background check
11. **Tests** – miniflare-based unit tests for DO, vps, sessions routes

---

## Key decisions

- **DO keyed by `gateway_id`** (not vps_id) – gateway_id is stable, vps could be reprovisioned
- **Auth token as plaintext in gateway env, stored hashed in D1** – compromise of D1 doesn't yield usable tokens
- **No DO persistent storage** – gateway resends snapshots on reconnect; DO state is pure in-memory
- **Command relay via DO `fetch()`** – Workers call the DO as an HTTP stub; DO writes to gateway WS synchronously; ack is awaited with 10s timeout
- **Web terminal WS lives on the DO** – browser connects directly to the DO (via Worker upgrade), not to a separate WS server
- **Session auth via HttpOnly JWT cookie** – set at login (M3); validated in Worker before routing to DO; M2 stubs this with a placeholder that always passes for dev
- **Single region** – AMS3 for droplets; Workers/DO are global but accessed from AMS3 gateway

---

## Local dev setup

```bash
cd packages/control-plane

# First time
npx wrangler d1 create chatcode --local
npx wrangler d1 migrations apply chatcode --local

# Dev server (emulates D1 + KV + DO locally)
npm run dev     # wrangler dev --local

# Run gateway against local CP
cd ../gateway
GATEWAY_CP_URL=ws://localhost:8787/gw/connect \
  GATEWAY_ID=gw-dev \
  GATEWAY_AUTH_TOKEN=devtoken \
  ./gateway
```

For testing the gateway connection in dev, the auth middleware can be bypassed by checking `ENVIRONMENT=development` in `wrangler.toml` vars.

---

## Testing strategy

- **Unit (vitest + miniflare)**: GatewayHub state transitions, D1 query helpers, DO API client (mock fetch), auth token hashing
- **Integration (wrangler dev)**: full flow with real gateway binary connecting to local CP
- **E2E**: deploy to a Cloudflare staging environment, provision a real DO droplet, verify full session lifecycle

---

## What M2 does NOT include

- Magic link auth (M3) – M2 stubs auth with a dev passthrough
- React web UI (M4)
- SSH key UI (M4)
- File transfer UI (M4)
- Telegram bot (Phase 2)
