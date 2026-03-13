/**
 * VPS routes: create, list, get, destroy, power off/on.
 */

import type { Env, AuthContext } from "../types.js";
import {
  createVPS,
  getVPS,
  listVPSByUser,
  updateVPSStatus,
  updateVPSIpv4,
  updateVPSLabel,
  updateGatewayAuthTokenHash,
  deleteVPSCascade,
  createGateway,
  getGateway,
  getGatewayByVPS,
  listGatewaysByVPSIds,
  getDOConnection,
  type GatewayRow,
  type VPSRow,
} from "../db/schema.js";
import {
  getAccessToken,
  createDroplet,
  getDroplet,
  deleteDroplet,
  powerOffDroplet,
  powerOnDroplet,
  listRegions,
  listSizes,
  listDistributionImages,
  type DORegion,
  type DOSize,
  type DOImage,
} from "../lib/do-api.js";
import { hashGatewayToken } from "../lib/auth.js";
import { newVPSId, newGatewayId, randomHex } from "../lib/ids.js";

const PROVISIONING_TIMEOUT_SEC = 600; // 10 minutes
const DEFAULT_GATEWAY_VERSION = "v0.1.10";
const DEFAULT_GATEWAY_RELEASE_BASE_URL = "https://releases.chatcode.dev/gateway";
const DEFAULT_DROPLET_REGION = "ams3";
const DEFAULT_DROPLET_SIZE = "s-2vcpu-2gb";
const DEFAULT_DROPLET_IMAGE = "ubuntu-24-04-x64";

type DORegionColumnId = "americas" | "europe" | "asia_pacific";
type DOPlanFamily = "regular" | "premium_intel";

const REGION_COLUMNS: Array<{
  id: DORegionColumnId;
  label: string;
  entries: Array<{ city: string; preferred: string[] }>;
}> = [
  {
    id: "americas",
    label: "Americas",
    entries: [
      { city: "New York", preferred: ["nyc3", "nyc2", "nyc1"] },
      { city: "San Francisco", preferred: ["sfo3", "sfo2", "sfo1"] },
      { city: "Toronto", preferred: ["tor1"] },
    ],
  },
  {
    id: "europe",
    label: "Europe",
    entries: [
      { city: "Amsterdam", preferred: ["ams3", "ams2", "ams1"] },
      { city: "Frankfurt", preferred: ["fra1"] },
      { city: "London", preferred: ["lon1"] },
    ],
  },
  {
    id: "asia_pacific",
    label: "Asia-Pacific",
    entries: [
      { city: "Bangalore", preferred: ["blr1"] },
      { city: "Singapore", preferred: ["sgp1"] },
      { city: "Sydney", preferred: ["syd1"] },
    ],
  },
];

const FALLBACK_REGIONS: DORegion[] = [
  { slug: "nyc3", name: "New York 3", available: true },
  { slug: "sfo3", name: "San Francisco 3", available: true },
  { slug: "tor1", name: "Toronto 1", available: true },
  { slug: "ams3", name: "Amsterdam 3", available: true },
  { slug: "fra1", name: "Frankfurt 1", available: true },
  { slug: "lon1", name: "London 1", available: true },
  { slug: "blr1", name: "Bangalore 1", available: true },
  { slug: "sgp1", name: "Singapore 1", available: true },
  { slug: "syd1", name: "Sydney 1", available: true },
];

const FALLBACK_SIZES: DOSize[] = [
  { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_monthly: 6, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, disk: 50, transfer: 2, price_monthly: 12, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-2vcpu-2gb", memory: 2048, vcpus: 2, disk: 60, transfer: 3, price_monthly: 18, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80, transfer: 4, price_monthly: 24, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, transfer: 5, price_monthly: 48, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-8vcpu-16gb", memory: 16384, vcpus: 8, disk: 320, transfer: 6, price_monthly: 96, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-1vcpu-1gb-intel", memory: 1024, vcpus: 1, disk: 35, transfer: 1, price_monthly: 8, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-1vcpu-2gb-intel", memory: 2048, vcpus: 1, disk: 60, transfer: 2, price_monthly: 16, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-2vcpu-2gb-intel", memory: 2048, vcpus: 2, disk: 70, transfer: 3, price_monthly: 24, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-2vcpu-4gb-intel", memory: 4096, vcpus: 2, disk: 90, transfer: 4, price_monthly: 32, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-4vcpu-8gb-intel", memory: 8192, vcpus: 4, disk: 180, transfer: 5, price_monthly: 64, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
  { slug: "s-8vcpu-16gb-intel", memory: 16384, vcpus: 8, disk: 360, transfer: 6, price_monthly: 128, available: true, regions: FALLBACK_REGIONS.map((r) => r.slug) },
];

const FALLBACK_IMAGES: DOImage[] = [
  { id: 2404, slug: "ubuntu-24-04-x64", name: "24.04 (LTS) x64", distribution: "Ubuntu", type: "distribution", public: true },
  { id: 13, slug: "debian-13-x64", name: "13 x64", distribution: "Debian", type: "distribution", public: true },
];

interface VPSResponse {
  id: string;
  user_id: string;
  droplet_id: number;
  region: string;
  size: string;
  ipv4: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  provider: "digitalocean" | "manual";
  label: string;
  gateway_id?: string;
  gateway_connected?: boolean;
  gateway_version?: string | null;
  gateway_os?: string | null;
}

interface VPSCreateResponse {
  status: "provisioning";
  vps: VPSResponse;
}

interface ManualVPSResponse {
  gateway_id: string;
  gateway_auth_token: string;
  cp_url: string;
  install: {
    linux: string;
    macos: string;
  };
  vps: VPSResponse;
}

interface WorkspaceFoldersResponse {
  folders: string[];
}

interface DODropletRegionOption {
  slug: string;
  city: string;
  label: string;
  available: boolean;
}

interface DODropletRegionColumn {
  id: DORegionColumnId;
  label: string;
  options: DODropletRegionOption[];
}

interface DODropletSizeOption {
  slug: string;
  label: string;
  specs: string;
  price_monthly: number;
  regions: string[];
}

interface DODropletImageOption {
  slug: string;
  family: "ubuntu" | "debian";
  label: string;
}

interface DODropletOptionsResponse {
  live: boolean;
  regions: DODropletRegionColumn[];
  plans: Record<DOPlanFamily, DODropletSizeOption[]>;
  images: DODropletImageOption[];
  defaults: {
    region: string;
    plan_family: DOPlanFamily;
    size: string;
    image: string;
  };
}

/**
 * GET /vps/options – DigitalOcean provisioning options for the onboarding flow.
 */
export async function handleVPSOptions(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const conn = await getDOConnection(env.DB, auth.userId);
  let live = false;
  let regions = FALLBACK_REGIONS;
  let sizes = FALLBACK_SIZES;
  let images = FALLBACK_IMAGES;

  if (conn) {
    try {
      const accessToken = await getAccessToken(
        env.DB,
        auth.userId,
        env.DO_TOKEN_KEK,
        env.DO_CLIENT_ID,
        env.DO_CLIENT_SECRET,
      );
      const [liveRegions, liveSizes, liveImages] = await Promise.all([
        listRegions(accessToken),
        listSizes(accessToken),
        listDistributionImages(accessToken),
      ]);
      if (liveRegions.length > 0) regions = liveRegions;
      if (liveSizes.length > 0) sizes = liveSizes;
      if (liveImages.length > 0) images = liveImages;
      live = true;
    } catch (err) {
      console.warn("vps options: failed to fetch live DigitalOcean options", err);
    }
  }

  return jsonResponse(buildDODropletOptions(request, regions, sizes, images, live));
}

/**
 * POST /vps – Create droplet + generate gateway credentials.
 */
export async function handleVPSCreate(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let body: { region?: string; size?: string; image?: string; label?: string } = {};
  try {
    body = (await request.json()) as { region?: string; size?: string; image?: string; label?: string };
  } catch {
    // Body is optional. Defaults apply.
  }
  const region = (body.region ?? env.DEFAULT_DROPLET_REGION ?? DEFAULT_DROPLET_REGION).trim();
  const size = (body.size ?? env.DEFAULT_DROPLET_SIZE ?? DEFAULT_DROPLET_SIZE).trim();
  const image = (body.image ?? env.DEFAULT_DROPLET_IMAGE ?? DEFAULT_DROPLET_IMAGE).trim();

  if (!isDropletSlug(region)) {
    return jsonResponse({ error: "invalid region slug" }, 400);
  }
  if (!isDropletSlug(size)) {
    return jsonResponse({ error: "invalid size slug" }, 400);
  }
  if (!isDropletSlug(image)) {
    return jsonResponse({ error: "invalid image slug" }, 400);
  }
  const label = normalizeLabel(body.label);
  if (body.label !== undefined && label === null) {
    return jsonResponse({ error: "invalid label" }, 400);
  }

  // Verify user has DO connection
  const conn = await getDOConnection(env.DB, auth.userId);
  if (!conn) {
    return jsonResponse({ error: "no DigitalOcean connection" }, 400);
  }

  // Generate identifiers and credentials
  const vpsId = newVPSId();
  const gatewayId = newGatewayId();
  const authToken = randomHex(32);
  const authTokenHash = await hashGatewayToken(authToken, env.GATEWAY_TOKEN_SALT);

  // Build cloud-init userdata
  const cpUrl = new URL(request.url);
  const gatewayWsUrl = `wss://${cpUrl.hostname}/gw/connect`;
  const gatewayVersion = env.GATEWAY_VERSION || DEFAULT_GATEWAY_VERSION;
  const gatewayReleaseBaseUrl =
    env.GATEWAY_RELEASE_BASE_URL || DEFAULT_GATEWAY_RELEASE_BASE_URL;
  const userdata = buildCloudInit(
    gatewayId,
    authToken,
    gatewayWsUrl,
    gatewayVersion,
    gatewayReleaseBaseUrl,
  );

  let accessToken: string;
  let droplet: { id: number; networks: { v4: Array<{ ip_address: string; type: string }> } };
  try {
    // Get DO access token (handles refresh)
    accessToken = await getAccessToken(
      env.DB,
      auth.userId,
      env.DO_TOKEN_KEK,
      env.DO_CLIENT_ID,
      env.DO_CLIENT_SECRET,
    );

    // Create droplet via DO API
    droplet = await createDroplet(accessToken, {
      name: `chatcode-${vpsId}`,
      region,
      size,
      image,
      user_data: userdata,
      tags: ["chatcode"],
    });
  } catch (err) {
    console.error("vps create: droplet provisioning failed", err);
    return jsonResponse({ error: "failed to provision droplet" }, 502);
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    // Write VPS + Gateway rows to D1
    await createVPS(env.DB, {
      id: vpsId,
      user_id: auth.userId,
      droplet_id: droplet.id,
      label,
      region,
      size,
      ipv4: getPublicIp(droplet) ?? null,
      status: "provisioning",
      provisioning_deadline_at: now + PROVISIONING_TIMEOUT_SEC,
      created_at: now,
      updated_at: now,
    });

    await createGateway(env.DB, {
      id: gatewayId,
      vps_id: vpsId,
      auth_token_hash: authTokenHash,
      version: null,
      host_os: null,
      last_seen_at: null,
      connected: 0,
      created_at: now,
    });
  } catch (err) {
    // Best-effort rollback of cloud resource to avoid orphan droplets.
    try {
      await deleteDroplet(accessToken, droplet.id);
    } catch {
      // Reconciliation will not see this orphan yet; keep explicit log.
    }
    console.error("vps create: failed to persist DB state", err);
    return jsonResponse({ error: "failed to persist vps state" }, 500);
  }

  const vps: VPSRow = {
    id: vpsId,
    user_id: auth.userId,
    droplet_id: droplet.id,
    label,
    region,
    size,
    ipv4: getPublicIp(droplet) ?? null,
    status: "provisioning",
    provisioning_deadline_at: now + PROVISIONING_TIMEOUT_SEC,
    created_at: now,
    updated_at: now,
  };
  const gateway: GatewayRow = {
    id: gatewayId,
    vps_id: vpsId,
    auth_token_hash: authTokenHash,
    version: null,
    host_os: null,
    last_seen_at: null,
    connected: 0,
    created_at: now,
  };

  return jsonResponse(
    {
      status: "provisioning",
      vps: toVPSResponse(vps, gateway),
    } satisfies VPSCreateResponse,
    201,
  );
}

/**
 * POST /vps/manual – Staging/dev helper to mint manual gateway credentials.
 */
export async function handleVPSManualCreate(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!isManualVPSAllowed(env)) {
    return jsonResponse({ error: "not found" }, 404);
  }

  let body: { label?: string } = {};
  try {
    body = (await request.json()) as { label?: string };
  } catch {
    // Body is optional; ignore parse errors from empty body
  }

  const manualLabel = normalizeManualLabel(body.label);
  if (body.label && manualLabel === null) {
    return jsonResponse({ error: "invalid label" }, 400);
  }

  const vpsId = newVPSId();
  const gatewayId = newGatewayId();
  const authToken = randomHex(32);
  const authTokenHash = await hashGatewayToken(authToken, env.GATEWAY_TOKEN_SALT);
  const now = Math.floor(Date.now() / 1000);

  const size = manualLabel ? `manual:${manualLabel}` : "manual";
  const vps: VPSRow = {
    id: vpsId,
    user_id: auth.userId,
    droplet_id: 0,
    label: manualLabel || null,
    region: "manual",
    size,
    ipv4: null,
    status: "provisioning",
    provisioning_deadline_at: now + PROVISIONING_TIMEOUT_SEC,
    created_at: now,
    updated_at: now,
  };
  await createVPS(env.DB, vps);

  const gateway: GatewayRow = {
    id: gatewayId,
    vps_id: vpsId,
    auth_token_hash: authTokenHash,
    version: null,
    host_os: null,
    last_seen_at: null,
    connected: 0,
    created_at: now,
  };
  await createGateway(env.DB, gateway);

  const cp = new URL(request.url);
  const cpWsBase = `wss://${cp.hostname}/gw/connect`;

  return jsonResponse(
    {
      gateway_id: gatewayId,
      gateway_auth_token: authToken,
      cp_url: cpWsBase,
      install: {
        linux: `curl -fsSL https://chatcode.dev/install.sh | sudo bash -s -- --version latest --gateway-id ${gatewayId} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
        macos: `curl -fsSL https://chatcode.dev/install.sh | bash -s -- --version latest --gateway-id ${gatewayId} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
      },
      vps: toVPSResponse(vps, gateway),
    },
    201,
  );
}

/**
 * GET /vps – List user's VPS instances.
 */
export async function handleVPSList(
  _request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const vpsList = await listVPSByUser(env.DB, auth.userId);
  await hydrateMissingIPv4(env, auth.userId, vpsList);
  const gatewayByVPS = await listGatewaysByVPSIds(
    env.DB,
    vpsList.map((v) => v.id),
  );
  return jsonResponse({
    vps: vpsList.map((v) => toVPSResponse(v, gatewayByVPS[v.id])),
  });
}

/**
 * GET /vps/:id – VPS detail.
 */
export async function handleVPSGet(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }
  await hydrateMissingIPv4(env, auth.userId, [vps]);
  const gateway = await getGatewayByVPS(env.DB, vps.id);
  return jsonResponse(toVPSResponse(vps, gateway ?? undefined));
}

/**
 * PATCH /vps/:id – Rename VPS label.
 */
export async function handleVPSUpdate(
  request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const label = normalizeLabel(body.label);
  if (body.label === undefined || label === null) {
    return jsonResponse({ error: "invalid label" }, 400);
  }

  await updateVPSLabel(env.DB, vpsId, label);
  const updated = { ...vps, label, updated_at: Math.floor(Date.now() / 1000) };
  const gateway = await getGatewayByVPS(env.DB, vps.id);
  return jsonResponse(toVPSResponse(updated, gateway ?? undefined));
}

/**
 * DELETE /vps/:id – Ordered delete: cloud-first, DB-second.
 */
export async function handleVPSDelete(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  // 1. Mark as deleting
  await updateVPSStatus(env.DB, vpsId, "deleting");

  // 2. Signal GatewayHub DO to close gateway WS
  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (gateway) {
    try {
      const doId = env.GATEWAY_HUB.idFromName(gateway.id);
      const stub = env.GATEWAY_HUB.get(doId);
      await stub.fetch(new Request("http://do/shutdown", { method: "POST" }));
    } catch {
      // Best-effort shutdown
    }
  }

  // 3. Manual/BYO servers are just unlinked from chatcode metadata.
  if (vps.droplet_id <= 0) {
    await deleteVPSCascade(env.DB, vpsId);
    return new Response(null, { status: 204 });
  }

  // 4. Delete cloud droplet
  try {
    const accessToken = await getAccessToken(
      env.DB,
      auth.userId,
      env.DO_TOKEN_KEK,
      env.DO_CLIENT_ID,
      env.DO_CLIENT_SECRET,
    );
    await deleteDroplet(accessToken, vps.droplet_id);
  } catch (err) {
    // Retain rows for reconciliation retry
    return jsonResponse(
      { error: "failed to delete droplet, will retry" },
      502,
    );
  }

  // 5. Delete DB rows in order
  await deleteVPSCascade(env.DB, vpsId);

  return new Response(null, { status: 204 });
}

/**
 * POST /vps/:id/power-off
 */
export async function handleVPSPowerOff(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const accessToken = await getAccessToken(
    env.DB,
    auth.userId,
    env.DO_TOKEN_KEK,
    env.DO_CLIENT_ID,
    env.DO_CLIENT_SECRET,
  );
  await powerOffDroplet(accessToken, vps.droplet_id);
  await updateVPSStatus(env.DB, vpsId, "off");

  return jsonResponse({ ok: true });
}

/**
 * POST /vps/:id/power-on
 */
export async function handleVPSPowerOn(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const accessToken = await getAccessToken(
    env.DB,
    auth.userId,
    env.DO_TOKEN_KEK,
    env.DO_CLIENT_ID,
    env.DO_CLIENT_SECRET,
  );
  await powerOnDroplet(accessToken, vps.droplet_id);
  await updateVPSStatus(env.DB, vpsId, "active");

  return jsonResponse({ ok: true });
}

/**
 * POST /vps/:id/manual-command – Reissue install command for an existing BYO server.
 * Rotates the gateway auth token while the gateway is disconnected.
 */
export async function handleVPSManualCommand(
  request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  if (!isManualVPSAllowed(env)) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }
  if (vps.droplet_id > 0) {
    return jsonResponse({ error: "manual command only applies to BYO servers" }, 400);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway) {
    return jsonResponse({ error: "gateway not found" }, 404);
  }
  if (gateway.connected) {
    return jsonResponse({ error: "gateway already connected" }, 409);
  }

  const authToken = randomHex(32);
  const authTokenHash = await hashGatewayToken(authToken, env.GATEWAY_TOKEN_SALT);
  await updateGatewayAuthTokenHash(env.DB, gateway.id, authTokenHash);

  const cp = new URL(request.url);
  const cpWsBase = `wss://${cp.hostname}/gw/connect`;

  return jsonResponse(
    {
      gateway_id: gateway.id,
      gateway_auth_token: authToken,
      cp_url: cpWsBase,
      install: {
        linux: `curl -fsSL https://chatcode.dev/install.sh | sudo bash -s -- --version latest --gateway-id ${gateway.id} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
        macos: `curl -fsSL https://chatcode.dev/install.sh | bash -s -- --version latest --gateway-id ${gateway.id} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
      },
      vps: toVPSResponse(vps, gateway),
    } satisfies ManualVPSResponse,
    200,
  );
}

/**
 * GET /vps/:id/workspace-folders – List visible top-level folders under ~/workspace.
 */
export async function handleWorkspaceFolderList(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway) {
    return jsonResponse({ error: "gateway not found" }, 404);
  }
  if (!gateway.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);
  const cmd = {
    type: "workspace.list",
    schema_version: "1",
    request_id: `workspace-${Date.now()}`,
  };

  const cmdResp = await stub.fetch(
    new Request("http://do/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    }),
  );

  if (!cmdResp.ok) {
    const body = await cmdResp.json().catch(() => null) as { error?: string } | null;
    return jsonResponse({ error: body?.error ?? "workspace.list failed" }, cmdResp.status);
  }

  const payload = await cmdResp.json() as { type?: string; folders?: unknown };
  if (payload.type !== "workspace.folders" || !Array.isArray(payload.folders)) {
    return jsonResponse({ error: "workspace.list failed" }, 502);
  }

  const folders = payload.folders.filter((entry): entry is string => typeof entry === "string");
  return jsonResponse({ folders } satisfies WorkspaceFoldersResponse);
}

/**
 * POST /gw/unlink/:gatewayId – Gateway-authenticated unlink used by cleanup script.
 * Removes chatcode metadata for the gateway's VPS without destroying provider resources.
 */
export async function handleGatewayUnlink(
  env: Env,
  gatewayId: string,
): Promise<Response> {
  const gateway = await getGateway(env.DB, gatewayId);
  if (!gateway) {
    return new Response(null, { status: 204 });
  }

  try {
    const doId = env.GATEWAY_HUB.idFromName(gateway.id);
    const stub = env.GATEWAY_HUB.get(doId);
    await stub.fetch(new Request("http://do/shutdown", { method: "POST" }));
  } catch {
    // Best-effort shutdown before unlinking metadata.
  }

  await deleteVPSCascade(env.DB, gateway.vps_id);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDODropletOptions(
  request: Request,
  regions: DORegion[],
  sizes: DOSize[],
  images: DOImage[],
  live: boolean,
): DODropletOptionsResponse {
  const regionColumns = REGION_COLUMNS.map((column) => ({
    id: column.id,
    label: column.label,
    options: column.entries.map((entry) => {
      const region = resolvePreferredRegion(regions, entry.preferred);
      return {
        slug: region?.slug ?? entry.preferred[0] ?? "ams3",
        city: entry.city,
        label: entry.city,
        available: Boolean(region?.available ?? false),
      };
    }),
  }));

  const planOptions: Record<DOPlanFamily, DODropletSizeOption[]> = {
    regular: buildPlanOptions(sizes, "regular"),
    premium_intel: buildPlanOptions(sizes, "premium_intel"),
  };

  const imageOptions = buildImageOptions(images);
  const defaultRegion = chooseDefaultRegion(request, regionColumns);
  const defaultPlanFamily: DOPlanFamily = "regular";
  const defaultSize = chooseDefaultSize(planOptions[defaultPlanFamily], defaultRegion);
  const defaultImage =
    imageOptions.find((image) => image.family === "ubuntu")?.slug ??
    imageOptions[0]?.slug ??
    DEFAULT_DROPLET_IMAGE;

  return {
    live,
    regions: regionColumns,
    plans: planOptions,
    images: imageOptions,
    defaults: {
      region: defaultRegion,
      plan_family: defaultPlanFamily,
      size: defaultSize,
      image: defaultImage,
    },
  };
}

function resolvePreferredRegion(
  regions: DORegion[],
  preferred: string[],
): DORegion | null {
  for (const slug of preferred) {
    const match = regions.find((region) => region.slug === slug);
    if (match) return match;
  }
  return null;
}

function buildPlanOptions(
  sizes: DOSize[],
  family: DOPlanFamily,
): DODropletSizeOption[] {
  const filtered = sizes
    .filter((size) => size.available)
    .filter((size) => isPlanFamily(size.slug, family))
    .sort((a, b) => a.price_monthly - b.price_monthly || a.vcpus - b.vcpus || a.memory - b.memory)
    .slice(0, 6);

  return filtered.map((size) => ({
    slug: size.slug,
    label: `${size.vcpus} vCPU · ${formatMemory(size.memory)}`,
    specs: `${formatMemory(size.memory)} RAM · ${size.disk} GB SSD`,
    price_monthly: size.price_monthly,
    regions: size.regions,
  }));
}

function isPlanFamily(slug: string, family: DOPlanFamily): boolean {
  if (!slug.startsWith("s-")) return false;
  if (family === "premium_intel") return slug.endsWith("-intel");
  return !slug.includes("-amd") && !slug.includes("-intel");
}

function formatMemory(memoryMb: number): string {
  if (memoryMb < 1024) return `${memoryMb} MB`;
  const gb = memoryMb / 1024;
  return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
}

function buildImageOptions(images: DOImage[]): DODropletImageOption[] {
  const ubuntu = pickLatestImage(images, "ubuntu");
  const debian = pickLatestImage(images, "debian");

  return [ubuntu, debian]
    .filter((image): image is DOImage => Boolean(image?.slug))
    .map((image) => ({
      slug: image.slug as string,
      family: image.distribution.toLowerCase().startsWith("ubuntu") ? "ubuntu" : "debian",
      label: formatImageLabel(image),
    }));
}

function pickLatestImage(images: DOImage[], family: "ubuntu" | "debian"): DOImage | null {
  const matches = images
    .filter((image) => image.public)
    .filter((image) => image.type === "distribution")
    .filter((image) => typeof image.slug === "string" && image.slug.endsWith("-x64"))
    .filter((image) => image.distribution.toLowerCase() === family);

  if (matches.length === 0) {
    return family === "ubuntu"
      ? FALLBACK_IMAGES.find((image) => image.distribution === "Ubuntu") ?? null
      : FALLBACK_IMAGES.find((image) => image.distribution === "Debian") ?? null;
  }

  const scored = matches.map((image) => ({
    image,
    version: parseImageVersion(image.slug ?? image.name),
    lts: family === "ubuntu" && /lts/i.test(image.name),
  }));

  scored.sort((a, b) => {
    if (family === "ubuntu" && a.lts !== b.lts) return a.lts ? -1 : 1;
    const versionCmp = compareVersions(b.version, a.version);
    if (versionCmp !== 0) return versionCmp;
    return (b.image.created_at ?? "").localeCompare(a.image.created_at ?? "");
  });

  return scored[0]?.image ?? null;
}

function parseImageVersion(value: string): number[] {
  const match = value.match(/(\d{1,2})(?:-(\d{1,2}))?/);
  if (!match) return [0, 0];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0)];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function formatImageLabel(image: DOImage): string {
  if (image.distribution === "Ubuntu") {
    const match = image.slug?.match(/ubuntu-(\d{2})-(\d{2})-x64/);
    if (match) {
      const major = match[1];
      const minor = match[2];
      const lts = /lts/i.test(image.name) ? " LTS" : "";
      return `Ubuntu ${major}.${minor}${lts}`;
    }
  }
  if (image.distribution === "Debian") {
    const match = image.slug?.match(/debian-(\d+)-x64/);
    if (match) return `Debian ${match[1]}`;
  }
  return `${image.distribution} ${image.name}`.trim();
}

function chooseDefaultRegion(
  request: Request,
  columns: DODropletRegionColumn[],
): string {
  const cf = request.cf as { country?: string; continent?: string } | undefined;
  const country = (cf?.country ?? "").toUpperCase();
  const continent = (cf?.continent ?? "").toUpperCase();

  const bySlug = new Map(
    columns.flatMap((column) => column.options.map((option) => [option.slug, option] as const)),
  );
  const candidates = [
    country === "US" ? "nyc3" : null,
    country === "CA" ? "tor1" : null,
    country === "GB" ? "lon1" : null,
    country === "NL" ? "ams3" : null,
    country === "DE" ? "fra1" : null,
    country === "IN" ? "blr1" : null,
    country === "SG" ? "sgp1" : null,
    country === "AU" || country === "NZ" ? "syd1" : null,
    continent === "NA" ? "nyc3" : null,
    continent === "EU" ? "ams3" : null,
    continent === "AS" ? "sgp1" : null,
    continent === "OC" ? "syd1" : null,
    DEFAULT_DROPLET_REGION,
  ].filter((value): value is string => Boolean(value));

  for (const slug of candidates) {
    if (bySlug.get(slug)?.available) return slug;
  }
  return columns.flatMap((column) => column.options).find((option) => option.available)?.slug ?? DEFAULT_DROPLET_REGION;
}

function chooseDefaultSize(
  options: DODropletSizeOption[],
  region: string,
): string {
  const regionOptions = options.filter((option) => option.regions.includes(region));
  const choices = regionOptions.length > 0 ? regionOptions : options;
  const targetPrice = 18;
  return choices
    .slice()
    .sort((a, b) => Math.abs(a.price_monthly - targetPrice) - Math.abs(b.price_monthly - targetPrice))[0]?.slug
    ?? DEFAULT_DROPLET_SIZE;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isManualVPSAllowed(env: Env): boolean {
  return env.APP_ENV === "dev" || env.APP_ENV === "staging";
}

function isDropletSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,100}$/.test(value);
}

async function hydrateMissingIPv4(
  env: Env,
  userId: string,
  vpsList: VPSRow[],
): Promise<void> {
  let accessToken: string | null = null;

  for (const vps of vpsList) {
    if (vps.ipv4 || vps.droplet_id <= 0) continue;

    try {
      if (!accessToken) {
        accessToken = await getAccessToken(
          env.DB,
          userId,
          env.DO_TOKEN_KEK,
          env.DO_CLIENT_ID,
          env.DO_CLIENT_SECRET,
        );
      }

      const droplet = await getDroplet(accessToken, vps.droplet_id);
      if (!droplet) continue;

      const publicIp = getPublicIp(droplet);
      if (!publicIp) continue;

      await updateVPSIpv4(env.DB, vps.id, publicIp);
      vps.ipv4 = publicIp;
    } catch (err) {
      console.warn("vps ipv4 hydrate failed", { vps_id: vps.id, err });
    }
  }
}

function getPublicIp(droplet: { networks: { v4: Array<{ ip_address: string; type: string }> } }): string | undefined {
  return droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
}

function toVPSResponse(vps: VPSRow, gateway?: GatewayRow): VPSResponse {
  const isManual = vps.droplet_id <= 0;
  return {
    id: vps.id,
    user_id: vps.user_id,
    droplet_id: vps.droplet_id,
    region: vps.region,
    size: vps.size,
    ipv4: vps.ipv4,
    status: vps.status,
    created_at: vps.created_at,
    updated_at: vps.updated_at,
    provider: isManual ? "manual" : "digitalocean",
    label: deriveVPSLabel(vps),
    gateway_id: gateway?.id,
    gateway_connected: Boolean(gateway?.connected),
    gateway_version: gateway?.version ?? null,
    gateway_os: gateway?.host_os ?? null,
  };
}

function deriveVPSLabel(vps: VPSRow): string {
  if (vps.label?.trim()) {
    return vps.label.trim();
  }
  if (vps.droplet_id <= 0) {
    if (vps.size.startsWith("manual:")) {
      const label = vps.size.slice("manual:".length).trim();
      if (label) return label;
    }
    return "manual";
  }
  return `${vps.region} / ${vps.size}`;
}

function normalizeManualLabel(label: string | undefined): string | null {
  return normalizeLabel(label);
}

function normalizeLabel(label: string | undefined): string | null {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9._ -]+$/.test(trimmed)) return null;
  return trimmed;
}

function buildCloudInit(
  gatewayId: string,
  authToken: string,
  cpUrl: string,
  version: string,
  releaseBaseUrl: string,
): string {
  const gatewayIdQ = shellQuote(gatewayId);
  const authTokenQ = shellQuote(authToken);
  const cpUrlQ = shellQuote(cpUrl);
  const versionQ = shellQuote(version);
  const releaseBaseUrlQ = shellQuote(releaseBaseUrl);

  return `#!/bin/bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q curl ca-certificates
fi

export GATEWAY_ID=${gatewayIdQ}
export GATEWAY_AUTH_TOKEN=${authTokenQ}
export GATEWAY_CP_URL=${cpUrlQ}
export GATEWAY_VERSION=${versionQ}
export GATEWAY_RELEASE_BASE_URL=${releaseBaseUrlQ}

BOOTSTRAP_URL="$GATEWAY_RELEASE_BASE_URL/$GATEWAY_VERSION/cloud-init.sh"
BOOTSTRAP_PATH="/tmp/chatcode-cloud-init.sh"
curl -fsSL "$BOOTSTRAP_URL" -o "$BOOTSTRAP_PATH"
chmod +x "$BOOTSTRAP_PATH"
"$BOOTSTRAP_PATH"
rm -f "$BOOTSTRAP_PATH"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
