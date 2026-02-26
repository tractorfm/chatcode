/**
 * VPS routes: create, list, get, destroy, power off/on.
 */

import type { Env, AuthContext } from "../types.js";
import {
  createVPS,
  getVPS,
  listVPSByUser,
  updateVPSStatus,
  deleteVPSCascade,
  createGateway,
  getGatewayByVPS,
  getDOConnection,
  type VPSRow,
} from "../db/schema.js";
import {
  getAccessToken,
  createDroplet,
  deleteDroplet,
  powerOffDroplet,
  powerOnDroplet,
} from "../lib/do-api.js";
import { hashGatewayToken } from "../lib/auth.js";
import { newVPSId, newGatewayId, randomHex } from "../lib/ids.js";

const PROVISIONING_TIMEOUT_SEC = 600; // 10 minutes
const DEFAULT_GATEWAY_VERSION = "v0.1.0";
const DEFAULT_GATEWAY_RELEASE_BASE_URL = "https://releases.chatcode.dev/gateway";
const DROPLET_IMAGE = "ubuntu-24-04-x64";

/**
 * POST /vps – Create droplet + generate gateway credentials.
 */
export async function handleVPSCreate(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = (await request.json()) as { region?: string; size?: string };
  const region = body.region || "nyc1";
  const size = body.size || "s-1vcpu-1gb";

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

  // Get DO access token (handles refresh)
  const accessToken = await getAccessToken(
    env.DB,
    auth.userId,
    env.DO_TOKEN_KEK,
    env.DO_CLIENT_ID,
    env.DO_CLIENT_SECRET,
  );

  // Create droplet via DO API
  const droplet = await createDroplet(accessToken, {
    name: `chatcode-${vpsId}`,
    region,
    size,
    image: DROPLET_IMAGE,
    user_data: userdata,
    tags: ["chatcode"],
  });

  const now = Math.floor(Date.now() / 1000);

  // Write VPS + Gateway rows to D1
  await createVPS(env.DB, {
    id: vpsId,
    user_id: auth.userId,
    droplet_id: droplet.id,
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
    last_seen_at: null,
    connected: 0,
    created_at: now,
  });

  return jsonResponse({ vps_id: vpsId, status: "provisioning" }, 201);
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
  return jsonResponse({ vps: vpsList });
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
  return jsonResponse(vps);
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

  // 3. Delete cloud droplet
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

  // 4. Delete DB rows in order
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getPublicIp(droplet: { networks: { v4: Array<{ ip_address: string; type: string }> } }): string | undefined {
  return droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
}

function buildCloudInit(
  gatewayId: string,
  authToken: string,
  cpUrl: string,
  version: string,
  releaseBaseUrl: string,
): string {
  return `#!/bin/bash
set -euo pipefail

# Create vibe user
useradd -m -s /bin/bash vibe
echo "vibe ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vibe

# Install gateway
mkdir -p /opt/chatcode
cd /opt/chatcode

GATEWAY_RELEASE_BASE_URL="${releaseBaseUrl}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GATEWAY_ARCH="amd64" ;;
  aarch64|arm64) GATEWAY_ARCH="arm64" ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

GATEWAY_URL="$GATEWAY_RELEASE_BASE_URL/${version}/chatcode-gateway-linux-\${GATEWAY_ARCH}"
curl -fsSL -o gateway "$GATEWAY_URL"
curl -fsSL -o gateway.sha256 "$GATEWAY_URL.sha256"
EXPECTED_SHA256="$(awk '{print $1}' gateway.sha256)"
ACTUAL_SHA256="$(sha256sum gateway | awk '{print $1}')"
if [ "$EXPECTED_SHA256" != "$ACTUAL_SHA256" ]; then
  echo "gateway checksum mismatch" >&2
  rm -f gateway gateway.sha256
  exit 1
fi
rm -f gateway.sha256
chmod +x gateway

# Write config
cat > /opt/chatcode/config.json <<CONF
{
  "gateway_id": "${gatewayId}",
  "gateway_auth_token": "${authToken}",
  "gateway_cp_url": "${cpUrl}"
}
CONF

# Create systemd service
cat > /etc/systemd/system/chatcode-gateway.service <<SVC
[Unit]
Description=Chatcode Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/chatcode/gateway
WorkingDirectory=/opt/chatcode
Environment=GATEWAY_ID=${gatewayId}
Environment=GATEWAY_AUTH_TOKEN=${authToken}
Environment=GATEWAY_CP_URL=${cpUrl}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable chatcode-gateway
systemctl start chatcode-gateway
`;
}
