/**
 * GatewayHub Durable Object – one per gateway, keyed by gateway_id via idFromName.
 *
 * Core of M2: WS terminus for both gateway and browser clients.
 * Routes commands, fans out terminal output, tracks pending acks.
 *
 * Uses standard DO WebSocket API (not hibernation) for M2.
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
  updateVPSStatus,
  getGatewayByVPS,
} from "../db/schema.js";

const MAX_BINARY_PAYLOAD = 64 * 1024; // 64 KB
const MAX_TEXT_PAYLOAD = 256 * 1024; // 256 KB
const COMMAND_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 600_000; // 10 minutes
const IDLE_CHECK_INTERVAL_MS = 60_000; // 1 minute
const GRACE_PERIOD_MS = 30_000; // 30s reconnect grace

interface PendingEntry {
  resolve: (result: GatewayCommandResult) => void;
  reject: (err: Error) => void;
  startedAt: number;
  sourceSocket: WebSocket | null;
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
  | FileContentBegin
  | FileContentChunk
  | FileContentEnd
  | AgentInstalled
  | GatewayUpdated;

type GatewayCommandResult = Ack | SessionSnapshotEvent;

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

  // Last heartbeat per browser WS (ms timestamp)
  private lastActivity = new Map<WebSocket, number>();

  // Session ID per browser WS (for cleanup)
  private browserSessionMap = new Map<WebSocket, string>();

  // Idle cleanup interval
  private idleCleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Grace period timer for gateway reconnect
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Start idle cleanup interval
    this.idleCleanupInterval = setInterval(() => this.cleanupIdleSockets(), IDLE_CHECK_INTERVAL_MS);
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

    if (path === "/shutdown" && request.method === "POST") {
      return this.handleShutdown();
    }

    return new Response("not found", { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // Gateway WebSocket
  // ---------------------------------------------------------------------------

  private handleGatewayWS(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    server.accept();

    // Clear grace timer if reconnecting
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    // Close existing gateway socket if any
    if (this.gatewaySocket) {
      try {
        this.gatewaySocket.close(1000, "replaced by new connection");
      } catch {
        // ignore
      }
    }

    this.gatewaySocket = server;
    this.expectedGatewayId = request.headers.get("X-Gateway-Id");

    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.onGatewayText(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.onGatewayBinary(new Uint8Array(event.data));
      }
    });

    server.addEventListener("close", () => {
      this.onGatewayClose();
    });

    server.addEventListener("error", () => {
      this.onGatewayClose();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onGatewayText(data: string): Promise<void> {
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
        await this.onGatewayHello(msg as GatewayHello);
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
      case "agent.installed":
      case "gateway.updated":
        // Forward to pending entry's sourceSocket
        this.forwardToPending(msg);
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

  private async onGatewayHello(msg: GatewayHello): Promise<void> {
    if (this.expectedGatewayId && msg.gateway_id !== this.expectedGatewayId) {
      console.warn(
        `gateway_id mismatch: expected ${this.expectedGatewayId}, got ${msg.gateway_id}`,
      );
      try {
        this.gatewaySocket?.close(1008, "gateway_id mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const gatewayId = this.expectedGatewayId ?? msg.gateway_id;
    this.gatewayId = gatewayId;

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
  }

  private async onGatewayHealth(msg: GatewayHealth): Promise<void> {
    if (msg.gateway_id) {
      await updateGatewayLastSeen(this.env.DB, msg.gateway_id);
    }
  }

  private onAck(msg: Ack): void {
    const entry = this.pending.get(msg.request_id);
    if (!entry) return;

    this.pending.delete(msg.request_id);

    if (entry.sourceSocket) {
      safeSend(entry.sourceSocket, JSON.stringify(msg));
    }

    if (msg.ok) {
      entry.resolve(msg);
    } else {
      entry.reject(new Error(msg.error || "command failed"));
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

  private forwardToPending(msg: { request_id: string }): void {
    const requestId = msg.request_id;

    const entry = this.pending.get(requestId);
    if (!entry) return;

    if (entry.sourceSocket) {
      safeSend(entry.sourceSocket, JSON.stringify(msg));
    }
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

  private async onGatewayClose(): Promise<void> {
    this.gatewaySocket = null;

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

    server.accept();

    // Add to subscribers
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(server);
    this.lastActivity.set(server, Date.now());
    this.browserSessionMap.set(server, sessionId);

    // Request snapshot from gateway
    if (this.gatewaySocket) {
      const snapshotCmd = JSON.stringify({
        type: "session.snapshot",
        schema_version: "1",
        request_id: `snap-init-${sessionId}-${Date.now()}`,
        session_id: sessionId,
      });
      safeSend(this.gatewaySocket, snapshotCmd);
    }

    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.onBrowserText(server, sessionId, event.data);
      }
      // Binary from browser not expected in M2
    });

    server.addEventListener("close", () => {
      this.removeBrowserSocket(server, sessionId);
    });

    server.addEventListener("error", () => {
      this.removeBrowserSocket(server, sessionId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private onBrowserText(ws: WebSocket, sessionId: string, data: string): void {
    // Payload guard
    if (data.length > MAX_TEXT_PAYLOAD) {
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          code: "payload_too_large",
          message: "payload exceeds maximum size",
        }),
      );
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
      safeSend(
        ws,
        JSON.stringify({
          type: "error",
          code: "invalid_payload",
          message: "invalid JSON",
        }),
      );
      return;
    }

    this.lastActivity.set(ws, Date.now());

    // Realtime relay (fire-and-forget)
    switch (msg.type) {
      case "session.input":
      case "session.resize":
      case "session.ack":
        this.sendRealtime(data);
        break;

      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong" }));
        break;

      default:
        safeSend(
          ws,
          JSON.stringify({
            type: "error",
            code: "unknown_type",
            message: `unknown message type: ${msg.type}`,
          }),
        );
    }
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

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  private handleShutdown(): Response {
    if (this.gatewaySocket) {
      try {
        this.gatewaySocket.close(1000, "shutdown requested");
      } catch {
        // ignore
      }
      this.gatewaySocket = null;
    }

    // Close all browser sockets
    for (const [sessionId, subs] of this.subscribers) {
      for (const ws of subs) {
        try {
          ws.close(1001, "VPS shutting down");
        } catch {
          // ignore
        }
      }
    }
    this.subscribers.clear();
    this.lastActivity.clear();
    this.browserSessionMap.clear();

    // Reject pending
    for (const [, entry] of this.pending) {
      entry.reject(new Error("shutdown"));
    }
    this.pending.clear();

    if (this.idleCleanupInterval) {
      clearInterval(this.idleCleanupInterval);
      this.idleCleanupInterval = null;
    }

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
        }
      }
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
