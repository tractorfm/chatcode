/**
 * Chatcode Control Plane – Cloudflare Worker entry point.
 * Routes requests and handles scheduled events.
 */

import type { Env, AuthContext } from "./types.js";
import { authenticateRequest, verifyGatewayToken } from "./lib/auth.js";
import { getGateway, listProvisioningTimedOut, listDeletingVPS, updateVPSStatus, deleteVPSCascade } from "./db/schema.js";
import { getAccessToken, deleteDroplet } from "./lib/do-api.js";
import { handleDOConnect, handleDOCallback, handleDODisconnect } from "./routes/auth.js";
import { handleVPSCreate, handleVPSList, handleVPSGet, handleVPSDelete, handleVPSPowerOff, handleVPSPowerOn } from "./routes/vps.js";
import { handleSessionList, handleSessionCreate, handleSessionDelete, handleSessionSnapshot, handleTerminalUpgrade } from "./routes/sessions.js";

export { GatewayHub } from "./durables/GatewayHub.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --- CORS preflight ---
      if (method === "OPTIONS") {
        return handleCORS();
      }

      // --- Auth routes (unauthenticated) ---
      if (path === "/auth/do" && method === "GET") {
        return handleDOConnect(request, env);
      }
      if (path === "/auth/do/callback" && method === "GET") {
        return handleDOCallback(request, env);
      }

      // --- Gateway WS (gateway auth, not user auth) ---
      const gwMatch = path.match(/^\/gw\/connect\/([a-zA-Z0-9_-]+)$/);
      if (gwMatch) {
        return handleGatewayConnect(request, env, gwMatch[1]);
      }

      // --- All remaining routes require user auth ---
      const authResult = await authenticateRequest(request, env);
      if (authResult instanceof Response) {
        return withCORS(authResult);
      }
      const auth: AuthContext = authResult;

      // --- Auth (authenticated) ---
      if (path === "/auth/do/disconnect" && method === "POST") {
        return withCORS(await handleDODisconnect(request, env, auth));
      }

      // --- VPS routes ---
      if (path === "/vps" && method === "GET") {
        return withCORS(await handleVPSList(request, env, auth));
      }
      if (path === "/vps" && method === "POST") {
        return withCORS(await handleVPSCreate(request, env, auth));
      }

      const vpsMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)$/);
      if (vpsMatch) {
        const vpsId = vpsMatch[1];
        if (method === "GET") return withCORS(await handleVPSGet(request, env, auth, vpsId));
        if (method === "DELETE") return withCORS(await handleVPSDelete(request, env, auth, vpsId));
      }

      const vpsPowerOff = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/power-off$/);
      if (vpsPowerOff && method === "POST") {
        return withCORS(await handleVPSPowerOff(request, env, auth, vpsPowerOff[1]));
      }

      const vpsPowerOn = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/power-on$/);
      if (vpsPowerOn && method === "POST") {
        return withCORS(await handleVPSPowerOn(request, env, auth, vpsPowerOn[1]));
      }

      // --- Session routes ---
      const sessionsMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/sessions$/);
      if (sessionsMatch) {
        const vpsId = sessionsMatch[1];
        if (method === "GET") return withCORS(await handleSessionList(request, env, auth, vpsId));
        if (method === "POST") return withCORS(await handleSessionCreate(request, env, auth, vpsId));
      }

      const sessionDeleteMatch = path.match(
        /^\/vps\/([a-zA-Z0-9_-]+)\/sessions\/([a-zA-Z0-9_-]+)$/,
      );
      if (sessionDeleteMatch && method === "DELETE") {
        return withCORS(
          await handleSessionDelete(request, env, auth, sessionDeleteMatch[1], sessionDeleteMatch[2]),
        );
      }

      const snapshotMatch = path.match(
        /^\/vps\/([a-zA-Z0-9_-]+)\/sessions\/([a-zA-Z0-9_-]+)\/snapshot$/,
      );
      if (snapshotMatch && method === "GET") {
        return withCORS(
          await handleSessionSnapshot(request, env, auth, snapshotMatch[1], snapshotMatch[2]),
        );
      }

      const terminalMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/terminal$/);
      if (terminalMatch && method === "GET") {
        return await handleTerminalUpgrade(request, env, auth, terminalMatch[1]);
      }

      // --- 404 ---
      return withCORS(
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch (err) {
      console.error("unhandled error:", err);
      return withCORS(
        new Response(
          JSON.stringify({ error: "internal server error" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
  },

  /**
   * Scheduled Worker: provisioning timeout + deleting-VPS reconciliation.
   * Runs every minute via cron.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1. Check provisioning timeouts
    const timedOut = await listProvisioningTimedOut(env.DB);
    for (const vps of timedOut) {
      // Check if gateway actually connected
      const gw = await env.DB
        .prepare("SELECT connected FROM gateways WHERE vps_id = ?")
        .bind(vps.id)
        .first<{ connected: number }>();

      if (!gw || !gw.connected) {
        await updateVPSStatus(env.DB, vps.id, "provisioning_timeout");
      }
    }

    // 2. Retry deleting VPS cleanup
    const deletingList = await listDeletingVPS(env.DB);
    for (const vps of deletingList) {
      try {
        const accessToken = await getAccessToken(
          env.DB,
          vps.user_id,
          env.DO_TOKEN_KEK,
          env.DO_CLIENT_ID,
          env.DO_CLIENT_SECRET,
        );
        await deleteDroplet(accessToken, vps.droplet_id);
        await deleteVPSCascade(env.DB, vps.id);
      } catch {
        // Will retry next cron cycle
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Gateway connect (bearer token auth)
// ---------------------------------------------------------------------------

async function handleGatewayConnect(
  request: Request,
  env: Env,
  gatewayId: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  // Verify bearer token
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401 });
  }
  const token = authHeader.slice(7);

  const gateway = await getGateway(env.DB, gatewayId);
  if (!gateway) {
    return new Response("gateway not found", { status: 404 });
  }

  const valid = await verifyGatewayToken(token, gateway.auth_token_hash, env.GATEWAY_TOKEN_SALT);
  if (!valid) {
    return new Response("unauthorized", { status: 401 });
  }

  // Route to GatewayHub DO
  const doId = env.GATEWAY_HUB.idFromName(gatewayId);
  const stub = env.GATEWAY_HUB.get(doId);

  const headers = new Headers(request.headers);
  headers.set("X-Gateway-Id", gatewayId);

  return stub.fetch(
    new Request("http://do/gateway-ws", {
      headers,
    }),
  );
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function withCORS(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dev-User",
    "Access-Control-Max-Age": "86400",
  };
}
