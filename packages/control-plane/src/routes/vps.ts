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
} from "../lib/do-api.js";
import { hashGatewayToken } from "../lib/auth.js";
import { newVPSId, newGatewayId, randomHex } from "../lib/ids.js";

const PROVISIONING_TIMEOUT_SEC = 600; // 10 minutes
const DEFAULT_GATEWAY_VERSION = "v0.0.3";
const DEFAULT_GATEWAY_RELEASE_BASE_URL = "https://releases.chatcode.dev/gateway";
const DEFAULT_DROPLET_REGION = "nyc1";
const DEFAULT_DROPLET_SIZE = "s-1vcpu-512mb-10gb";
const DEFAULT_DROPLET_IMAGE = "ubuntu-24-04-x64";

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
