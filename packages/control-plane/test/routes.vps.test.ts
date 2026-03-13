import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleVPSCreate,
  handleVPSDelete,
  handleGatewayUnlink,
  handleVPSManualCreate,
  handleVPSManualCommand,
  handleVPSUpdate,
  handleWorkspaceFolderList,
  handleVPSOptions,
} from "../src/routes/vps";

const mocks = vi.hoisted(() => ({
  createVPS: vi.fn(async () => {}),
  getVPS: vi.fn(),
  listVPSByUser: vi.fn(async () => []),
  updateVPSStatus: vi.fn(async () => {}),
  updateVPSLabel: vi.fn(async () => {}),
  updateGatewayAuthTokenHash: vi.fn(async () => {}),
  deleteVPSCascade: vi.fn(async () => {}),
  createGateway: vi.fn(async () => {}),
  getGateway: vi.fn(),
  getGatewayByVPS: vi.fn(),
  getDOConnection: vi.fn(),
  getAccessToken: vi.fn(),
  createDroplet: vi.fn(),
  deleteDroplet: vi.fn(),
  powerOffDroplet: vi.fn(),
  powerOnDroplet: vi.fn(),
  listRegions: vi.fn(async () => []),
  listSizes: vi.fn(async () => []),
  listDistributionImages: vi.fn(async () => []),
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
  updateVPSLabel: mocks.updateVPSLabel,
  updateGatewayAuthTokenHash: mocks.updateGatewayAuthTokenHash,
  deleteVPSCascade: mocks.deleteVPSCascade,
  createGateway: mocks.createGateway,
  getGateway: mocks.getGateway,
  getGatewayByVPS: mocks.getGatewayByVPS,
  getDOConnection: mocks.getDOConnection,
}));

vi.mock("../src/lib/do-api.js", () => ({
  getAccessToken: mocks.getAccessToken,
  createDroplet: mocks.createDroplet,
  deleteDroplet: mocks.deleteDroplet,
  powerOffDroplet: mocks.powerOffDroplet,
  powerOnDroplet: mocks.powerOnDroplet,
  listRegions: mocks.listRegions,
  listSizes: mocks.listSizes,
  listDistributionImages: mocks.listDistributionImages,
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
      label: null,
      region: "nyc1",
      size: "s-1vcpu-512mb-10gb",
      ipv4: "1.2.3.4",
      status: "active",
      provisioning_deadline_at: null,
      created_at: 1,
      updated_at: 1,
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
    mocks.getGateway.mockResolvedValue({
      id: "gw-1",
      vps_id: "vps-1",
      auth_token_hash: "hash",
      version: null,
      host_os: null,
      last_seen_at: null,
      connected: 0,
      created_at: 1,
    });
    mocks.getGatewayByVPS.mockResolvedValue({ id: "gw-1" });
    mocks.getAccessToken.mockResolvedValue("do-access-token");
    mocks.createDroplet.mockResolvedValue({
      id: 777,
      networks: { v4: [{ ip_address: "1.2.3.4", type: "public" }] },
    });
    mocks.createVPS.mockResolvedValue(undefined);
    mocks.createGateway.mockResolvedValue(undefined);
    mocks.listRegions.mockResolvedValue([]);
    mocks.listSizes.mockResolvedValue([]);
    mocks.listDistributionImages.mockResolvedValue([]);
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
    await expect(res.json()).resolves.toMatchObject({
      status: "provisioning",
      vps: {
        id: "vps-test-1",
        provider: "digitalocean",
        gateway_id: "gw-test-1",
        gateway_connected: false,
      },
    });
    expect(mocks.createDroplet).toHaveBeenCalledWith(
      "do-access-token",
      expect.objectContaining({
        region: "nyc1",
        size: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
      }),
    );
    const createPayload = mocks.createDroplet.mock.calls[0]?.[1];
    expect(createPayload?.user_data).toContain("BOOTSTRAP_URL=\"$GATEWAY_RELEASE_BASE_URL/$GATEWAY_VERSION/cloud-init.sh\"");
    expect(createPayload?.user_data).toContain("export GATEWAY_ID='gw-test-1'");
    expect(createPayload?.user_data).toContain("export GATEWAY_CP_URL='wss://cp.example.test/gw/connect'");
    expect(createPayload?.user_data).toContain("export GATEWAY_VERSION='v0.1.6'");
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

  it("returns live DigitalOcean options grouped for onboarding", async () => {
    const { env } = makeEnv();
    mocks.listRegions.mockResolvedValue([
      { slug: "nyc3", name: "New York 3", available: true },
      { slug: "sfo3", name: "San Francisco 3", available: true },
      { slug: "tor1", name: "Toronto 1", available: true },
      { slug: "ams3", name: "Amsterdam 3", available: true },
      { slug: "fra1", name: "Frankfurt 1", available: true },
      { slug: "lon1", name: "London 1", available: true },
      { slug: "blr1", name: "Bangalore 1", available: true },
      { slug: "sgp1", name: "Singapore 1", available: true },
      { slug: "syd1", name: "Sydney 1", available: true },
    ]);
    mocks.listSizes.mockResolvedValue([
      { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_monthly: 6, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, disk: 50, transfer: 2, price_monthly: 12, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-2vcpu-2gb", memory: 2048, vcpus: 2, disk: 60, transfer: 3, price_monthly: 18, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80, transfer: 4, price_monthly: 24, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, transfer: 5, price_monthly: 48, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-8vcpu-16gb", memory: 16384, vcpus: 8, disk: 320, transfer: 6, price_monthly: 96, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-1vcpu-1gb-intel", memory: 1024, vcpus: 1, disk: 35, transfer: 1, price_monthly: 8, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-1vcpu-2gb-intel", memory: 2048, vcpus: 1, disk: 60, transfer: 2, price_monthly: 16, available: true, regions: ["ams3", "nyc3"] },
      { slug: "s-2vcpu-2gb-intel", memory: 2048, vcpus: 2, disk: 70, transfer: 3, price_monthly: 24, available: true, regions: ["ams3", "nyc3"] },
    ]);
    mocks.listDistributionImages.mockResolvedValue([
      { id: 1, slug: "ubuntu-24-04-x64", name: "24.04 (LTS) x64", distribution: "Ubuntu", type: "distribution", public: true, created_at: "2024-04-01T00:00:00Z" },
      { id: 2, slug: "ubuntu-25-10-x64", name: "25.10 x64", distribution: "Ubuntu", type: "distribution", public: true, created_at: "2025-10-01T00:00:00Z" },
      { id: 3, slug: "debian-13-x64", name: "13 x64", distribution: "Debian", type: "distribution", public: true, created_at: "2025-08-01T00:00:00Z" },
    ]);

    const res = await handleVPSOptions(
      new Request("https://cp.example.test/vps/options"),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      live: true,
      regions: expect.arrayContaining([
        expect.objectContaining({
          label: "Americas",
          options: expect.arrayContaining([
            expect.objectContaining({ label: "New York", slug: "nyc3" }),
          ]),
        }),
      ]),
      plans: {
        regular: expect.arrayContaining([
          expect.objectContaining({ slug: "s-2vcpu-2gb", price_monthly: 18 }),
        ]),
        premium_intel: expect.arrayContaining([
          expect.objectContaining({ slug: "s-1vcpu-2gb-intel", price_monthly: 16 }),
        ]),
      },
      images: [
        { slug: "ubuntu-24-04-x64", family: "ubuntu", label: "Ubuntu 24.04 LTS" },
        { slug: "debian-13-x64", family: "debian", label: "Debian 13" },
      ],
      defaults: expect.objectContaining({
        region: "ams3",
        plan_family: "regular",
        size: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
      }),
    });
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

  it("unlinks manual servers without calling DigitalOcean", async () => {
    const { env, doShutdownFetch } = makeEnv();
    mocks.getVPS.mockResolvedValue({
      id: "vps-manual-1",
      user_id: "usr-1",
      droplet_id: 0,
      label: "raspi",
      region: "manual",
      size: "manual:raspi",
      ipv4: null,
      status: "active",
      provisioning_deadline_at: null,
      created_at: 1,
      updated_at: 1,
    });

    const res = await handleVPSDelete(
      new Request("https://cp.example.test/vps/vps-manual-1", { method: "DELETE" }),
      env,
      { userId: "usr-1" },
      "vps-manual-1",
    );

    expect(res.status).toBe(204);
    expect(doShutdownFetch).toHaveBeenCalledOnce();
    expect(mocks.updateVPSStatus).toHaveBeenCalledWith(env.DB, "vps-manual-1", "deleting");
    expect(mocks.deleteDroplet).not.toHaveBeenCalled();
    expect(mocks.deleteVPSCascade).toHaveBeenCalledWith(env.DB, "vps-manual-1");
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
      gateway_id: "gw-test-1",
      gateway_auth_token: "abcdef123456",
      cp_url: "wss://cp.example.test/gw/connect",
      vps: {
        id: "vps-test-1",
        provider: "manual",
        label: "raspi",
      },
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

  it("rejects invalid manual label", async () => {
    const { env } = makeEnv();

    const res = await handleVPSManualCreate(
      new Request("https://cp.example.test/vps/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "bad<script>" }),
      }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid label" });
    expect(mocks.createVPS).not.toHaveBeenCalled();
  });

  it("reissues manual install command for disconnected BYO server", async () => {
    const { env } = makeEnv();
    mocks.getVPS.mockResolvedValue({
      id: "vps-manual-1",
      user_id: "usr-1",
      droplet_id: 0,
      label: "raspi",
      region: "manual",
      size: "manual:raspi",
      ipv4: null,
      status: "provisioning",
      provisioning_deadline_at: null,
      created_at: 1,
      updated_at: 1,
    });
    mocks.getGatewayByVPS.mockResolvedValue({
      id: "gw-manual-1",
      vps_id: "vps-manual-1",
      auth_token_hash: "old-hash",
      version: null,
      host_os: null,
      last_seen_at: null,
      connected: 0,
      created_at: 1,
    });
    mocks.randomHex.mockReturnValue("fresh-token");

    const res = await handleVPSManualCommand(
      new Request("https://cp.example.test/vps/vps-manual-1/manual-command", {
        method: "POST",
      }),
      env,
      { userId: "usr-1" },
      "vps-manual-1",
    );

    expect(res.status).toBe(200);
    expect(mocks.updateGatewayAuthTokenHash).toHaveBeenCalledWith(
      env.DB,
      "gw-manual-1",
      "hash-token",
    );
    await expect(res.json()).resolves.toMatchObject({
      gateway_id: "gw-manual-1",
      gateway_auth_token: "fresh-token",
      vps: {
        id: "vps-manual-1",
        provider: "manual",
      },
    });
  });

  it("rejects manual command refresh when gateway is already connected", async () => {
    const { env } = makeEnv();
    mocks.getVPS.mockResolvedValue({
      id: "vps-manual-1",
      user_id: "usr-1",
      droplet_id: 0,
      label: "raspi",
      region: "manual",
      size: "manual:raspi",
      ipv4: null,
      status: "active",
      provisioning_deadline_at: null,
      created_at: 1,
      updated_at: 1,
    });
    mocks.getGatewayByVPS.mockResolvedValue({
      id: "gw-manual-1",
      vps_id: "vps-manual-1",
      auth_token_hash: "old-hash",
      version: "v0.0.13",
      host_os: "linux",
      last_seen_at: 1,
      connected: 1,
      created_at: 1,
    });

    const res = await handleVPSManualCommand(
      new Request("https://cp.example.test/vps/vps-manual-1/manual-command", {
        method: "POST",
      }),
      env,
      { userId: "usr-1" },
      "vps-manual-1",
    );

    expect(res.status).toBe(409);
    expect(mocks.updateGatewayAuthTokenHash).not.toHaveBeenCalled();
  });

  it("updates vps label", async () => {
    const { env } = makeEnv();

    const res = await handleVPSUpdate(
      new Request("https://cp.example.test/vps/vps-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "my server" }),
      }),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(200);
    expect(mocks.updateVPSLabel).toHaveBeenCalledWith(env.DB, "vps-1", "my server");
    await expect(res.json()).resolves.toMatchObject({
      id: "vps-1",
      label: "my server",
    });
  });

  it("rejects invalid vps label", async () => {
    const { env } = makeEnv();

    const res = await handleVPSUpdate(
      new Request("https://cp.example.test/vps/vps-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "x".repeat(65) }),
      }),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(400);
    expect(mocks.updateVPSLabel).not.toHaveBeenCalled();
  });

  it("unlinks a gateway without deleting provider resources", async () => {
    const { env, doShutdownFetch } = makeEnv();

    const res = await handleGatewayUnlink(env, "gw-1");

    expect(res.status).toBe(204);
    expect(doShutdownFetch).toHaveBeenCalledOnce();
    expect(mocks.deleteDroplet).not.toHaveBeenCalled();
    expect(mocks.deleteVPSCascade).toHaveBeenCalledWith(env.DB, "vps-1");
  });

  it("lists workspace folders via the gateway", async () => {
    const { env, doShutdownFetch } = makeEnv();
    mocks.getGatewayByVPS.mockResolvedValue({
      id: "gw-1",
      vps_id: "vps-1",
      auth_token_hash: "hash",
      version: "v0.0.16",
      host_os: "linux",
      last_seen_at: 1,
      connected: 1,
      created_at: 1,
    });
    doShutdownFetch.mockResolvedValue(
      new Response(JSON.stringify({
        type: "workspace.folders",
        request_id: "workspace-1",
        folders: ["chatcode", "notes"],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await handleWorkspaceFolderList(
      new Request("https://cp.example.test/vps/vps-1/workspace-folders"),
      env,
      { userId: "usr-1" },
      "vps-1",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ folders: ["chatcode", "notes"] });
  });
});
