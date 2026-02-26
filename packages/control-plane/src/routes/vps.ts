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
  deleteVPSCascade,
  createGateway,
  getGatewayByVPS,
  getDOConnection,
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
const DEFAULT_GATEWAY_VERSION = "v0.0.1";
const DEFAULT_GATEWAY_RELEASE_BASE_URL = "https://releases.chatcode.dev/gateway";
const DEFAULT_DROPLET_REGION = "nyc1";
const DEFAULT_DROPLET_SIZE = "s-1vcpu-512mb-10gb";
const DEFAULT_DROPLET_IMAGE = "ubuntu-24-04-x64";

/**
 * POST /vps – Create droplet + generate gateway credentials.
 */
export async function handleVPSCreate(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let body: { region?: string; size?: string; image?: string } = {};
  try {
    body = (await request.json()) as { region?: string; size?: string; image?: string };
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

  return jsonResponse({ vps_id: vpsId, status: "provisioning" }, 201);
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

  const vpsId = newVPSId();
  const gatewayId = newGatewayId();
  const authToken = randomHex(32);
  const authTokenHash = await hashGatewayToken(authToken, env.GATEWAY_TOKEN_SALT);
  const now = Math.floor(Date.now() / 1000);

  await createVPS(env.DB, {
    id: vpsId,
    user_id: auth.userId,
    droplet_id: 0,
    region: "manual",
    size: body.label?.trim() ? `manual:${body.label.trim()}` : "manual",
    ipv4: null,
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

  const cp = new URL(request.url);
  const cpWsBase = `wss://${cp.hostname}/gw/connect`;

  return jsonResponse(
    {
      vps_id: vpsId,
      gateway_id: gatewayId,
      gateway_auth_token: authToken,
      cp_url: cpWsBase,
      install: {
        linux: `curl -fsSL https://chatcode.dev/install.sh | sudo bash -s -- --version latest --gateway-id ${gatewayId} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
        macos: `curl -fsSL https://chatcode.dev/install.sh | bash -s -- --version latest --gateway-id ${gatewayId} --gateway-auth-token ${authToken} --cp-url ${cpWsBase}`,
      },
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
  await hydrateMissingIPv4(env, auth.userId, [vps]);
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
id -u vibe >/dev/null 2>&1 || useradd -m -s /bin/bash vibe
echo "vibe ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vibe
chmod 440 /etc/sudoers.d/vibe

# Ensure vibe-owned home paths
install -d -m 700 -o vibe -g vibe /home/vibe/.ssh
touch /home/vibe/.ssh/authorized_keys
chown vibe:vibe /home/vibe/.ssh/authorized_keys
chmod 600 /home/vibe/.ssh/authorized_keys
install -d -m 755 -o vibe -g vibe /home/vibe/workspace

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
User=vibe
Group=vibe
ExecStart=/opt/chatcode/gateway
WorkingDirectory=/home/vibe
Environment=HOME=/home/vibe
Environment=GATEWAY_ID=${gatewayId}
Environment=GATEWAY_AUTH_TOKEN=${authToken}
Environment=GATEWAY_CP_URL=${cpUrl}
Environment=GATEWAY_SSH_KEYS_FILE=/home/vibe/.ssh/authorized_keys
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
