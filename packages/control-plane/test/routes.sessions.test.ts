import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAgentList,
  handleSessionCreate,
  handleSessionSnapshot,
  handleTerminalUpgrade,
} from "../src/routes/sessions";

const mocks = vi.hoisted(() => ({
  getVPS: vi.fn(),
  getGatewayByVPS: vi.fn(),
  createSession: vi.fn(async () => {}),
  getSession: vi.fn(),
  listSessionsByVPS: vi.fn(async () => []),
  updateSessionStatus: vi.fn(async () => {}),
  updateGatewayConnected: vi.fn(async () => {}),
  newSessionId: vi.fn(() => "ses-test-1"),
}));

vi.mock("../src/db/schema.js", () => ({
  getVPS: mocks.getVPS,
  getGatewayByVPS: mocks.getGatewayByVPS,
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  listSessionsByVPS: mocks.listSessionsByVPS,
  updateSessionStatus: mocks.updateSessionStatus,
  updateGatewayConnected: mocks.updateGatewayConnected,
}));

vi.mock("../src/lib/ids.js", () => ({
  newSessionId: mocks.newSessionId,
}));

function makeEnv(doResponse: Response | Response[]) {
  const responses = Array.isArray(doResponse) ? doResponse.slice() : [doResponse];
  const stubFetch = vi.fn(async () => responses.shift() || new Response("{}", { status: 200 }));
  const stub = { fetch: stubFetch };
  const env = {
    DB: {} as D1Database,
    GATEWAY_HUB: {
      idFromName: vi.fn(() => "do-gw-1"),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace,
  };
  return { env, stubFetch };
}

describe("routes/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVPS.mockResolvedValue({ id: "vps-1", user_id: "usr-1", status: "active" });
    mocks.getGatewayByVPS.mockResolvedValue({
      id: "gw-1",
      connected: 1,
      last_seen_at: Math.floor(Date.now() / 1000),
    });
    mocks.getSession.mockResolvedValue({ id: "ses-1", vps_id: "vps-1" });
  });

  it("returns snapshot payload from GatewayHub command path", async () => {
    const { env, stubFetch } = makeEnv(
      new Response(
        JSON.stringify({
          type: "session.snapshot",
          schema_version: "1",
          session_id: "ses-1",
          content: "hello snapshot",
          cols: 100,
          rows: 30,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleSessionSnapshot(
      new Request("https://cp.example.test/vps/vps-1/sessions/ses-1/snapshot"),
      env,
      { userId: "usr-1" },
      "vps-1",
      "ses-1",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      type: "session.snapshot",
      session_id: "ses-1",
      content: "hello snapshot",
    });
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it("returns installed agent status from gateway command path", async () => {
    const { env, stubFetch } = makeEnv(
      new Response(
        JSON.stringify({
          type: "agents.status",
          schema_version: "1",
          request_id: "agents-1",
          agents: [
            { agent: "claude-code", binary: "claude", installed: true, version: "1.0.0" },
            { agent: "codex", binary: "codex", installed: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleAgentList(
      new Request("https://cp.example.test/vps/vps-1/agents"),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      agents: [
        { agent: "claude-code", binary: "claude", installed: true, version: "1.0.0" },
        { agent: "codex", binary: "codex", installed: false },
      ],
    });
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when snapshot session does not belong to vps", async () => {
    mocks.getSession.mockResolvedValue(null);
    const { env, stubFetch } = makeEnv(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const res = await handleSessionSnapshot(
      new Request("https://cp.example.test/vps/vps-1/sessions/ses-x/snapshot"),
      env,
      { userId: "usr-1" },
      "vps-1",
      "ses-x",
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "session not found" });
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("marks session as error when session.create command fails", async () => {
    const { env } = makeEnv([
      new Response(
        JSON.stringify({
          type: "agents.status",
          schema_version: "1",
          request_id: "agents-1",
          agents: [{ agent: "claude-code", binary: "claude", installed: true, version: "1.0.0" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      new Response("gateway failed", { status: 502 }),
    ]);

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Session",
        agent_type: "claude-code",
        workdir: "/home/vibe",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(502);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(
      env.DB,
      "ses-test-1",
      "error",
    );
  });

  it("returns 409 when selected managed agent is not installed", async () => {
    const { env } = makeEnv(
      new Response(
        JSON.stringify({
          type: "agents.status",
          schema_version: "1",
          request_id: "agents-1",
          agents: [{ agent: "claude-code", binary: "claude", installed: false }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Session",
        agent_type: "claude-code",
        workdir: "/home/vibe",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "agent_not_installed",
      agent: "claude-code",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("continues session creation when agents.list is unavailable", async () => {
    const { env, stubFetch } = makeEnv([
      new Response(JSON.stringify({ error: "gateway disconnected" }), { status: 502 }),
      new Response(JSON.stringify({ type: "ack", schema_version: "1", request_id: "ses-test-1", ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Session",
        agent_type: "claude-code",
        workdir: "/home/vibe",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      session_id: "ses-test-1",
      status: "starting",
    });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(stubFetch).toHaveBeenCalledTimes(2);
  });

  it("returns 503 for terminal upgrade when gateway is disconnected", async () => {
    mocks.getGatewayByVPS.mockResolvedValue({ id: "gw-1", connected: 0 });
    const { env } = makeEnv(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const req = new Request("https://cp.example.test/vps/vps-1/terminal?session_id=ses-1", {
      headers: { Upgrade: "websocket" },
    });

    const res = await handleTerminalUpgrade(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "gateway not connected" });
  });

  it("returns 503 and clears DB connected when GatewayHub reports disconnected", async () => {
    mocks.getGatewayByVPS.mockResolvedValue({
      id: "gw-1",
      connected: 1,
      last_seen_at: 0,
    });
    const { env } = makeEnv(
      new Response(JSON.stringify({ connected: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = new Request("https://cp.example.test/vps/vps-1/terminal?session_id=ses-1", {
      headers: { Upgrade: "websocket" },
    });

    const res = await handleTerminalUpgrade(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "gateway not connected" });
    expect(mocks.updateGatewayConnected).toHaveBeenCalledWith(env.DB, "gw-1", false);
  });
});
