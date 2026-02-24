import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleVPSDelete } from "../src/routes/vps";

const mocks = vi.hoisted(() => ({
  createVPS: vi.fn(async () => {}),
  getVPS: vi.fn(),
  listVPSByUser: vi.fn(async () => []),
  updateVPSStatus: vi.fn(async () => {}),
  deleteVPSCascade: vi.fn(async () => {}),
  createGateway: vi.fn(async () => {}),
  getGatewayByVPS: vi.fn(),
  getDOConnection: vi.fn(),
  getAccessToken: vi.fn(),
  createDroplet: vi.fn(),
  deleteDroplet: vi.fn(),
  powerOffDroplet: vi.fn(),
  powerOnDroplet: vi.fn(),
  hashGatewayToken: vi.fn(async () => "hash-token"),
  newVPSId: vi.fn(() => "vps-test-1"),
  newGatewayId: vi.fn(() => "gw-test-1"),
  randomHex: vi.fn(() => "abcdef123456"),
}));

vi.mock("../src/db/schema.js", () => ({
  createVPS: mocks.createVPS,
  getVPS: mocks.getVPS,
  listVPSByUser: mocks.listVPSByUser,
  updateVPSStatus: mocks.updateVPSStatus,
  deleteVPSCascade: mocks.deleteVPSCascade,
  createGateway: mocks.createGateway,
  getGatewayByVPS: mocks.getGatewayByVPS,
  getDOConnection: mocks.getDOConnection,
}));

vi.mock("../src/lib/do-api.js", () => ({
  getAccessToken: mocks.getAccessToken,
  createDroplet: mocks.createDroplet,
  deleteDroplet: mocks.deleteDroplet,
  powerOffDroplet: mocks.powerOffDroplet,
  powerOnDroplet: mocks.powerOnDroplet,
}));

vi.mock("../src/lib/auth.js", () => ({
  hashGatewayToken: mocks.hashGatewayToken,
}));

vi.mock("../src/lib/ids.js", () => ({
  newVPSId: mocks.newVPSId,
  newGatewayId: mocks.newGatewayId,
  randomHex: mocks.randomHex,
}));

function makeEnv() {
  const doShutdownFetch = vi.fn(async () => new Response("ok", { status: 200 }));
  const stub = { fetch: doShutdownFetch };
  const env = {
    DB: {} as D1Database,
    GATEWAY_HUB: {
      idFromName: vi.fn(() => "do-gw-1"),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace,
    DO_TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    DO_CLIENT_ID: "do-client-id",
    DO_CLIENT_SECRET: "do-client-secret",
    GATEWAY_TOKEN_SALT: "gateway-token-salt",
  };
  return { env, doShutdownFetch };
}

describe("routes/vps delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVPS.mockResolvedValue({
      id: "vps-1",
      user_id: "usr-1",
      droplet_id: 123456,
    });
    mocks.getGatewayByVPS.mockResolvedValue({ id: "gw-1" });
    mocks.getAccessToken.mockResolvedValue("do-access-token");
  });

  it("keeps D1 rows when cloud droplet delete fails", async () => {
    const { env, doShutdownFetch } = makeEnv();
    mocks.deleteDroplet.mockRejectedValue(new Error("DO API unavailable"));

    const res = await handleVPSDelete(
      new Request("https://cp.example.test/vps/vps-1", { method: "DELETE" }),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(502);
    expect(doShutdownFetch).toHaveBeenCalledOnce();
    expect(mocks.updateVPSStatus).toHaveBeenCalledWith(env.DB, "vps-1", "deleting");
    expect(mocks.deleteDroplet).toHaveBeenCalledOnce();
    expect(mocks.deleteVPSCascade).not.toHaveBeenCalled();
  });

  it("deletes D1 rows after successful droplet deletion", async () => {
    const { env, doShutdownFetch } = makeEnv();
    mocks.deleteDroplet.mockResolvedValue(undefined);

    const res = await handleVPSDelete(
      new Request("https://cp.example.test/vps/vps-1", { method: "DELETE" }),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(204);
    expect(doShutdownFetch).toHaveBeenCalledOnce();
    expect(mocks.deleteDroplet).toHaveBeenCalledWith("do-access-token", 123456);
    expect(mocks.deleteVPSCascade).toHaveBeenCalledWith(env.DB, "vps-1");
  });
});
