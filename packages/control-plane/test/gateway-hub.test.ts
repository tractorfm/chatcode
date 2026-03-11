import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayHub } from "../src/durables/GatewayHub";

const mocks = vi.hoisted(() => ({
  updateGatewayConnected: vi.fn(async () => {}),
  updateGatewayVersion: vi.fn(async () => {}),
  updateGatewaySystemInfo: vi.fn(async () => {}),
  updateGatewayLastSeen: vi.fn(async () => {}),
  updateSessionStatus: vi.fn(async () => {}),
}));

vi.mock("../src/db/schema.js", () => ({
  updateGatewayConnected: mocks.updateGatewayConnected,
  updateGatewayVersion: mocks.updateGatewayVersion,
  updateGatewaySystemInfo: mocks.updateGatewaySystemInfo,
  updateGatewayLastSeen: mocks.updateGatewayLastSeen,
  updateSessionStatus: mocks.updateSessionStatus,
}));

const createdHubs: GatewayHub[] = [];

afterEach(() => {
  createdHubs.length = 0;
  vi.clearAllMocks();
});

function makeHub(
  vpsId: string | null = "vps-1",
  runningSessions: Array<{ id: string; status: string }> = [],
): GatewayHub {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => (sql.includes("SELECT vps_id FROM gateways") ? (vpsId ? { vps_id: vpsId } : null) : null)),
      all: vi.fn(async () => (sql.includes("SELECT id, status") ? { results: runningSessions } : { results: [] })),
      run: vi.fn(async () => ({})),
    })),
  }));

  const env = {
    DB: { prepare },
    KV: {} as KVNamespace,
    GATEWAY_HUB: {} as DurableObjectNamespace,
    DO_CLIENT_ID: "do-client-id",
    DO_CLIENT_SECRET: "do-client-secret",
    JWT_SECRET: "jwt-secret",
    GATEWAY_TOKEN_SALT: "gateway-salt",
    DO_TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };

  const hub = new GatewayHub({} as DurableObjectState, env);
  createdHubs.push(hub);
  return hub;
}

function makeSocket(send = vi.fn(), readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    send,
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe("GatewayHub", () => {
  it("allows one active writer per session and makes other sockets read-only for input/resize", () => {
    const hub = makeHub();
    const gatewaySend = vi.fn();
    const ws1Send = vi.fn();
    const ws2Send = vi.fn();
    const ws1 = makeSocket(ws1Send);
    const ws2 = makeSocket(ws2Send);

    (hub as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket = makeSocket(gatewaySend);

    (
      hub as unknown as {
        onBrowserText: (ws: WebSocket, sessionId: string, data: string) => void;
      }
    ).onBrowserText(
      ws1,
      "ses-1",
      JSON.stringify({
        type: "session.input",
        schema_version: "1",
        request_id: "req-1",
        session_id: "ses-1",
        data: "Cg==",
      }),
    );

    (
      hub as unknown as {
        onBrowserText: (ws: WebSocket, sessionId: string, data: string) => void;
      }
    ).onBrowserText(
      ws2,
      "ses-1",
      JSON.stringify({
        type: "session.resize",
        schema_version: "1",
        request_id: "req-2",
        session_id: "ses-1",
        cols: 120,
        rows: 30,
      }),
    );

    expect(gatewaySend).toHaveBeenCalledTimes(1);
    expect(gatewaySend.mock.calls[0][0]).toContain("\"request_id\":\"req-1\"");
    expect(ws2Send).toHaveBeenCalledTimes(1);
    expect(ws2Send.mock.calls[0][0]).toContain("\"type\":\"ack\"");
    expect(ws2Send.mock.calls[0][0]).toContain("\"ok\":false");
    expect(ws2Send.mock.calls[0][0]).toContain("read-only");
  });

  it("allows writer takeover after input lease timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T00:00:00.000Z"));

    const hub = makeHub();
    const gatewaySend = vi.fn();
    const ws1 = makeSocket();
    const ws2 = makeSocket();

    (hub as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket = makeSocket(gatewaySend);

    const onBrowserText = (
      hub as unknown as {
        onBrowserText: (ws: WebSocket, sessionId: string, data: string) => void;
      }
    ).onBrowserText.bind(hub);

    onBrowserText(
      ws1,
      "ses-1",
      JSON.stringify({
        type: "session.input",
        schema_version: "1",
        request_id: "req-1",
        session_id: "ses-1",
        data: "Cg==",
      }),
    );

    vi.advanceTimersByTime(31_000);

    onBrowserText(
      ws2,
      "ses-1",
      JSON.stringify({
        type: "session.input",
        schema_version: "1",
        request_id: "req-2",
        session_id: "ses-1",
        data: "bHMK",
      }),
    );

    expect(gatewaySend).toHaveBeenCalledTimes(2);
    expect(gatewaySend.mock.calls[1][0]).toContain("\"request_id\":\"req-2\"");

    vi.useRealTimers();
  });

  it("rejects mismatched gateway_id in gateway.hello", async () => {
    const hub = makeHub();
    const close = vi.fn();

    (hub as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close,
    } as unknown as WebSocket;
    (hub as unknown as { expectedGatewayId: string | null }).expectedGatewayId = "gw-auth";

    await (
      hub as unknown as {
        onGatewayHello: (msg: Record<string, unknown>) => Promise<void>;
      }
    ).onGatewayHello({
      type: "gateway.hello",
      schema_version: "1",
      gateway_id: "gw-other",
      version: "0.1.0",
      hostname: "test-host",
      system_info: {
        os: "linux",
        arch: "amd64",
        cpus: 4,
        ram_total_bytes: 1024,
        disk_total_bytes: 1024,
      },
    });

    expect(close).toHaveBeenCalledWith(1008, "gateway_id mismatch");
    expect(mocks.updateGatewayVersion).not.toHaveBeenCalled();
    expect(mocks.updateGatewayConnected).not.toHaveBeenCalled();
  });

  it("resolves snapshot command with snapshot payload", async () => {
    const hub = makeHub();
    const gatewaySend = vi.fn();

    (hub as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket = {
      readyState: WebSocket.OPEN,
      send: gatewaySend,
      close: vi.fn(),
    } as unknown as WebSocket;

    const command = {
      type: "session.snapshot",
      schema_version: "1",
      request_id: "req-snapshot-1",
      session_id: "ses-1",
    };

    const promise = (
      hub as unknown as {
        sendCommand: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).sendCommand(command);

    (
      hub as unknown as {
        onSessionSnapshot: (msg: Record<string, unknown>) => void;
      }
    ).onSessionSnapshot({
      type: "session.snapshot",
      schema_version: "1",
      request_id: "req-snapshot-1",
      session_id: "ses-1",
      content: "snapshot-body",
      cols: 120,
      rows: 40,
    });

    await expect(promise).resolves.toMatchObject({
      type: "session.snapshot",
      session_id: "ses-1",
      content: "snapshot-body",
    });
    expect(gatewaySend).toHaveBeenCalledOnce();
  });

  it("forwards request-scoped events to pending source socket and resolves pending command", async () => {
    const hub = makeHub();
    const sourceSend = vi.fn();
    const resolve = vi.fn();

    const sourceSocket = {
      readyState: WebSocket.OPEN,
      send: sourceSend,
      close: vi.fn(),
    } as unknown as WebSocket;

    (
      hub as unknown as {
        pending: Map<string, { resolve: () => void; reject: () => void; startedAt: number; sourceSocket: WebSocket | null }>;
      }
    ).pending.set("req-keys-1", {
      resolve,
      reject: vi.fn(),
      startedAt: Date.now(),
      sourceSocket,
    });

    await (
      hub as unknown as {
        onGatewayText: (data: string) => Promise<void>;
      }
    ).onGatewayText(
      JSON.stringify({
        type: "ssh.keys",
        schema_version: "1",
        request_id: "req-keys-1",
        keys: [],
      }),
    );

    expect(sourceSend).toHaveBeenCalledOnce();
    expect(sourceSend.mock.calls[0][0]).toContain("\"type\":\"ssh.keys\"");
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssh.keys",
        request_id: "req-keys-1",
      }),
    );
    expect(
      (hub as unknown as { pending: Map<string, unknown> }).pending.has("req-keys-1"),
    ).toBe(false);
  });

  it("forwards realtime ack to browser waiter when not in pending command map", () => {
    const hub = makeHub();
    const browserSend = vi.fn();
    const browserSocket = {
      readyState: WebSocket.OPEN,
      send: browserSend,
      close: vi.fn(),
    } as unknown as WebSocket;
    const timeout = setTimeout(() => {}, 30_000);

    (
      hub as unknown as {
        browserAckWaiters: Map<string, { ws: WebSocket; timeout: ReturnType<typeof setTimeout> }>;
      }
    ).browserAckWaiters.set("req-realtime-1", {
      ws: browserSocket,
      timeout,
    });
    (
      hub as unknown as {
        browserAckBySocket: Map<WebSocket, Set<string>>;
      }
    ).browserAckBySocket.set(browserSocket, new Set(["req-realtime-1"]));

    (
      hub as unknown as {
        onAck: (msg: Record<string, unknown>) => void;
      }
    ).onAck({
      type: "ack",
      schema_version: "1",
      request_id: "req-realtime-1",
      ok: false,
      error: "session not found",
    });

    expect(browserSend).toHaveBeenCalledOnce();
    expect(browserSend.mock.calls[0][0]).toContain("\"type\":\"ack\"");
    expect(
      (hub as unknown as { browserAckWaiters: Map<string, unknown> }).browserAckWaiters.size,
    ).toBe(0);
  });

  it("sends schema-versioned protocol error on invalid browser payload", () => {
    const hub = makeHub();
    const wsSend = vi.fn();
    const ws = makeSocket(wsSend);

    (
      hub as unknown as {
        onBrowserText: (ws: WebSocket, sessionId: string, data: string) => void;
      }
    ).onBrowserText(ws, "ses-1", "{not-json");

    expect(wsSend).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(wsSend.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload.type).toBe("error");
    expect(payload.schema_version).toBe("1");
    expect(payload.code).toBe("invalid_payload");
  });

  it("returns schema-versioned pong to browser ping", () => {
    const hub = makeHub();
    const wsSend = vi.fn();
    const ws = makeSocket(wsSend);

    (
      hub as unknown as {
        onBrowserText: (ws: WebSocket, sessionId: string, data: string) => void;
      }
    ).onBrowserText(ws, "ses-1", JSON.stringify({ type: "ping" }));

    expect(wsSend).toHaveBeenCalledOnce();
    expect(wsSend.mock.calls[0][0]).toBe(JSON.stringify({ type: "pong", schema_version: "1" }));
  });

  it("reconciles active sessions from gateway.health", async () => {
    const hub = makeHub("vps-1", [
      { id: "ses-active-running", status: "running" },
      { id: "ses-active-starting", status: "starting" },
      { id: "ses-stale-running", status: "running" },
    ]);

    await (
      hub as unknown as {
        onGatewayHealth: (msg: Record<string, unknown>) => Promise<void>;
      }
    ).onGatewayHealth({
      type: "gateway.health",
      schema_version: "1",
      gateway_id: "gw-1",
      timestamp: "2026-03-04T00:00:00.000Z",
      active_sessions: [
        { session_id: "ses-active-running", last_activity_at: "2026-03-04T00:00:00.000Z" },
        { session_id: "ses-active-starting", last_activity_at: "2026-03-04T00:00:01.000Z" },
      ],
    });

    expect(mocks.updateGatewayLastSeen).toHaveBeenCalledWith(expect.anything(), "gw-1");
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "ses-active-starting",
      "running",
    );
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "ses-stale-running",
      "ended",
    );
    expect(mocks.updateSessionStatus).toHaveBeenCalledTimes(2);
  });

  it("does not end missing sessions immediately after gateway.hello", async () => {
    const hub = makeHub("vps-1", [
      { id: "ses-keep-running", status: "running" },
      { id: "ses-active-starting", status: "starting" },
    ]);

    await (
      hub as unknown as {
        onGatewayHello: (msg: Record<string, unknown>) => Promise<void>;
      }
    ).onGatewayHello({
      type: "gateway.hello",
      schema_version: "1",
      gateway_id: "gw-1",
      version: "0.1.0",
      hostname: "test-host",
      system_info: {
        os: "linux",
        arch: "amd64",
        cpus: 4,
        ram_total_bytes: 1024,
        disk_total_bytes: 1024,
      },
    });

    mocks.updateSessionStatus.mockClear();

    await (
      hub as unknown as {
        onGatewayHealth: (msg: Record<string, unknown>) => Promise<void>;
      }
    ).onGatewayHealth({
      type: "gateway.health",
      schema_version: "1",
      gateway_id: "gw-1",
      timestamp: "2026-03-04T00:00:00.000Z",
      active_sessions: [
        { session_id: "ses-active-starting", last_activity_at: "2026-03-04T00:00:01.000Z" },
      ],
    });

    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "ses-active-starting",
      "running",
    );
    expect(mocks.updateSessionStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "ses-keep-running",
      "ended",
    );
  });
});
