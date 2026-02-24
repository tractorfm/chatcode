import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleSessionCreate,
  handleSessionSnapshot,
} from "../src/routes/sessions";

const mocks = vi.hoisted(() => ({
  getVPS: vi.fn(),
  getGatewayByVPS: vi.fn(),
  createSession: vi.fn(async () => {}),
  getSession: vi.fn(),
  listSessionsByVPS: vi.fn(async () => []),
  updateSessionStatus: vi.fn(async () => {}),
  newSessionId: vi.fn(() => "ses-test-1"),
}));

vi.mock("../src/db/schema.js", () => ({
  getVPS: mocks.getVPS,
  getGatewayByVPS: mocks.getGatewayByVPS,
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  listSessionsByVPS: mocks.listSessionsByVPS,
  updateSessionStatus: mocks.updateSessionStatus,
}));

vi.mock("../src/lib/ids.js", () => ({
  newSessionId: mocks.newSessionId,
}));

function makeEnv(doResponse: Response) {
  const stubFetch = vi.fn(async () => doResponse);
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
    mocks.getGatewayByVPS.mockResolvedValue({ id: "gw-1", connected: 1 });
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
    expect(stubFetch).toHaveBeenCalledOnce();
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
    const { env } = makeEnv(new Response("gateway failed", { status: 502 }));

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
});
