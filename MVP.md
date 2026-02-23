# VibeCode MVP – Architecture & Plan (Revised)

This document reflects the revised MVP recommendations after a critical review.

---

## 0) One-sentence summary
VibeCode is a user-owned VPS agent platform: chatcode.dev provisions a user’s cloud VM via OAuth, installs a lightweight gateway daemon that manages tmux/PTY sessions, and exposes interactive terminal sessions over the web (Phase 1), then Telegram (Phase 2) and a Telegram Mini App (Phase 3).

---

## 1) MVP scope: intentionally smaller

### In scope (Phase 1)
- chatcode.dev web app (landing + email magic link auth)
- DigitalOcean OAuth + droplet provisioning (create / destroy / power off/on)
- Gateway daemon on the VPS (session management + raw terminal streaming)
- Minimal session model (one session = one workspace)
- Minimal file transfer (web ⇄ gateway via control plane relay, up to 20MB)
- SSH key management UI (user keys + time-limited support access)
- Health dashboard + offline UX
- Rate limits for auth
- Idle detection + notifications
- Operational excellence baseline (logging, versioning, upgrades)

### Explicitly out of scope for MVP
- Git subsystem (repo creation, deploy keys, UI wrapper)
- R2 file storage + signed URLs
- Multiple workspace instances per repo / advanced repo workflows

Rationale: keep the first release focused on “create VPS → open terminal → do work reliably”.

---

## 2) Architecture (high level)

### Components
1) **Web (chatcode.dev) – Cloudflare Pages**
- Landing page + email sign-in.
- Session UI + terminal (xterm.js).
- VPS dashboard + key management.

#### Landing page messaging (MVP)
- Headline: **“Vibe-code on your own cloud server”**
- Subheadline: “Use your existing ChatGPT, Claude, or Google AI subscription. No extra fees — just your VPS and your AI.”
- Key points (concise, above the fold):
  - “Bring your own AI subscription — works with Claude Code, Codex CLI, Gemini CLI”
  - “Your code runs on your own VPS, not ours”
  - “One-click setup via DigitalOcean. Terminal in your browser in minutes.”
- CTA: **Continue with email**

2) **Control Plane – Cloudflare Workers + Durable Objects + D1 + KV**
- Workers API:
  - auth, DO OAuth callbacks
  - session CRUD
  - proxy/control endpoints for gateway
- Durable Objects:
  - **one DO per gateway**: persistent WS terminus + fan-out hub
- D1:
  - users, identities, VPS, gateway, sessions, authorized keys, activity timestamps
- KV:
  - magic link tokens and rate-limit counters (TTL)

3) **Gateway daemon (on user VPS) – Go**
- systemd service, static binary.
- Manages tmux/PTY sessions.
- Maintains persistent WebSocket to its Gateway DO.
- Implements:
  - raw terminal streaming
  - session lifecycle
  - file upload/download to workspace
  - SSH authorized_keys management
  - idle cleanup policy
  - installer hooks for terminal agents (Claude Code / Codex CLI / Gemini CLI)

---

## 3) Security model (revised SSH approach)

### No private SSH keys stored in control plane
- Control plane **must not** store private SSH keys.
- Compromise of CP should not imply shell access to user VPS.

### Four access levels
1) **Primary**: gateway WebSocket (always).
2) **User SSH**: user provides a public key in UI → gateway appends to `~vibe/.ssh/authorized_keys`.
3) **Support SSH (opt-in, time-limited)**: user presses "Grant support access" → gateway appends a predefined support public key with auto-expiry (e.g., 24h). User can revoke manually at any time.
4) **Emergency**: DigitalOcean Console / Recovery (always available, no setup needed).

### VPS user
- Linux user `vibe`.
- passwordless sudo allowed (accepted MVP risk), with logging to file.

---

## 4) Session model (simplified)

- MVP merges “workspace” and “workspace instance” into **Session**.
- One session = one tmux session = one terminal.
- Limit: **max 5 concurrent sessions** per VPS (MVP).
- On session start, gateway writes an agent instruction file in the session workdir:
  - `CLAUDE.md` (Claude Code)
  - `AGENTS.md` (generic fallback)
  The content comes from `agent_config` in `session.create` + standard safety and workflow rules.
- Default agent templates are **embedded in the gateway binary** at compile time.
- `agent_config` field in `session.create` can override or extend defaults (e.g., user-specific instructions).
- Later: user-editable templates via UI.

---

## 5) File transfer (without R2)

### Web
- Drag & drop → upload to control plane → relay to gateway → write into session working directory.
- Download → gateway → relay to control plane → browser.
- **No file persistence** in control plane.
- MVP file size limit: **20MB** (honest limit to avoid edge cases on Workers/DO).
- Implementation:
  - default chunk size: **128KB**
  - bounded in-flight chunks: **4**
  - max total upload time: **5 minutes** (cancel on timeout)
  - client and gateway both enforce; CP proxies chunks without buffering the whole file

### Telegram (Phase 2)
- Telegram natively handles file upload/download.
- Bot downloads via Bot API and relays to gateway; reverse for downloads.

Evolution note (expected, not emergency):
- For larger files / higher load, move to **R2** (signed upload URL → gateway downloads directly) or a direct tunnel.

---

## 6) Durable Objects / WebSocket topology

- Gateway holds **one persistent WS** to its Gateway DO.
- Web clients connect to control plane and are attached/subscribed to sessions via the same Gateway DO.

### Why per-gateway DO
- centralizes connection state
- enables fan-out
- supports reconnection behavior and health/offline status

---

## 7) Protocol (CP ↔ Gateway)

### Versioning
- Every message includes `schema_version` (e.g. "1").
- Shared protocol defined as **JSON Schema** (generate TS + Go types).

### Frames
- **Text frames**: JSON control/events
- **Binary frames**: raw terminal output, multiplexed by session_id

#### Binary output frame (MVP)
- `kind` (1 byte): `0x01` terminal output
- `session_id` (4 bytes uint32 BE)
- `seq` (4 bytes uint32 BE)
- `payload` (remaining): raw PTY bytes

### Reliability
- Client sends periodic `ack {session_id, seq}` (text frame) for last received seq.
- Reconnect: **gateway** generates the snapshot (via tmux `capture-pane` / screen dump — it is the source of truth closest to PTY). The snapshot is sent as a text frame `session.snapshot {rows, cols, text}` and proxied through the DO to the web client before resuming live binary bytes.

### Backpressure & batching
- Gateway batches output (20–100ms).
- Bounded buffer + “latest wins” drop policy under load.

### Commands (cloud → gateway) – JSON
- `session.create {schema_version, session_id, tmux_name, agent_type, workdir, agent_config?}`
- `session.input {schema_version, session_id, data}`
- `session.resize {schema_version, session_id, cols, rows}`
- `session.end {schema_version, session_id}`
- `session.ack {schema_version, session_id, seq}` (web client → CP → gateway; CP/DO proxies transparently, gateway is source of truth for seq state)

- `ssh.authorize {schema_version, public_key, label, expires_at?}`
- `ssh.revoke {schema_version, fingerprint}`
- `ssh.list {schema_version}`

- `file.upload.begin {schema_version, session_id, filename, dest_path, size}`
- `file.upload.chunk {schema_version, upload_id, seq, data_b64}`
- `file.upload.end {schema_version, upload_id}`

- `file.download {schema_version, session_id, path}`

### Events (gateway → cloud) – JSON
- `gateway.hello {schema_version, gateway_id, version}`
- `gateway.health {schema_version, gateway_id, cpu, mem, disk, uptime, last_activity_at}`
- `gateway.offline {schema_version, gateway_id, since}` (emitted by CP when WS lost)

- `session.started {schema_version, session_id}`
- `session.ended {schema_version, session_id, reason}`
- `session.error {schema_version, session_id, error}`
- `session.snapshot {schema_version, session_id, cols, rows, text}`

- `ssh.keys {schema_version, keys:[{fingerprint,label,type,added_at,expires_at?}]}`

- `file.content.begin {schema_version, download_id, filename, size}`
- `file.content.chunk {schema_version, download_id, seq, data_b64}`
- `file.content.end {schema_version, download_id}`
- `file.error {schema_version, session_id, error}`

Note: file transfer is chunked to avoid large frame limits.

TODO (optimization): file chunks currently use base64 in JSON text frames (~33% overhead). Future improvement: add binary frame `kind: 0x02 = file chunk` to eliminate encoding overhead for large transfers.

---

## 8) Data model (D1)

### Identities
- `User(id, created_at)`
- `EmailIdentity(user_id, email, verified_at)`

### Ephemeral auth (KV)
- Magic link tokens (short TTL)
- Rate limit counters (TTL)

### DigitalOcean
- `DOConnection(user_id, access_token, refresh_token, team_uuid, expires_at)`

### VPS / Gateway
- `VPS(id, user_id, droplet_id, region, size, ipv4, status, created_at)`
- `Gateway(id, vps_id, gateway_id, version, last_seen_at, connected)`

### Sessions
- `Session(id, user_id, vps_id, title, agent_type, tmux_name, workdir, status, created_at, last_activity_at)`

### Authorized SSH keys (no private keys)
- `AuthorizedKey(id, vps_id, fingerprint, public_key, label, type[user|admin], expires_at, created_at)`

---

## 9) Critical flows (must-have)

### 9.1 VPS Destroy
- Button “Destroy VPS” + explicit confirmation.
- Calls DO API delete droplet.
- Cleans D1 records (VPS, Gateway, Sessions, AuthorizedKeys).

### 9.2 VPS Power Off / On
- Button "Power Off" with confirmation.
- Calls DO API power\_off action.
- Update `VPS.status` in D1.
- Gateway disconnects (expected); CP marks gateway as offline.
- UI shows "VPS powered off" with "Power On" button.
- Power On: DO API power\_on → gateway reconnects → sessions resume (tmux survives reboot if within DO’s power-off window; otherwise user restarts sessions).

UI copy: "Compute billing stops. Storage and reserved IP continue to be billed. To stop all charges, destroy the droplet."

### 9.3 VPS idle detection + notification
- Gateway reports `last_activity_at`.
- If no activity > 24h: notify user (email/web).
- Offer actions: Power Off (DO API) or keep running.

### 9.4 Session lifecycle (no auto-kill)
- tmux sessions are effectively free when idle; MVP does **not** auto-kill sessions.
- UX goal is cleanliness:
  - sessions with no activity > 24h are **auto-archived in UI** (moved to an “inactive” section)
  - if inactive sessions exceed a threshold (e.g., >10), UI collapses them by default
- Actual kill:
  - only by explicit user action, or
  - on VPS destroy.


### 9.5 Auth rate limiting
- Magic link sends: max 5/hour per email.
- IP-based: 20/hour.
- Implemented via KV counters.

### 9.6 Gateway offline UX
- UI shows status: connected / reconnecting / offline.
- If offline > 30s: banner + “Retry connection”.
- UI remains usable for browsing history/config.
- **WS idle cleanup**: DO disconnects web subscribers after **10 minutes** without client heartbeat (ping/input). Prevents stale connections from accumulating on the Durable Object.

### 9.7 Minimal health dashboard
- Gateway connected state.
- CPU/RAM/Disk from `gateway.health`.
- VPS power state from DO API.
- Uptime.

---

## 10) Provisioning (DigitalOcean)

- DO OAuth (Workers).
- Create droplet (AMS3 + size picker).
- cloud-init `user_data`:
  - create `vibe` user + sudo
  - install tmux + dependencies
  - install gateway binary + systemd unit
  - register gateway to CP via one-time bootstrap token

### Provisioning timeout handling
- After droplet creation, CP waits for `gateway.hello` within **10 minutes**.
- If not received: mark VPS status as `provisioning_timeout`.
- UI shows: "VPS provisioning timed out" with options:
  - **Retry** (destroy + recreate droplet)
  - **Check DO Console** (link to DigitalOcean dashboard)
- Avoids user stuck on "Provisioning…" screen indefinitely.

---

## 11) Tech stack

- **Control plane**: TypeScript (Cloudflare Workers, Durable Objects)
- **Web**: React + Vite + Tailwind CSS + shadcn/ui (Cloudflare Pages)
- **Gateway daemon**: Go (static binary)
- **Protocol**: JSON Schema → codegen for TS + Go
- **DB**: D1
- **KV**: magic links + rate limits
- **Queues**: later for Telegram/webhook processing

---

## 12) Implementation plan (re-scoped)

### Milestone 1 – Protocol + Gateway (Go)
- JSON Schema definitions for all commands/events (source of truth).
- Codegen: TS types + Go types from schemas.
- Gateway scaffold:
  - WS client to per-gateway DO (with mock CP for testing).
  - tmux/PTY session manager.
  - Raw stream output + input + resize.
  - Snapshot-on-reconnect.
  - ssh.authorize/revoke/list.
  - File upload/download chunking.
  - Idle tracking.
  - Agent installers (Claude/Codex/Gemini) as scripts.
  - Updates: download new binary + restart + rollback (keep previous).
  - systemd unit file + cloud-init install script.

### Milestone 2 – Control plane core
- D1 schema + migrations.
- DO OAuth connect + token refresh.
- VPS create / destroy / power off/on.
- Provisioning timeout handling (10 min wait for `gateway.hello`).
- Gateway DO per gateway (WS terminus + state).
- Session CRUD.
- WS idle cleanup (10 min without client heartbeat).

### Milestone 3 – Web foundation (static landing + auth)
- **Static landing page** on Pages (minimal hero + CTA “Continue with email”).
- Magic link auth (KV token + D1 user/email).
- Rate limiting (KV counters).
- Note: this is a standalone static page; Milestone 4 replaces it with the full SPA.

### Milestone 4 – Web app MVP (React + Vite + shadcn/ui)
- VPS dashboard (status + health + power actions).
- Session list + create + terminal view (xterm.js).
- Gateway status indicator + offline UX.
- SSH keys UI (add/remove + grant support access).
- File drag&drop UI (≤20MB).
- Idle notification banner.

### Phase 2 – Telegram bot
- Workers webhook + Queues.
- Topics in private chats; bind topic → session.
- File relay via Telegram API.

### Phase 3 – Mini App
- Open a session from Telegram into embedded web terminal.

---

## 13) Operational excellence (baseline)
- Structured logs everywhere + correlation ids (user_id, vps_id, session_id, gateway_id).
- Signed gateway releases.
- Semver for gateway + schema_version for protocol.
- Safe deploys for CP via Wrangler environments.

---

## 14) Deferred
- Git subsystem UI (repo creation, deploy keys, templates).
- R2-backed file storage (expected evolution for larger files/high load).
- Multi-droplet UI.
- Advanced prompt parsing → Telegram buttons.
- Harden sudo policy (replace unrestricted sudo with safer admin helper).

