/**
 * GatewayHub Durable Object – one per gateway, keyed by gateway_id via idFromName.
 *
 * Core of M2: WS terminus for both gateway and browser clients.
 * Routes commands, fans out terminal output, tracks pending acks.
 *
 * Uses DO WebSocket hibernation API so long-lived sockets do not pin CPU.
 */

import type { Env } from "../types.js";
import type {
  Ack,
  GatewayHello,
  GatewayHealth,
  SessionStarted,
  SessionEnded,
  SessionError,
  SessionSnapshotEvent,
  SSHKeyList,
  AgentsStatus,
  WorkspaceFolders,
  FileContentBegin,
  FileContentChunk,
  FileContentEnd,
  AgentInstalled,
  GatewayUpdated,
} from "@chatcode/protocol";
import { decodeTerminalFrame } from "@chatcode/protocol";
import {
  updateGatewayConnected,
  updateGatewayVersion,
  updateGatewayLastSeen,
  updateGatewaySystemInfo,
  updateSessionStatus,
} from "../db/schema.js";

const MAX_BINARY_PAYLOAD = 64 * 1024; // 64 KB
const MAX_TEXT_PAYLOAD = 1024 * 1024; // 1 MB
const COMMAND_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 600_000; // 10 minutes
const GRACE_PERIOD_MS = 30_000; // 30s reconnect grace
const SESSION_RECONCILE_END_GRACE_MS = 90_000; // avoid ending sessions right after reconnect
const SESSION_CONTROL_LEASE_MS = 30_000; // lock input/resize source for 30s since last write
const TRAFFIC_BUCKET_MS = 10_000;
const TRAFFIC_BUCKET_COUNT = 6;
const TRAFFIC_SHORT_WINDOW_MS = 10_000;
const TRAFFIC_LONG_WINDOW_MS = TRAFFIC_BUCKET_MS * TRAFFIC_BUCKET_COUNT;
const TRAFFIC_WARN_COOLDOWN_MS = 60_000;
const SESSION_TRAFFIC_RETENTION_MS = 30 * 60_000;
const MAX_HOT_SESSIONS = 5;
const DEFAULT_GATEWAY_EVENT_RATE_WARN_PER_SEC = 400;
const DEFAULT_SESSION_RUNAWAY_RATE_WARN_PER_SEC = 200;
const DEFAULT_SESSION_ACK_RATE_WARN_PER_SEC = 120;

interface PendingEntry {
  resolve: (result: GatewayCommandResult) => void;
  reject: (err: Error) => void;
  startedAt: number;
  sourceSocket: WebSocket | null;
}

interface BrowserAckEntry {
  ws: WebSocket;
  timeout: ReturnType<typeof setTimeout>;
}

interface SessionController {
  ws: WebSocket;
  lastWriteAt: number;
}

interface SocketAttachment {
  role: "gateway" | "browser";
  sessionId?: string;
  expectedGatewayId?: string;
  gatewayId?: string;
  vpsId?: string;
}

interface TrafficBucket {
  startedAtMs: number;
  count: number;
  bytes: number;
}

interface TrafficCounterSnapshot {
  total_count: number;
  total_bytes: number;
  last_10s_count: number;
  last_10s_bytes: number;
  last_minute_count: number;
  last_minute_bytes: number;
  rate_10s: number;
  rate_60s: number;
}

interface SessionTrafficSnapshot {
  session_id: string;
  active_subscribers: number;
  last_seen_at: string | null;
  gateway_events: TrafficCounterSnapshot;
  gateway_frames: TrafficCounterSnapshot;
  browser_messages: TrafficCounterSnapshot;
  browser_acks: TrafficCounterSnapshot;
  incoming_events: TrafficCounterSnapshot;
  runaway_signal: TrafficCounterSnapshot;
}

type GatewayEvent =
  | GatewayHello
  | GatewayHealth
  | Ack
  | SessionStarted
  | SessionEnded
  | SessionError
  | SessionSnapshotEvent
  | SSHKeyList
  | AgentsStatus
  | WorkspaceFolders
  | FileContentBegin
  | FileContentChunk
  | FileContentEnd
  | AgentInstalled
  | GatewayUpdated;

type GatewayCommandResult =
  | Ack
  | SessionSnapshotEvent
  | SSHKeyList
  | AgentsStatus
  | WorkspaceFolders
  | AgentInstalled
  | GatewayUpdated;
type GatewayCommandEvent = SSHKeyList | AgentsStatus | WorkspaceFolders | AgentInstalled | GatewayUpdated;

class RollingTrafficCounter {
  private buckets: TrafficBucket[] = Array.from({ length: TRAFFIC_BUCKET_COUNT }, () => ({
    startedAtMs: 0,
    count: 0,
    bytes: 0,
  }));
  private totalCount = 0;
  private totalBytes = 0;

  record(bytes: number, nowMs: number): void {
    const bucketStart = Math.floor(nowMs / TRAFFIC_BUCKET_MS) * TRAFFIC_BUCKET_MS;
    const bucketIndex = Math.floor(bucketStart / TRAFFIC_BUCKET_MS) % TRAFFIC_BUCKET_COUNT;
    const bucket = this.buckets[bucketIndex];
    if (bucket.startedAtMs !== bucketStart) {
      bucket.startedAtMs = bucketStart;
      bucket.count = 0;
      bucket.bytes = 0;
    }

    bucket.count += 1;
    bucket.bytes += bytes;
    this.totalCount += 1;
    this.totalBytes += bytes;
  }

  snapshot(nowMs: number): TrafficCounterSnapshot {
    const last10s = this.sumWindow(nowMs, TRAFFIC_SHORT_WINDOW_MS);
    const lastMinute = this.sumWindow(nowMs, TRAFFIC_LONG_WINDOW_MS);
    return {
      total_count: this.totalCount,
      total_bytes: this.totalBytes,
      last_10s_count: last10s.count,
      last_10s_bytes: last10s.bytes,
      last_minute_count: lastMinute.count,
      last_minute_bytes: lastMinute.bytes,
      rate_10s: roundRate(last10s.count / (TRAFFIC_SHORT_WINDOW_MS / 1000)),
      rate_60s: roundRate(lastMinute.count / (TRAFFIC_LONG_WINDOW_MS / 1000)),
    };
  }

  private sumWindow(nowMs: number, windowMs: number): { count: number; bytes: number } {
    const cutoff = nowMs - windowMs;
    let count = 0;
    let bytes = 0;
    for (const bucket of this.buckets) {
      if (bucket.startedAtMs === 0) continue;
      if (bucket.startedAtMs + TRAFFIC_BUCKET_MS <= cutoff) continue;
      if (bucket.startedAtMs > nowMs) continue;
      count += bucket.count;
      bytes += bucket.bytes;
    }
    return { count, bytes };
  }
}

class SessionTrafficStats {
  lastSeenAt = 0;
  lastWarnAt = 0;
  gatewayEvents = new RollingTrafficCounter();
  gatewayFrames = new RollingTrafficCounter();
  browserMessages = new RollingTrafficCounter();
  browserAcks = new RollingTrafficCounter();

  markSeen(nowMs: number): void {
    this.lastSeenAt = nowMs;
  }

  snapshot(sessionId: string, activeSubscribers: number, nowMs: number): SessionTrafficSnapshot {
    const gatewayEvents = this.gatewayEvents.snapshot(nowMs);
    const gatewayFrames = this.gatewayFrames.snapshot(nowMs);
    const browserMessages = this.browserMessages.snapshot(nowMs);
    const browserAcks = this.browserAcks.snapshot(nowMs);

    return {
      session_id: sessionId,
      active_subscribers: activeSubscribers,
      last_seen_at: this.lastSeenAt > 0 ? new Date(this.lastSeenAt).toISOString() : null,
      gateway_events: gatewayEvents,
      gateway_frames: gatewayFrames,
      browser_messages: browserMessages,
      browser_acks: browserAcks,
      incoming_events: combineTrafficSnapshots([gatewayEvents, gatewayFrames, browserMessages]),
      runaway_signal: combineTrafficSnapshots([gatewayFrames, browserAcks]),
    };
  }
}

export class GatewayHub {
  private state: DurableObjectState;
  private env: Env;

  // In-memory state (reset on DO cold start; gateway reconnect restores)
  private gatewaySocket: WebSocket | null = null;
  private gatewayId: string | null = null;
  private expectedGatewayId: string | null = null;
  private vpsId: string | null = null;

  // sessionId → set of subscribed browser WebSockets
  private subscribers = new Map<string, Set<WebSocket>>();

  // Pending commands awaiting gateway ack: request_id → resolver
  private pending = new Map<string, PendingEntry>();

  // Browser realtime ack routing: request_id -> browser socket
  private browserAckWaiters = new Map<string, BrowserAckEntry>();
  private browserAckBySocket = new Map<WebSocket, Set<string>>();

  // Last heartbeat per browser WS (ms timestamp)
  private lastActivity = new Map<WebSocket, number>();

  // Session ID per browser WS (for cleanup)
  private browserSessionMap = new Map<WebSocket, string>();

  // One active input source per session; other sockets are read-only for writes.
  private sessionControllers = new Map<string, SessionController>();
  private controlledSessionBySocket = new Map<WebSocket, string>();

  // Rolling traffic counters for the current gateway DO instance.
  private fetchRequests = new RollingTrafficCounter();
  private gatewayTextMessages = new RollingTrafficCounter();
  private gatewayBinaryFrames = new RollingTrafficCounter();
  private browserTextMessages = new RollingTrafficCounter();
  private browserAckMessages = new RollingTrafficCounter();
  private sessionTraffic = new Map<string, SessionTrafficStats>();
  private lastGatewayTrafficWarnAt = 0;

  // Grace period timer for gateway reconnect
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionEndReconcileNotBeforeMs = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.restoreHibernatedSockets();
  }

  private isStagingDebug(): boolean {
    return this.env.APP_ENV === "staging" || this.env.APP_ENV === "dev";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();
    this.fetchRequests.record(0, now);
    this.pruneSessionTraffic(now);

    if (path === "/gateway-ws") {
      return this.handleGatewayWS(request);
    }

    if (path === "/browser-ws") {
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) {
        return new Response("missing session_id", { status: 400 });
      }
      return this.handleBrowserWS(request, sessionId);
    }

    if (path === "/cmd" && request.method === "POST") {
      return this.handleCommand(request);
    }

    if (path === "/status" && request.method === "GET") {
      return this.handleStatus();
    }

    if (path === "/shutdown" && request.method === "POST") {
      return this.handleShutdown();
    }

    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const meta = this.readAttachment(ws);
    if (!meta) {
      return;
    }

    const now = Date.now();

    if (meta.role === "gateway") {
      if (typeof message === "string") {
        this.gatewayTextMessages.record(this.byteLength(message), now);
        void this.onGatewayText(message, ws).catch((err) => {
          console.warn("gateway ws text handler failed", err);
          safeClose(ws, 1011, "gateway event handler failure");
        });
      } else {
        const payload = new Uint8Array(message);
        this.gatewayBinaryFrames.record(payload.byteLength, now);
        this.onGatewayBinary(payload);
      }
      this.maybeWarnGatewayTraffic(now);
      return;
    }

    if (meta.role === "browser") {
      if (typeof message !== "string") {
        return;
      }
      this.browserTextMessages.record(this.byteLength(message), now);
      const sessionId = meta.sessionId ?? this.browserSessionMap.get(ws);
      if (!sessionId) {
        return;
      }
      this.onBrowserText(ws, sessionId, message);
      this.maybeWarnGatewayTraffic(now);
    }
  }

  webSocketClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): void {
    const meta = this.readAttachment(ws);
    console.warn("GatewayHub websocket closed", {
      role: meta?.role ?? "unknown",
      sessionId: meta?.sessionId ?? null,
      gatewayId: meta?.gatewayId ?? meta?.expectedGatewayId ?? this.gatewayId,
      vpsId: meta?.vpsId ?? this.vpsId,
      code: code ?? null,
      reason: reason ?? "",
      wasClean: wasClean ?? null,
    });
    if (meta?.role === "gateway") {
      void this.onGatewayClose(ws);
      return;
    }
    if (meta?.role === "browser" && meta.sessionId) {
      this.removeBrowserSocket(ws, meta.sessionId);
      return;
    }

    const sessionId = this.browserSessionMap.get(ws);
    if (sessionId) {
      this.removeBrowserSocket(ws, sessionId);
    }
  }

  webSocketError(ws: WebSocket, error?: unknown): void {
    const meta = this.readAttachment(ws);
    console.warn("GatewayHub websocket error", {
      role: meta?.role ?? "unknown",
      sessionId: meta?.sessionId ?? null,
      gatewayId: meta?.gatewayId ?? meta?.expectedGatewayId ?? this.gatewayId,
      vpsId: meta?.vpsId ?? this.vpsId,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error ?? "unknown"),
    });
    this.webSocketClose(ws);
  }

  // ---------------------------------------------------------------------------
  // Gateway WebSocket
  // ---------------------------------------------------------------------------

  private handleGatewayWS(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Clear grace timer if reconnecting
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    this.expectedGatewayId = request.headers.get("X-Gateway-Id");
    this.closeTaggedSockets("gateway", "replaced by new connection");

    this.state.acceptWebSocket(server, ["gateway"]);
    try {
      server.serializeAttachment({
        role: "gateway",
        expectedGatewayId: this.expectedGatewayId ?? undefined,
        gatewayId: this.expectedGatewayId ?? undefined,
        vpsId: this.vpsId ?? undefined,
      } satisfies SocketAttachment);
    } catch {
      // ignore; attachment is optional fallback metadata
    }
    this.gatewaySocket = server;

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onGatewayText(data: string, ws?: WebSocket): Promise<void> {
    if (data.length > MAX_TEXT_PAYLOAD) {
      console.warn("oversized gateway text frame, ignoring");
      return;
    }

    let msg: GatewayEvent;
    try {
      msg = JSON.parse(data) as GatewayEvent;
    } catch {
      console.warn("malformed JSON from gateway, ignoring");
      return;
    }

    const sessionId = getSessionId(msg);
    if (sessionId) {
      const now = Date.now();
      const traffic = this.getSessionTraffic(sessionId, now);
      traffic.gatewayEvents.record(this.byteLength(data), now);
      this.maybeWarnSessionTraffic(sessionId, now);
    }

    switch (msg.type) {
      case "gateway.hello":
        await this.onGatewayHello(msg as GatewayHello, ws);
        break;

      case "gateway.health":
        await this.onGatewayHealth(msg as GatewayHealth);
        break;

      case "ack":
        this.onAck(msg as Ack);
        break;

      case "session.started":
        await this.onSessionStarted(msg as SessionStarted);
        break;

      case "session.ended":
        await this.onSessionEnded(msg as SessionEnded);
        break;

      case "session.error":
        await this.onSessionError(msg as SessionError);
        break;

      case "session.snapshot":
        this.onSessionSnapshot(msg as SessionSnapshotEvent);
        break;

      case "ssh.keys":
      case "agents.status":
      case "workspace.folders":
      case "agent.installed":
      case "gateway.updated":
        // Forward to pending entry's sourceSocket
        this.onCommandEvent(msg as GatewayCommandEvent);
        break;

      case "file.content.begin":
      case "file.content.chunk":
      case "file.content.end":
        // Transfer events are matched by transfer_id, not request_id.
        // A transfer routing map will be added when file APIs are wired in M2+.
        break;

      default:
        console.warn(`unknown gateway message type: ${(msg as { type: string }).type}`);
    }
  }

  private async onGatewayHello(msg: GatewayHello, ws?: WebSocket): Promise<void> {
    const wsExpected = ws ? this.readAttachment(ws)?.expectedGatewayId : null;
    const expectedGatewayId = wsExpected ?? this.expectedGatewayId;

    if (expectedGatewayId && msg.gateway_id !== expectedGatewayId) {
      console.warn(
        `gateway_id mismatch: expected ${expectedGatewayId}, got ${msg.gateway_id}`,
      );
      try {
        (ws ?? this.gatewaySocket)?.close(1008, "gateway_id mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const gatewayId = expectedGatewayId ?? msg.gateway_id;
    this.gatewayId = gatewayId;
    this.sessionEndReconcileNotBeforeMs = Date.now() + SESSION_RECONCILE_END_GRACE_MS;

    // Update D1
    await updateGatewayVersion(this.env.DB, gatewayId, msg.version);
    await updateGatewaySystemInfo(this.env.DB, gatewayId, {
      host_os: msg.system_info?.os ?? null,
    });
    await updateGatewayConnected(this.env.DB, gatewayId, true);

    // Transition VPS to active if provisioning
    // Look up vps_id from gateway
    const gw = await this.env.DB
      .prepare("SELECT vps_id FROM gateways WHERE id = ?")
      .bind(gatewayId)
      .first<{ vps_id: string }>();

    if (gw) {
      this.vpsId = gw.vps_id;
      // Idempotent: only transition from provisioning
      await this.env.DB
        .prepare(
          "UPDATE vps SET status = 'active', updated_at = ? WHERE id = ? AND status IN ('provisioning', 'provisioning_timeout')",
        )
        .bind(Math.floor(Date.now() / 1000), gw.vps_id)
        .run();
    }
    this.persistGatewayAttachment(ws ?? this.gatewaySocket);
  }

  private async onGatewayHealth(msg: GatewayHealth): Promise<void> {
    this.cleanupIdleSockets();

    const gatewayId = msg.gateway_id || this.gatewayId;
    if (!gatewayId) return;

    if (!this.gatewayId) {
      this.gatewayId = gatewayId;
    }

    await updateGatewayLastSeen(this.env.DB, gatewayId);
    await this.reconcileSessionsFromHealth(gatewayId, msg.active_sessions);
  }

  private onAck(msg: Ack): void {
    const entry = this.pending.get(msg.request_id);
    if (entry) {
      this.pending.delete(msg.request_id);

      if (entry.sourceSocket) {
        safeSend(entry.sourceSocket, JSON.stringify(msg));
      }

      if (msg.ok) {
        entry.resolve(msg);
      } else {
        entry.reject(new Error(msg.error || "command failed"));
      }
      return;
    }

    const browserAck = this.browserAckWaiters.get(msg.request_id);
    if (browserAck) {
      this.clearBrowserAck(msg.request_id);
      safeSend(browserAck.ws, JSON.stringify(msg));
    }
  }

  private async onSessionStarted(msg: SessionStarted): Promise<void> {
    await updateSessionStatus(this.env.DB, msg.session_id, "running");

    // Also resolve pending if there is one
    const entry = this.pending.get(msg.request_id);
    if (entry) {
      this.pending.delete(msg.request_id);
      entry.resolve({ type: "ack", schema_version: "1", request_id: msg.request_id, ok: true });
    }

    // Fan out to subscribers
    this.fanOutText(msg.session_id, JSON.stringify(msg));
  }

  private async onSessionEnded(msg: SessionEnded): Promise<void> {
    await updateSessionStatus(this.env.DB, msg.session_id, "ended");
    this.fanOutText(msg.session_id, JSON.stringify(msg));
  }

  private async onSessionError(msg: SessionError): Promise<void> {
    await updateSessionStatus(this.env.DB, msg.session_id, "error");
    this.fanOutText(msg.session_id, JSON.stringify(msg));
  }

  private async reconcileSessionsFromHealth(
    gatewayId: string,
    activeSessions: GatewayHealth["active_sessions"],
  ): Promise<void> {
    const vpsId = await this.resolveVPSId(gatewayId);
    if (!vpsId) {
      return;
    }

    const activeIDs = new Set<string>();
    for (const session of activeSessions ?? []) {
      if (session?.session_id) {
        activeIDs.add(session.session_id);
      }
    }

    const activeIDList = Array.from(activeIDs);
    const binds: Array<string> = [vpsId];
    let sql = `SELECT id, status
         FROM sessions
         WHERE (vps_id = ?
           AND status IN ('starting', 'running'))`;
    if (activeIDList.length > 0) {
      sql += ` OR (vps_id = ? AND id IN (${activeIDList.map(() => "?").join(", ")}))`;
      binds.push(vpsId, ...activeIDList);
    }

    const result = await this.env.DB.prepare(sql).bind(...binds).all<{ id: string; status: string }>();

    for (const row of result.results ?? []) {
      const shouldBeRunning = activeIDs.has(row.id);
      if (!shouldBeRunning && Date.now() < this.sessionEndReconcileNotBeforeMs) {
        continue;
      }

      const nextStatus = shouldBeRunning ? "running" : "ended";
      if (row.status !== nextStatus) {
        await updateSessionStatus(this.env.DB, row.id, nextStatus);
      }
    }
  }

  private async resolveVPSId(gatewayId: string): Promise<string | null> {
    if (this.vpsId) {
      return this.vpsId;
    }

    const row = await this.env.DB
      .prepare("SELECT vps_id FROM gateways WHERE id = ?")
      .bind(gatewayId)
      .first<{ vps_id: string }>();
    if (!row?.vps_id) {
      return null;
    }

    this.vpsId = row.vps_id;
    this.persistGatewayAttachment(this.gatewaySocket);
    return row.vps_id;
  }

  private onSessionSnapshot(msg: SessionSnapshotEvent): void {
    if (this.isStagingDebug()) {
      console.info("GatewayHub gateway session.snapshot", {
        gatewayId: this.gatewayId,
        vpsId: this.vpsId,
        sessionId: msg.session_id,
        requestId: msg.request_id,
        cols: typeof msg.cols === "number" ? msg.cols : null,
        rows: typeof msg.rows === "number" ? msg.rows : null,
        cursorX: typeof msg.cursor_x === "number" ? msg.cursor_x : null,
        cursorY: typeof msg.cursor_y === "number" ? msg.cursor_y : null,
      });
    }
    // If there's a pending request for this snapshot, resolve it
    if (msg.request_id) {
      const entry = this.pending.get(msg.request_id);
      if (entry) {
        this.pending.delete(msg.request_id);
        if (entry.sourceSocket) {
          safeSend(entry.sourceSocket, JSON.stringify(msg));
        }
        entry.resolve(msg);
      }
    }

    // Also fan out to subscribers
    if (msg.session_id) {
      this.fanOutText(msg.session_id, JSON.stringify(msg));
    }
  }

  private onCommandEvent(msg: GatewayCommandEvent): void {
    const requestId = msg.request_id;

    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.pending.delete(requestId);

    if (entry.sourceSocket) {
      safeSend(entry.sourceSocket, JSON.stringify(msg));
    }

    entry.resolve(msg);
  }

  private onGatewayBinary(data: Uint8Array): void {
    if (data.byteLength > MAX_BINARY_PAYLOAD) {
      console.warn("oversized gateway binary frame, ignoring");
      return;
    }

    // Decode session_id from frame header for fan-out
    const frame = decodeTerminalFrame(data);
    if (!frame) {
      console.warn("malformed binary frame from gateway");
      return;
    }

    const now = Date.now();
    const traffic = this.getSessionTraffic(frame.sessionId, now);
    traffic.gatewayFrames.record(data.byteLength, now);
    this.maybeWarnSessionTraffic(frame.sessionId, now);

    // Fan out raw bytes to subscribers of this session
    const subs = this.subscribers.get(frame.sessionId);
    if (!subs) return;

    for (const ws of subs) {
      safeSendBinary(ws, data);
    }
  }

  private async onGatewayClose(ws?: WebSocket): Promise<void> {
    if (ws && this.gatewaySocket && ws !== this.gatewaySocket) {
      return;
    }

    this.gatewaySocket = null;
    this.sessionEndReconcileNotBeforeMs = 0;

    // Reject all pending
    for (const [id, entry] of this.pending) {
      entry.reject(new Error("gateway disconnected"));
    }
    this.pending.clear();

    // Update D1
    if (this.gatewayId) {
      await updateGatewayConnected(this.env.DB, this.gatewayId, false);

      // Start grace period
      this.graceTimer = setTimeout(async () => {
        // If still disconnected after grace period, mark offline in D1
        if (!this.gatewaySocket && this.gatewayId) {
          await updateGatewayConnected(this.env.DB, this.gatewayId, false);
        }
      }, GRACE_PERIOD_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Browser WebSocket
  // ---------------------------------------------------------------------------

  private handleBrowserWS(request: Request, sessionId: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, ["browser", `session:${sessionId}`]);
    try {
      server.serializeAttachment({ role: "browser", sessionId } satisfies SocketAttachment);
    } catch {
      // ignore
    }
    this.upsertBrowserSocket(server, sessionId, Date.now());
    this.cleanupIdleSockets();

    if (!this.gatewaySocket) {
      safeSend(
        server,
        JSON.stringify({
          type: "session.error",
          schema_version: "1",
          session_id: sessionId,
          error: "gateway not connected",
        }),
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private onBrowserText(ws: WebSocket, sessionId: string, data: string): void {
    // Payload guard
    if (data.length > MAX_TEXT_PAYLOAD) {
      this.sendProtocolError(ws, "payload_too_large", "payload exceeds maximum size");
      try {
        ws.close(1008, "payload too large");
      } catch {
        // ignore
      }
      this.removeBrowserSocket(ws, sessionId);
      return;
    }

    let msg: { type: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendProtocolError(ws, "invalid_payload", "invalid JSON");
      return;
    }

    const now = Date.now();
    this.lastActivity.set(ws, now);
    const traffic = this.getSessionTraffic(sessionId, now);
    traffic.browserMessages.record(this.byteLength(data), now);

    // Realtime relay (fire-and-forget)
    switch (msg.type) {
      case "session.input":
      case "session.resize":
        if (msg.type === "session.resize" && this.isStagingDebug()) {
          console.info("GatewayHub browser session.resize", {
            gatewayId: this.gatewayId,
            vpsId: this.vpsId,
            sessionId,
            requestId: typeof msg.request_id === "string" ? msg.request_id : null,
            cols: typeof msg.cols === "number" ? msg.cols : null,
            rows: typeof msg.rows === "number" ? msg.rows : null,
          });
        }
        if (!this.tryAcquireSessionControl(sessionId, ws)) {
          if (msg.type === "session.resize" && this.isStagingDebug()) {
            console.warn("GatewayHub rejected session.resize (read-only)", {
              gatewayId: this.gatewayId,
              vpsId: this.vpsId,
              sessionId,
            });
          }
          this.sendReadOnlyError(ws, msg);
          return;
        }
        if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
          this.trackBrowserAck(msg.request_id, ws);
        }
        this.sendRealtime(data);
        break;

      case "session.snapshot":
        if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
          this.trackBrowserAck(msg.request_id, ws);
        }
        this.sendRealtime(data);
        break;

      case "session.ack":
        traffic.browserAcks.record(this.byteLength(data), now);
        this.browserAckMessages.record(this.byteLength(data), now);
        this.sendRealtime(data);
        break;

      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong", schema_version: "1" }));
        break;

      default:
        this.sendProtocolError(ws, "unknown_type", `unknown message type: ${msg.type}`);
    }

    this.maybeWarnSessionTraffic(sessionId, now);
  }

  private upsertBrowserSocket(ws: WebSocket, sessionId: string, lastSeenMs: number): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(ws);
    this.lastActivity.set(ws, lastSeenMs);
    this.browserSessionMap.set(ws, sessionId);
  }

  private removeBrowserSocket(ws: WebSocket, sessionId: string): void {
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
    this.lastActivity.delete(ws);
    this.browserSessionMap.delete(ws);
    this.releaseSessionControl(ws, sessionId);

    const requestIds = this.browserAckBySocket.get(ws);
    if (requestIds) {
      for (const requestId of requestIds) {
        this.clearBrowserAck(requestId);
      }
      this.browserAckBySocket.delete(ws);
    }
  }

  // ---------------------------------------------------------------------------
  // Command relay
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget relay to gateway (no ack tracking).
   * Used for session.input, session.resize, session.ack.
   */
  private sendRealtime(data: string): void {
    if (!this.gatewaySocket) return;
    safeSend(this.gatewaySocket, data);
  }

  /**
   * Ack-tracked command relay to gateway.
   * Returns promise that resolves on ack or rejects on timeout/disconnect.
   */
  private sendCommand(
    cmd: Record<string, unknown> & { request_id: string },
    sourceSocket: WebSocket | null = null,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<GatewayCommandResult> {
    if (!this.gatewaySocket) {
      return Promise.reject(new Error("gateway not connected"));
    }

    return new Promise<GatewayCommandResult>((resolve, reject) => {
      this.pending.set(cmd.request_id, {
        resolve,
        reject,
        startedAt: Date.now(),
        sourceSocket,
      });

      setTimeout(() => {
        if (this.pending.has(cmd.request_id)) {
          this.pending.delete(cmd.request_id);
          reject(new Error(`command ${cmd.request_id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      safeSend(this.gatewaySocket!, JSON.stringify(cmd));
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP command handler (called by route handlers via stub.fetch)
  // ---------------------------------------------------------------------------

  private async handleCommand(request: Request): Promise<Response> {
    const cmd = (await request.json()) as Record<string, unknown> & { request_id: string };

    try {
      const ack = await this.sendCommand(cmd);
      return new Response(JSON.stringify(ack), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      const status =
        message === "gateway not connected"
          ? 503
          : message.includes("timed out after")
            ? 504
            : 502;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private handleStatus(): Response {
    const now = Date.now();
    this.pruneSessionTraffic(now);
    return new Response(
      JSON.stringify({
        connected: this.gatewaySocket !== null,
        gateway_id: this.gatewayId,
        vps_id: this.vpsId,
        traffic: this.buildTrafficStatus(now),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  private buildTrafficStatus(nowMs: number): {
    fetch_requests: TrafficCounterSnapshot;
    gateway_events: TrafficCounterSnapshot;
    gateway_frames: TrafficCounterSnapshot;
    browser_messages: TrafficCounterSnapshot;
    browser_acks: TrafficCounterSnapshot;
    realtime_events: TrafficCounterSnapshot;
    incoming_events: TrafficCounterSnapshot;
    hot_sessions: SessionTrafficSnapshot[];
  } {
    const fetchRequests = this.fetchRequests.snapshot(nowMs);
    const gatewayEvents = this.gatewayTextMessages.snapshot(nowMs);
    const gatewayFrames = this.gatewayBinaryFrames.snapshot(nowMs);
    const browserMessages = this.browserTextMessages.snapshot(nowMs);
    const browserAcks = this.browserAckMessages.snapshot(nowMs);
    const realtimeEvents = combineTrafficSnapshots([gatewayEvents, gatewayFrames, browserMessages]);

    const hotSessions = Array.from(this.sessionTraffic.entries())
      .map(([sessionId, traffic]) =>
        traffic.snapshot(sessionId, this.subscribers.get(sessionId)?.size ?? 0, nowMs),
      )
      .filter(
        (session) =>
          session.incoming_events.last_minute_count > 0 || session.active_subscribers > 0,
      )
      .sort((left, right) => {
        if (right.runaway_signal.last_10s_count !== left.runaway_signal.last_10s_count) {
          return right.runaway_signal.last_10s_count - left.runaway_signal.last_10s_count;
        }
        if (right.incoming_events.last_10s_count !== left.incoming_events.last_10s_count) {
          return right.incoming_events.last_10s_count - left.incoming_events.last_10s_count;
        }
        return (right.last_seen_at ?? "").localeCompare(left.last_seen_at ?? "");
      })
      .slice(0, MAX_HOT_SESSIONS);

    return {
      fetch_requests: fetchRequests,
      gateway_events: gatewayEvents,
      gateway_frames: gatewayFrames,
      browser_messages: browserMessages,
      browser_acks: browserAcks,
      realtime_events: realtimeEvents,
      incoming_events: combineTrafficSnapshots([fetchRequests, realtimeEvents]),
      hot_sessions: hotSessions,
    };
  }

  private getSessionTraffic(sessionId: string, nowMs: number): SessionTrafficStats {
    let traffic = this.sessionTraffic.get(sessionId);
    if (!traffic) {
      traffic = new SessionTrafficStats();
      this.sessionTraffic.set(sessionId, traffic);
    }
    traffic.markSeen(nowMs);
    return traffic;
  }

  private pruneSessionTraffic(nowMs = Date.now()): void {
    for (const [sessionId, traffic] of this.sessionTraffic) {
      if (traffic.lastSeenAt === 0) continue;
      if (nowMs - traffic.lastSeenAt <= SESSION_TRAFFIC_RETENTION_MS) continue;
      if ((this.subscribers.get(sessionId)?.size ?? 0) > 0) continue;
      this.sessionTraffic.delete(sessionId);
    }
  }

  private maybeWarnGatewayTraffic(nowMs: number): void {
    const threshold = parseRateThreshold(
      this.env.GATEWAY_HUB_GATEWAY_EVENT_RATE_WARN_PER_SEC,
      DEFAULT_GATEWAY_EVENT_RATE_WARN_PER_SEC,
    );
    if (threshold === 0) return;
    if (nowMs - this.lastGatewayTrafficWarnAt < TRAFFIC_WARN_COOLDOWN_MS) return;

    const snapshot = this.buildTrafficStatus(nowMs);
    if (snapshot.realtime_events.rate_10s < threshold) {
      return;
    }

    this.lastGatewayTrafficWarnAt = nowMs;
    console.warn({
      event: "gatewayhub.incoming_traffic_threshold_exceeded",
      gatewayId: this.gatewayId,
      vpsId: this.vpsId,
      incomingRate10s: snapshot.realtime_events.rate_10s,
      incomingEvents10s: snapshot.realtime_events.last_10s_count,
      incomingEvents1m: snapshot.realtime_events.last_minute_count,
      gatewayFrames10s: snapshot.gateway_frames.last_10s_count,
      browserMessages10s: snapshot.browser_messages.last_10s_count,
      browserAcks10s: snapshot.browser_acks.last_10s_count,
      fetchRequests10s: snapshot.fetch_requests.last_10s_count,
      hotSessions: snapshot.hot_sessions
        .slice(0, 3)
        .map((session) => ({
          sessionId: session.session_id,
          runawayRate10s: session.runaway_signal.rate_10s,
          gatewayFrames10s: session.gateway_frames.last_10s_count,
          browserAcks10s: session.browser_acks.last_10s_count,
        })),
    });
  }

  private maybeWarnSessionTraffic(sessionId: string, nowMs: number): void {
    const traffic = this.sessionTraffic.get(sessionId);
    if (!traffic) return;
    if (nowMs - traffic.lastWarnAt < TRAFFIC_WARN_COOLDOWN_MS) return;

    const runawayThreshold = parseRateThreshold(
      this.env.GATEWAY_HUB_SESSION_RUNAWAY_RATE_WARN_PER_SEC ??
        this.env.GATEWAY_HUB_SESSION_MESSAGE_RATE_WARN_PER_SEC,
      DEFAULT_SESSION_RUNAWAY_RATE_WARN_PER_SEC,
    );
    const ackThreshold = parseRateThreshold(
      this.env.GATEWAY_HUB_SESSION_ACK_RATE_WARN_PER_SEC,
      DEFAULT_SESSION_ACK_RATE_WARN_PER_SEC,
    );

    const snapshot = traffic.snapshot(sessionId, this.subscribers.get(sessionId)?.size ?? 0, nowMs);
    const exceedsRunawayThreshold =
      runawayThreshold > 0 && snapshot.runaway_signal.rate_10s >= runawayThreshold;
    const exceedsAckThreshold =
      ackThreshold > 0 && snapshot.browser_acks.rate_10s >= ackThreshold;

    if (!exceedsRunawayThreshold && !exceedsAckThreshold) {
      return;
    }

    traffic.lastWarnAt = nowMs;
    console.warn({
      event: "gatewayhub.session_traffic_threshold_exceeded",
      gatewayId: this.gatewayId,
      vpsId: this.vpsId,
      sessionId,
      runawayRate10s: snapshot.runaway_signal.rate_10s,
      incomingRate10s: snapshot.incoming_events.rate_10s,
      gatewayFrames10s: snapshot.gateway_frames.last_10s_count,
      gatewayFramesBytes10s: snapshot.gateway_frames.last_10s_bytes,
      browserMessages10s: snapshot.browser_messages.last_10s_count,
      browserAcks10s: snapshot.browser_acks.last_10s_count,
      browserAckBytes10s: snapshot.browser_acks.last_10s_bytes,
      gatewayFrames1m: snapshot.gateway_frames.last_minute_count,
      browserAcks1m: snapshot.browser_acks.last_minute_count,
      activeSubscribers: snapshot.active_subscribers,
    });
  }

  private byteLength(data: string): number {
    // Message payloads are overwhelmingly ASCII/JSON. `length` is close enough for
    // traffic monitoring and avoids allocating a Uint8Array on every text message.
    return data.length;
  }

  private restoreHibernatedSockets(): void {
    const sockets = this.getWebSockets();
    let claimedGateway = false;
    const now = Date.now();

    for (const ws of sockets) {
      const meta = this.readAttachment(ws);
      if (!meta) {
        continue;
      }

      if (meta.role === "gateway") {
        if (!claimedGateway) {
          this.gatewaySocket = ws;
          if (meta.gatewayId) {
            this.gatewayId = meta.gatewayId;
          }
          if (meta.vpsId) {
            this.vpsId = meta.vpsId;
          }
          if (meta.expectedGatewayId) {
            this.expectedGatewayId = meta.expectedGatewayId;
          }
          claimedGateway = true;
        } else {
          safeClose(ws, 1000, "superseded gateway socket");
        }
        continue;
      }

      if (meta.role === "browser" && meta.sessionId) {
        this.upsertBrowserSocket(ws, meta.sessionId, now);
      } else {
        safeClose(ws, 1008, "invalid browser attachment");
      }
    }
  }

  private getWebSockets(tag?: string): WebSocket[] {
    const state = this.state as DurableObjectState & {
      getWebSockets?: (tag?: string) => WebSocket[];
    };
    if (typeof state.getWebSockets !== "function") {
      return [];
    }
    return state.getWebSockets(tag);
  }

  private closeTaggedSockets(tag: string, reason: string): void {
    for (const ws of this.getWebSockets(tag)) {
      safeClose(ws, 1000, reason);
    }
  }

  private persistGatewayAttachment(ws: WebSocket | null): void {
    if (!ws) return;
    try {
      ws.serializeAttachment({
        role: "gateway",
        expectedGatewayId: this.expectedGatewayId ?? undefined,
        gatewayId: this.gatewayId ?? undefined,
        vpsId: this.vpsId ?? undefined,
      } satisfies SocketAttachment);
    } catch {
      // ignore
    }
  }

  private readAttachment(ws: WebSocket): SocketAttachment | null {
    const withAttachment = ws as WebSocket & {
      deserializeAttachment?: () => unknown;
    };
    if (typeof withAttachment.deserializeAttachment !== "function") {
      return null;
    }

    try {
      const raw = withAttachment.deserializeAttachment();
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const role = (raw as { role?: unknown }).role;
      if (role !== "gateway" && role !== "browser") {
        return null;
      }
      const sessionId = (raw as { sessionId?: unknown }).sessionId;
      const expectedGatewayId = (raw as { expectedGatewayId?: unknown }).expectedGatewayId;
      const gatewayId = (raw as { gatewayId?: unknown }).gatewayId;
      const vpsId = (raw as { vpsId?: unknown }).vpsId;
      return {
        role,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        expectedGatewayId: typeof expectedGatewayId === "string" ? expectedGatewayId : undefined,
        gatewayId: typeof gatewayId === "string" ? gatewayId : undefined,
        vpsId: typeof vpsId === "string" ? vpsId : undefined,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  private handleShutdown(): Response {
    for (const ws of this.getWebSockets()) {
      safeClose(ws, 1001, "shutdown requested");
    }
    this.gatewaySocket = null;
    this.subscribers.clear();
    this.lastActivity.clear();
    this.browserSessionMap.clear();
    this.sessionControllers.clear();
    this.controlledSessionBySocket.clear();
    for (const requestId of this.browserAckWaiters.keys()) {
      this.clearBrowserAck(requestId);
    }
    this.browserAckBySocket.clear();

    // Reject pending
    for (const [, entry] of this.pending) {
      entry.reject(new Error("shutdown"));
    }
    this.pending.clear();

    return new Response("ok");
  }

  // ---------------------------------------------------------------------------
  // Fan-out helpers
  // ---------------------------------------------------------------------------

  private fanOutText(sessionId: string, data: string): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    for (const ws of subs) {
      safeSend(ws, data);
    }
  }

  // ---------------------------------------------------------------------------
  // Idle cleanup
  // ---------------------------------------------------------------------------

  private cleanupIdleSockets(): void {
    const now = Date.now();
    for (const [ws, lastTime] of this.lastActivity) {
      if (now - lastTime > IDLE_TIMEOUT_MS) {
        const sessionId = this.browserSessionMap.get(ws);
        try {
          ws.close(1000, "idle timeout");
        } catch {
          // ignore
        }
        if (sessionId) {
          this.removeBrowserSocket(ws, sessionId);
        } else {
          this.lastActivity.delete(ws);
          this.browserSessionMap.delete(ws);
          this.releaseSessionControl(ws);
        }
      }
    }
  }

  private tryAcquireSessionControl(sessionId: string, ws: WebSocket): boolean {
    const now = Date.now();
    const current = this.sessionControllers.get(sessionId);
    if (!current) {
      this.assignSessionControl(sessionId, ws, now);
      return true;
    }
    if (current.ws.readyState !== WebSocket.OPEN) {
      this.assignSessionControl(sessionId, ws, now);
      return true;
    }
    if (current.ws === ws) {
      current.lastWriteAt = now;
      this.sessionControllers.set(sessionId, current);
      return true;
    }
    if (now - current.lastWriteAt > SESSION_CONTROL_LEASE_MS) {
      this.assignSessionControl(sessionId, ws, now);
      return true;
    }
    return false;
  }

  private assignSessionControl(sessionId: string, ws: WebSocket, now: number): void {
    const prev = this.sessionControllers.get(sessionId);
    if (prev && prev.ws !== ws) {
      this.controlledSessionBySocket.delete(prev.ws);
    }
    const prevSession = this.controlledSessionBySocket.get(ws);
    if (prevSession && prevSession !== sessionId) {
      this.sessionControllers.delete(prevSession);
    }
    this.sessionControllers.set(sessionId, { ws, lastWriteAt: now });
    this.controlledSessionBySocket.set(ws, sessionId);
  }

  private releaseSessionControl(ws: WebSocket, knownSessionId?: string): void {
    const sessionId = knownSessionId ?? this.controlledSessionBySocket.get(ws);
    if (!sessionId) return;
    const current = this.sessionControllers.get(sessionId);
    if (current?.ws === ws) {
      this.sessionControllers.delete(sessionId);
    }
    this.controlledSessionBySocket.delete(ws);
  }

  private sendReadOnlyError(
    ws: WebSocket,
    msg: { type: string } & Record<string, unknown>,
  ): void {
    const requestId =
      typeof msg.request_id === "string" && msg.request_id.length > 0 ? msg.request_id : null;
    if (requestId) {
      safeSend(
        ws,
        JSON.stringify({
          type: "ack",
          schema_version: "1",
          request_id: requestId,
          ok: false,
          error: "session is read-only (active input in another connection)",
        }),
      );
    }
  }

  private sendProtocolError(ws: WebSocket, code: string, message: string): void {
    safeSend(
      ws,
      JSON.stringify({
        type: "error",
        schema_version: "1",
        code,
        message,
      }),
    );
  }

  private trackBrowserAck(requestId: string, ws: WebSocket): void {
    this.clearBrowserAck(requestId);
    if (!this.browserAckBySocket.has(ws)) {
      this.browserAckBySocket.set(ws, new Set());
    }
    this.browserAckBySocket.get(ws)!.add(requestId);
    const timeout = setTimeout(() => {
      this.clearBrowserAck(requestId);
    }, COMMAND_TIMEOUT_MS);
    this.browserAckWaiters.set(requestId, { ws, timeout });
  }

  private clearBrowserAck(requestId: string): void {
    const entry = this.browserAckWaiters.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.browserAckWaiters.delete(requestId);
    const requestIds = this.browserAckBySocket.get(entry.ws);
    if (!requestIds) return;
    requestIds.delete(requestId);
    if (requestIds.size === 0) {
      this.browserAckBySocket.delete(entry.ws);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function getSessionId(msg: GatewayEvent): string | null {
  const sessionId = (msg as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function combineTrafficSnapshots(snapshots: TrafficCounterSnapshot[]): TrafficCounterSnapshot {
  const combined = {
    total_count: 0,
    total_bytes: 0,
    last_10s_count: 0,
    last_10s_bytes: 0,
    last_minute_count: 0,
    last_minute_bytes: 0,
  };

  for (const snapshot of snapshots) {
    combined.total_count += snapshot.total_count;
    combined.total_bytes += snapshot.total_bytes;
    combined.last_10s_count += snapshot.last_10s_count;
    combined.last_10s_bytes += snapshot.last_10s_bytes;
    combined.last_minute_count += snapshot.last_minute_count;
    combined.last_minute_bytes += snapshot.last_minute_bytes;
  }

  return {
    ...combined,
    rate_10s: roundRate(combined.last_10s_count / (TRAFFIC_SHORT_WINDOW_MS / 1000)),
    rate_60s: roundRate(combined.last_minute_count / (TRAFFIC_LONG_WINDOW_MS / 1000)),
  };
}

function parseRateThreshold(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(data);
  } catch (err) {
    console.warn("ws send failed", err);
  }
}

function safeSendBinary(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(data);
  } catch (err) {
    console.warn("ws binary send failed", err);
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}
