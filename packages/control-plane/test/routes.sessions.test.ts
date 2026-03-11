import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAgentList,
  handleSessionCreate,
  handleSessionUpdate,
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
  updateSessionTitle: vi.fn(async () => {}),
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
  updateSessionTitle: mocks.updateSessionTitle,
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
    mocks.listSessionsByVPS.mockResolvedValue([]);
    mocks.getSession.mockResolvedValue({
      id: "ses-1",
      user_id: "usr-1",
      vps_id: "vps-1",
      title: "Old Title",
      agent_type: "claude-code",
      workdir: "/home/vibe",
      status: "running",
      created_at: 1,
      last_activity_at: 1,
    });
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

  it("returns 503 and clears gateway connected when command relay loses gateway", async () => {
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
      new Response(JSON.stringify({ error: "gateway not connected" }), {
        status: 503,
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

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "gateway not connected" });
    expect(mocks.updateGatewayConnected).toHaveBeenCalledWith(env.DB, "gw-1", false);
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(env.DB, "ses-test-1", "error");
  });

  it("retries session.create once after transient gateway reconnect", async () => {
    const { env, stubFetch } = makeEnv([
      new Response(
        JSON.stringify({
          type: "agents.status",
          schema_version: "1",
          request_id: "agents-1",
          agents: [{ agent: "claude-code", binary: "claude", installed: true, version: "1.0.0" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      new Response(JSON.stringify({ error: "gateway not connected" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ connected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ type: "ack", schema_version: "1", request_id: "ses-test-1", ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Retry Session",
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
    expect(stubFetch).toHaveBeenCalledTimes(4);
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

  it("returns 409 when free-plan open session limit is reached", async () => {
    mocks.listSessionsByVPS.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `ses-${index}`,
        status: "running",
      })),
    );
    const { env, stubFetch } = makeEnv(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Limit Session",
        agent_type: "none",
        workdir: "/home/vibe",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "session_limit_reached",
      limit: 10,
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("maps gateway hard-cap session limit errors to structured 409 responses", async () => {
    const { env } = makeEnv(
      new Response(JSON.stringify({ error: "session limit reached (50)" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Limit Session",
        agent_type: "none",
        workdir: "/home/vibe",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "session_limit_reached",
      limit: 50,
    });
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(env.DB, "ses-test-1", "error");
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

  it("updates session title", async () => {
    const { env } = makeEnv(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await handleSessionUpdate(
      new Request("https://cp.example.test/vps/vps-1/sessions/ses-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed Session" }),
      }),
      env,
      { userId: "usr-1" },
      "vps-1",
      "ses-1",
    );

    expect(res.status).toBe(200);
    expect(mocks.updateSessionTitle).toHaveBeenCalledWith(env.DB, "ses-1", "Renamed Session");
    await expect(res.json()).resolves.toMatchObject({
      id: "ses-1",
      title: "Renamed Session",
    });
  });

  it("rejects invalid session title", async () => {
    const { env } = makeEnv(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await handleSessionUpdate(
      new Request("https://cp.example.test/vps/vps-1/sessions/ses-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      }),
      env,
      { userId: "usr-1" },
      "vps-1",
      "ses-1",
    );

    expect(res.status).toBe(400);
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("defaults session workdir to workspace root when omitted", async () => {
    const { env } = makeEnv(
      new Response(JSON.stringify({ type: "ack", schema_version: "1", request_id: "ses-test-1", ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = new Request("https://cp.example.test/vps/vps-1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Workspace Session",
        agent_type: "none",
      }),
    });

    const res = await handleSessionCreate(req, env, { userId: "usr-1" }, "vps-1");

    expect(res.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        workdir: "/home/vibe/workspace",
      }),
    );
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
