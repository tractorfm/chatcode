import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayHub } from "../src/durables/GatewayHub";

const mocks = vi.hoisted(() => ({
  updateGatewayConnected: vi.fn(async () => {}),
  updateGatewayVersion: vi.fn(async () => {}),
  updateGatewayLastSeen: vi.fn(async () => {}),
  updateSessionStatus: vi.fn(async () => {}),
  updateVPSStatus: vi.fn(async () => {}),
  getGatewayByVPS: vi.fn(async () => null),
}));

vi.mock("../src/db/schema.js", () => ({
  updateGatewayConnected: mocks.updateGatewayConnected,
  updateGatewayVersion: mocks.updateGatewayVersion,
  updateGatewayLastSeen: mocks.updateGatewayLastSeen,
  updateSessionStatus: mocks.updateSessionStatus,
  updateVPSStatus: mocks.updateVPSStatus,
  getGatewayByVPS: mocks.getGatewayByVPS,
}));

const createdHubs: GatewayHub[] = [];

afterEach(() => {
  for (const hub of createdHubs) {
    const interval = (hub as unknown as { idleCleanupInterval: number | null }).idleCleanupInterval;
    if (interval) clearInterval(interval);
  }
  createdHubs.length = 0;
  vi.clearAllMocks();
});

function makeHub(vpsId: string | null = "vps-1"): GatewayHub {
  const first = vi.fn(async () => (vpsId ? { vps_id: vpsId } : null));
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ first, run }));
  const prepare = vi.fn(() => ({ bind }));

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

describe("GatewayHub", () => {
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

  it("forwards request-scoped events to pending source socket", async () => {
    const hub = makeHub();
    const sourceSend = vi.fn();

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
      resolve: vi.fn(),
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
  });
});
