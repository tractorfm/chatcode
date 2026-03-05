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
  updateSessionStatus,
} from "../db/schema.js";

const MAX_BINARY_PAYLOAD = 64 * 1024; // 64 KB
const MAX_TEXT_PAYLOAD = 1024 * 1024; // 1 MB
const COMMAND_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 600_000; // 10 minutes
const GRACE_PERIOD_MS = 30_000; // 30s reconnect grace
const SESSION_RECONCILE_END_GRACE_MS = 90_000; // avoid ending sessions right after reconnect
const SESSION_CONTROL_LEASE_MS = 30_000; // lock input/resize source for 30s since last write

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
  | FileContentBegin
  | FileContentChunk
  | FileContentEnd
  | AgentInstalled
  | GatewayUpdated;

type GatewayCommandResult = Ack | SessionSnapshotEvent | AgentsStatus;

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

  // Grace period timer for gateway reconnect
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionEndReconcileNotBeforeMs = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.restoreHibernatedSockets();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

    if (meta.role === "gateway") {
      if (typeof message === "string") {
        void this.onGatewayText(message, ws).catch((err) => {
          console.warn("gateway ws text handler failed", err);
          safeClose(ws, 1011, "gateway event handler failure");
        });
      } else {
        this.onGatewayBinary(new Uint8Array(message));
      }
      return;
    }

    if (meta.role === "browser") {
      if (typeof message !== "string") {
        return;
      }
      const sessionId = meta.sessionId ?? this.browserSessionMap.get(ws);
      if (!sessionId) {
        return;
      }
      this.onBrowserText(ws, sessionId, message);
    }
  }

  webSocketClose(ws: WebSocket): void {
    const meta = this.readAttachment(ws);
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

  webSocketError(ws: WebSocket): void {
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
      case "agent.installed":
      case "gateway.updated":
        // Forward to pending entry's sourceSocket
        this.onCommandEvent(msg as { request_id: string });
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
          "UPDATE vps SET status = 'active', updated_at = ? WHERE id = ? AND status = 'provisioning'",
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

    const result = await this.env.DB
      .prepare(
        `SELECT id, status
         FROM sessions
         WHERE vps_id = ?
           AND status IN ('starting', 'running')`,
      )
      .bind(vpsId)
      .all<{ id: string; status: string }>();

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

  private onCommandEvent(msg: { request_id: string }): void {
    const requestId = msg.request_id;

    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.pending.delete(requestId);

    if (entry.sourceSocket) {
      safeSend(entry.sourceSocket, JSON.stringify(msg));
    }

    entry.resolve(msg as GatewayCommandResult);
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

    // Request snapshot from gateway
    if (this.gatewaySocket) {
      const requestId = `snap-init-${sessionId}-${Date.now()}`;
      this.trackBrowserAck(requestId, server);
      const snapshotCmd = JSON.stringify({
        type: "session.snapshot",
        schema_version: "1",
        request_id: requestId,
        session_id: sessionId,
      });
      safeSend(this.gatewaySocket, snapshotCmd);
    } else {
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

    this.lastActivity.set(ws, Date.now());
    this.cleanupIdleSockets();

    // Realtime relay (fire-and-forget)
    switch (msg.type) {
      case "session.input":
      case "session.resize":
        if (!this.tryAcquireSessionControl(sessionId, ws)) {
          this.sendReadOnlyError(ws, msg);
          return;
        }
        if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
          this.trackBrowserAck(msg.request_id, ws);
        }
        this.sendRealtime(data);
        break;

      case "session.ack":
        if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
          this.trackBrowserAck(msg.request_id, ws);
        }
        this.sendRealtime(data);
        break;

      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong", schema_version: "1" }));
        break;

      default:
        this.sendProtocolError(ws, "unknown_type", `unknown message type: ${msg.type}`);
    }
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
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private handleStatus(): Response {
    return new Response(
      JSON.stringify({
        connected: this.gatewaySocket !== null,
        gateway_id: this.gatewayId,
        vps_id: this.vpsId,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
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
