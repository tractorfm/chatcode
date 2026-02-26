# VibeCode – Implementation Plan

## Tech decisions (confirmed)
- **Web**: React + Vite + Tailwind CSS + shadcn/ui (Cloudflare Pages)
- **Control plane**: TypeScript (Cloudflare Workers + Durable Objects)
- **Gateway**: Go (static binary, systemd)
- **Repo**: monorepo
- **Start with**: Milestone 1 (Protocol + Gateway)

---

## Monorepo structure

```
vibecode/
├── packages/
│   ├── protocol/              # Shared protocol definitions
│   │   ├── schema/            # JSON Schema files (source of truth)
│   │   │   ├── commands.json  # cloud → gateway commands
│   │   │   ├── events.json    # gateway → cloud events
│   │   │   └── frames.json    # binary frame format docs
│   │   ├── ts/                # Generated TS types (npm package)
│   │   │   └── src/
│   │   │       └── index.ts
│   │   └── go/                # Generated Go types
│   │       └── protocol.go
│   │
│   ├── control-plane/         # Cloudflare Workers + DO
│   │   ├── src/
│   │   │   ├── index.ts       # Worker entry
│   │   │   ├── durables/
│   │   │   │   └── gateway-hub.ts  # Durable Object per gateway
│   │   │   ├── routes/
│   │   │   ├── db/
│   │   │   │   ├── schema.sql
│   │   │   │   └── migrations/
│   │   │   └── services/
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   ├── web/                   # React + Vite + Tailwind + shadcn/ui
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   │   └── ui/        # shadcn/ui components (copied, not installed)
│   │   │   └── lib/
│   │   ├── tailwind.config.ts
│   │   ├── components.json    # shadcn/ui config
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── gateway/               # Go binary
│       ├── cmd/
│       │   └── gateway/
│       │       └── main.go
│       ├── internal/
│       │   ├── ws/            # WebSocket client to CP
│       │   ├── session/       # tmux/PTY session manager
│       │   ├── files/         # file upload/download handler
│       │   ├── ssh/           # authorized_keys manager
│       │   ├── agents/        # agent installer scripts
│       │   ├── health/        # system metrics collector
│       │   ├── config/        # configuration + agent templates
│       │   └── service/       # service manager abstraction (systemd / launchd)
│       ├── scripts/
│       │   ├── install-claude-code.sh
│       │   ├── install-codex.sh
│       │   └── install-gemini.sh
│       ├── templates/
│       │   ├── CLAUDE.md      # default Claude Code instructions
│       │   └── AGENTS.md      # generic agent instructions
│       ├── go.mod
│       ├── go.sum
│       ├── Makefile
│       └── Dockerfile         # for cross-compilation / CI
│
├── package.json               # workspace root (pnpm/npm workspaces)
├── pnpm-workspace.yaml
├── turbo.json                 # optional: turborepo for build orchestration
└── README.md
```

---

## Milestone 1 – Protocol + Gateway (Go): breakdown

Gateway is the core — everything else depends on it. Build and test it against a mock CP first.

### Step 1: Project scaffold + WebSocket client
- `go mod init github.com/vibecode/vibecode/packages/gateway`
- Basic config: CP URL, gateway ID, auth token (from env / config file)
- WebSocket client with:
  - connect to CP URL
  - auto-reconnect with exponential backoff
  - serialized write path for WS sends (single writer lock/outbox)
  - inbound message size limits (read limit + command frame cap)
  - send `gateway.hello` on connect (include `system_info: {os, arch, cpus, ram_total, disk_total}`)
  - send `gateway.health` on interval (30s)
  - receive and dispatch JSON text frames by command type
  - receive and dispatch binary frames
- malformed command handling policy:
  - if `request_id` is present and payload is invalid, return `ack(ok=false,error=...)`
  - if payload is malformed and request_id cannot be extracted, log + drop
- **Test**: mock WS server in Go tests; verify hello/health/reconnect, oversize frame rejection, and concurrent send safety

### Step 2: Session manager (tmux/PTY)
- `session.create` → start tmux session with given name + workdir
  - write agent instruction file (CLAUDE.md / AGENTS.md) into workdir before starting
  - launch agent CLI inside tmux
- `session.input` → inject keystrokes into tmux pane (`tmux send-keys`)
- `session.resize` → resize tmux window (`tmux resize-window`)
- `session.end` → graceful-then-force termination (do not assume one `tmux kill-session` always succeeds):
  - attempt graceful stop first
  - poll for exit (500ms interval, up to 3s)
  - escalate to force kill if still alive
- PTY output capture:
  - read from tmux pipe-pane or PTY directly
  - batch into binary frames (kind=0x01, session_id, seq, payload)
  - 20-100ms batching interval
  - bounded buffer with "latest wins" drop
- `session.snapshot` generation:
  - `tmux capture-pane -p` → text content
  - send as JSON text frame on reconnect or on demand
- **Test**: spin up tmux sessions, inject input, verify output capture; test snapshot; test `session.end` escalation behavior

### Step 3: SSH key management
- `ssh.authorize` → append public key to `~vibe/.ssh/authorized_keys` with comment label
  - if `expires_at` set, schedule removal (goroutine timer or cron-style check)
- `ssh.revoke` → remove key by fingerprint from `authorized_keys`
- `ssh.list` → parse `authorized_keys`, return list with fingerprints/labels
- **Test**: unit tests with temp authorized_keys file

### Step 4: File transfer
- `file.upload.begin` → create temp file, allocate upload state
- `file.upload.chunk` → write chunk to temp file (verify seq order)
- `file.upload.end` → move temp file to dest_path, cleanup state
- `file.download` → read file, send `file.content.begin/chunk/end` back
- Limits: 20MB max, 128KB chunks, 5min timeout, cancel support
- **Test**: upload/download roundtrip with mock WS

### Step 5: Health + idle tracking
- Collect CPU/RAM/disk metrics via `gopsutil` (cross-platform: Linux + macOS ready)
- Track `last_activity_at` per session (updated on input/output)
- Report in `gateway.health` events
- **Test**: verify metrics collection

### Step 6: Agent installers
- Shell scripts for Claude Code, Codex CLI, Gemini CLI
- Gateway calls scripts on `agents.install` command
- Verify agent is available in PATH after install
- **Test**: run installers on a test VM / Docker container

### Step 7: Self-update mechanism
- On `gateway.update` command:
  - download new binary from release URL (verify checksum/signature)
  - save as `gateway.new` alongside current binary
  - rename: current → `gateway.prev`, new → current
  - signal systemd to restart (`systemctl restart vibecode-gateway`)
  - if new version fails health check → rollback to `gateway.prev`
- **Test**: simulate update + rollback

### Step 8: Service integration (systemd + launchd abstraction)
- Unit file: `vibecode-gateway.service`
  - `Type=simple`
  - `Restart=on-failure`
  - `RestartSec=5`
  - `User=vibe`
  - `WorkingDirectory=/home/vibe`
  - `EnvironmentFile=/etc/vibecode/gateway.env`
- **macOS (roadmap)**: launchd plist `com.vibecode.gateway.plist` (same config, different format).
- Abstract service install/uninstall behind an interface so both backends share the same gateway code.
- Install scripts exist for Linux:
  - `packages/gateway/deploy/cloud-init.sh` (provisioning path)
  - `packages/gateway/deploy/gateway-install.sh` (manual/BYO-style staging path; `manual-install.sh` is a wrapper alias)
- Cleanup script: `packages/gateway/deploy/gateway-cleanup.sh` (service/binary/config/user cleanup).
- **Test**: deploy to a real DO droplet, verify service lifecycle

---

## Protocol package: first step

Before gateway code, define the protocol. This unblocks both Go and TS sides.

### Approach
1. Write JSON Schema files for all commands and events
2. Use codegen:
   - TS: `json-schema-to-typescript` → `packages/protocol/ts/src/`
   - Go: `go-jsonschema` or hand-write (small enough for MVP)
3. Binary frame format: document in `frames.json`, implement manually in Go + TS

### Priority order
1. `gateway.hello`, `gateway.health` (need for Step 1)
2. `session.create/started/input/end/ended/error/ack` + binary frame (need for Step 2)
3. `session.snapshot` (need for Step 2)
4. `ssh.*` (need for Step 3)
5. `file.*` (need for Step 4)

---

## Testing strategy

### Gateway
- **Unit tests**: each package (`ws`, `session`, `ssh`, `files`, `health`) independently
- **Integration test**: mock WS server + real tmux sessions on Linux (CI needs tmux)
- **E2E test**: deploy to a DO droplet, run full flow

### Mock CP for gateway development
- Simple Go WebSocket server that:
  - accepts `gateway.hello`
  - responds to commands manually (CLI or scripted)
  - logs all events and binary frames
- This unblocks gateway development before CP is built

---

## Next concrete step

**Start with**: `packages/protocol/` (JSON schemas) + `packages/gateway/` scaffold (Step 1: WS client + hello/health).

Ready to begin coding when you are.
