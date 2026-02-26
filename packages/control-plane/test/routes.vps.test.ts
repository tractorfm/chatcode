import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleVPSCreate, handleVPSDelete, handleVPSManualCreate } from "../src/routes/vps";

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
    APP_ENV: "staging",
    DEFAULT_DROPLET_REGION: "nyc1",
    DEFAULT_DROPLET_SIZE: "s-1vcpu-512mb-10gb",
    DEFAULT_DROPLET_IMAGE: "ubuntu-24-04-x64",
  };
  return { env, doShutdownFetch };
}

describe("routes/vps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVPS.mockResolvedValue({
      id: "vps-1",
      user_id: "usr-1",
      droplet_id: 123456,
    });
    mocks.getDOConnection.mockResolvedValue({
      user_id: "usr-1",
      access_token_enc: "enc",
      refresh_token_enc: "enc",
      token_key_version: 1,
      team_uuid: null,
      expires_at: 9999999999,
      created_at: 1,
      updated_at: 1,
    });
    mocks.getGatewayByVPS.mockResolvedValue({ id: "gw-1" });
    mocks.getAccessToken.mockResolvedValue("do-access-token");
    mocks.createDroplet.mockResolvedValue({
      id: 777,
      networks: { v4: [{ ip_address: "1.2.3.4", type: "public" }] },
    });
    mocks.createVPS.mockResolvedValue(undefined);
    mocks.createGateway.mockResolvedValue(undefined);
  });

  it("returns 502 when droplet provisioning fails", async () => {
    const { env } = makeEnv();
    mocks.createDroplet.mockRejectedValue(new Error("DO create failed"));

    const res = await handleVPSCreate(
      new Request("https://cp.example.test/vps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "nyc1", size: "s-1vcpu-1gb" }),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(502);
    expect(mocks.createVPS).not.toHaveBeenCalled();
    expect(mocks.createGateway).not.toHaveBeenCalled();
  });

  it("uses configurable defaults for droplet params", async () => {
    const { env } = makeEnv();

    const res = await handleVPSCreate(
      new Request("https://cp.example.test/vps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(201);
    expect(mocks.createDroplet).toHaveBeenCalledWith(
      "do-access-token",
      expect.objectContaining({
        region: "nyc1",
        size: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
      }),
    );
    const createPayload = mocks.createDroplet.mock.calls[0]?.[1];
    expect(createPayload?.user_data).toContain("User=vibe");
    expect(createPayload?.user_data).toContain(
      "Environment=GATEWAY_SSH_KEYS_FILE=/home/vibe/.ssh/authorized_keys",
    );
    expect(createPayload?.user_data).toContain(
      "install -d -m 700 -o vibe -g vibe /home/vibe/.ssh",
    );
  });

  it("rolls back droplet when DB write fails", async () => {
    const { env } = makeEnv();
    mocks.createVPS.mockRejectedValue(new Error("D1 write failed"));

    const res = await handleVPSCreate(
      new Request("https://cp.example.test/vps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "nyc1", size: "s-1vcpu-1gb" }),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(500);
    expect(mocks.deleteDroplet).toHaveBeenCalledWith("do-access-token", 777);
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

  it("mints manual gateway credentials in staging", async () => {
    const { env } = makeEnv();

    const res = await handleVPSManualCreate(
      new Request("https://cp.example.test/vps/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "raspi" }),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      vps_id: "vps-test-1",
      gateway_id: "gw-test-1",
      gateway_auth_token: "abcdef123456",
      cp_url: "wss://cp.example.test/gw/connect",
    });
    expect(mocks.createVPS).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        id: "vps-test-1",
        user_id: "usr-1",
        droplet_id: 0,
        region: "manual",
        status: "provisioning",
      }),
    );
    expect(mocks.createGateway).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        id: "gw-test-1",
        vps_id: "vps-test-1",
        auth_token_hash: "hash-token",
      }),
    );
  });

  it("blocks manual gateway credentials outside staging/dev", async () => {
    const { env } = makeEnv();
    env.APP_ENV = "prod";

    const res = await handleVPSManualCreate(
      new Request("https://cp.example.test/vps/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(404);
    expect(mocks.createVPS).not.toHaveBeenCalled();
    expect(mocks.createGateway).not.toHaveBeenCalled();
  });
});
