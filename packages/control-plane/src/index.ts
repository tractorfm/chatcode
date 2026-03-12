/**
 * Chatcode Control Plane – Cloudflare Worker entry point.
 * Routes requests and handles scheduled events.
 */

import type { Env, AuthContext } from "./types.js";
import { authenticateRequest, verifyGatewayToken } from "./lib/auth.js";
import {
  getGateway,
  listProvisioningTimedOut,
  listDeletingVPS,
  listStaleConnectedGateways,
  listVPSMissingIPv4,
  updateVPSStatus,
  updateVPSIpv4,
  deleteVPSCascade,
  markGatewayDisconnected,
} from "./db/schema.js";
import { getAccessToken, getDroplet, deleteDroplet } from "./lib/do-api.js";
import {
  handleEmailStart,
  handleEmailVerify,
  handleGoogleStart,
  handleGoogleCallback,
  handleGitHubStart,
  handleGitHubCallback,
  handleDOConnect,
  handleDOCallback,
  handleDODisconnect,
  handleAuthMe,
  handleUserSettingsGet,
  handleUserSettingsUpdate,
  handleAuthUnlinkProvider,
  handleLogout,
  handleDevSessionLogin,
} from "./routes/auth.js";
import {
  handleVPSCreate,
  handleVPSList,
  handleVPSGet,
  handleVPSDelete,
  handleVPSPowerOff,
  handleVPSPowerOn,
  handleGatewayUnlink,
  handleVPSManualCreate,
  handleVPSManualCommand,
  handleVPSUpdate,
  handleWorkspaceFolderList,
  handleVPSOptions,
} from "./routes/vps.js";
import {
  handleSessionList,
  handleAgentList,
  handleSessionCreate,
  handleSessionDelete,
  handleSessionUpdate,
  handleSessionSnapshot,
  handleTerminalUpgrade,
} from "./routes/sessions.js";
import {
  handleStagingCommand,
  handleStagingGatewayUpdatePayload,
  handleStagingTestPage,
} from "./routes/staging.js";
import { withCORS, corsHeaders } from "./lib/http.js";

export { GatewayHub } from "./durables/GatewayHub.js";

const GATEWAY_STALE_AFTER_SEC = 150;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --- CORS preflight ---
      if (method === "OPTIONS") {
        return handleCORS(request, env);
      }

      // --- Minimal staging test UI ---
      if (path === "/staging/test" && method === "GET") {
        return handleStagingTestPage(request, env);
      }

      // --- Auth routes (unauthenticated entrypoints/callbacks) ---
      if (path === "/auth/email/start" && method === "POST") {
        return withCORS(await handleEmailStart(request, env), request, env);
      }
      if (path === "/auth/email/verify" && method === "GET") {
        return handleEmailVerify(request, env);
      }
      if (path === "/auth/google/start" && method === "GET") {
        return handleGoogleStart(request, env);
      }
      if (path === "/auth/google/callback" && method === "GET") {
        return handleGoogleCallback(request, env);
      }
      if (path === "/auth/github/start" && method === "GET") {
        return handleGitHubStart(request, env);
      }
      if (path === "/auth/github/callback" && method === "GET") {
        return handleGitHubCallback(request, env);
      }
      if (path === "/auth/logout" && method === "POST") {
        return withCORS(await handleLogout(request, env), request, env);
      }
      if (path === "/auth/do/callback" && method === "GET") {
        return handleDOCallback(request, env);
      }

      // --- Gateway WS (gateway auth, not user auth) ---
      const gwMatch = path.match(/^\/gw\/connect(?:\/([a-zA-Z0-9_-]+))?$/);
      if (gwMatch) {
        return handleGatewayConnect(request, env, gwMatch[1] ?? null);
      }
      const gwUnlinkMatch = path.match(/^\/gw\/unlink(?:\/([a-zA-Z0-9_-]+))?$/);
      if (gwUnlinkMatch && method === "POST") {
        const auth = await authorizeGatewayRequest(request, env, gwUnlinkMatch[1] ?? null);
        if (auth instanceof Response) return auth;
        return handleGatewayUnlink(env, auth.gatewayId);
      }

      if (path === "/auth/dev/login" && method === "POST" && env.AUTH_MODE !== "dev") {
        return withCORS(
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
          request,
          env,
        );
      }

      // --- All remaining routes require user auth ---
      const authResult = await authenticateRequest(request, env);
      if (authResult instanceof Response) {
        return withCORS(authResult, request, env);
      }
      const auth: AuthContext = authResult;

      // --- Auth (authenticated) ---
      if (path === "/auth/me" && method === "GET") {
        return withCORS(await handleAuthMe(request, env, auth), request, env);
      }
      if (path === "/me/settings" && method === "GET") {
        return withCORS(await handleUserSettingsGet(request, env, auth), request, env);
      }
      if (path === "/me/settings" && method === "PATCH") {
        return withCORS(await handleUserSettingsUpdate(request, env, auth), request, env);
      }
      const authUnlinkMatch = path.match(/^\/auth\/(google|github)\/disconnect$/);
      if (authUnlinkMatch && method === "POST") {
        return withCORS(
          await handleAuthUnlinkProvider(
            request,
            env,
            auth,
            authUnlinkMatch[1] as "google" | "github",
          ),
          request,
          env,
        );
      }
      if (path === "/auth/dev/login" && method === "POST") {
        return withCORS(await handleDevSessionLogin(request, env, auth), request, env);
      }
      if (path === "/staging/cmd" && method === "POST") {
        return withCORS(await handleStagingCommand(request, env, auth), request, env);
      }
      if (path === "/staging/gateway-update-payload" && method === "GET") {
        return withCORS(
          await handleStagingGatewayUpdatePayload(request, env, auth),
          request,
          env,
        );
      }
      if (path === "/auth/do" && method === "GET") {
        return handleDOConnect(request, env, auth);
      }
      if (path === "/auth/do/disconnect" && method === "POST") {
        return withCORS(await handleDODisconnect(request, env, auth), request, env);
      }

      // --- VPS routes ---
      if (path === "/vps" && method === "GET") {
        return withCORS(await handleVPSList(request, env, auth), request, env);
      }
      if (path === "/vps/options" && method === "GET") {
        return withCORS(await handleVPSOptions(request, env, auth), request, env);
      }
      if (path === "/vps" && method === "POST") {
        return withCORS(await handleVPSCreate(request, env, auth), request, env);
      }
      if (path === "/vps/manual" && method === "POST") {
        return withCORS(await handleVPSManualCreate(request, env, auth), request, env);
      }
      const manualCommandMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/manual-command$/);
      if (manualCommandMatch && method === "POST") {
        return withCORS(
          await handleVPSManualCommand(request, env, auth, manualCommandMatch[1]),
          request,
          env,
        );
      }

      const vpsMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)$/);
      if (vpsMatch) {
        const vpsId = vpsMatch[1];
        if (method === "GET") return withCORS(await handleVPSGet(request, env, auth, vpsId), request, env);
        if (method === "PATCH") return withCORS(await handleVPSUpdate(request, env, auth, vpsId), request, env);
        if (method === "DELETE") return withCORS(await handleVPSDelete(request, env, auth, vpsId), request, env);
      }

      const vpsPowerOff = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/power-off$/);
      if (vpsPowerOff && method === "POST") {
        return withCORS(await handleVPSPowerOff(request, env, auth, vpsPowerOff[1]), request, env);
      }

      const vpsPowerOn = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/power-on$/);
      if (vpsPowerOn && method === "POST") {
        return withCORS(await handleVPSPowerOn(request, env, auth, vpsPowerOn[1]), request, env);
      }

      const workspaceFoldersMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/workspace-folders$/);
      if (workspaceFoldersMatch && method === "GET") {
        return withCORS(
          await handleWorkspaceFolderList(request, env, auth, workspaceFoldersMatch[1]),
          request,
          env,
        );
      }

      // --- Session routes ---
      const sessionsMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/sessions$/);
      if (sessionsMatch) {
        const vpsId = sessionsMatch[1];
        if (method === "GET") return withCORS(await handleSessionList(request, env, auth, vpsId), request, env);
        if (method === "POST") return withCORS(await handleSessionCreate(request, env, auth, vpsId), request, env);
      }

      const agentsMatch = path.match(/^\/vps\/([a-zA-Z0-9_-]+)\/agents$/);
      if (agentsMatch && method === "GET") {
        return withCORS(await handleAgentList(request, env, auth, agentsMatch[1]), request, env);
      }

      const sessionMatch = path.match(
        /^\/vps\/([a-zA-Z0-9_-]+)\/sessions\/([a-zA-Z0-9_-]+)$/,
      );
      if (sessionMatch && method === "DELETE") {
        return withCORS(
          await handleSessionDelete(request, env, auth, sessionMatch[1], sessionMatch[2]),
          request,
          env,
        );
      }
      if (sessionMatch && method === "PATCH") {
        return withCORS(
          await handleSessionUpdate(request, env, auth, sessionMatch[1], sessionMatch[2]),
          request,
          env,
        );
      }

      const snapshotMatch = path.match(
        /^\/vps\/([a-zA-Z0-9_-]+)\/sessions\/([a-zA-Z0-9_-]+)\/snapshot$/,
      );
      if (snapshotMatch && method === "GET") {
        return withCORS(
          await handleSessionSnapshot(request, env, auth, snapshotMatch[1], snapshotMatch[2]),
          request,
          env,
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
        request,
        env,
      );
    } catch (err) {
      console.error("unhandled error:", err);
      return withCORS(
        new Response(
          JSON.stringify({ error: "internal server error" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
        request,
        env,
      );
    }
  },

  /**
   * Scheduled Worker: provisioning timeout + gateway heartbeat expiry +
   * deleting-VPS reconciliation.
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

    // 2. Expire stale gateway heartbeat state
    const staleGateways = await listStaleConnectedGateways(
      env.DB,
      Math.floor(Date.now() / 1000) - GATEWAY_STALE_AFTER_SEC,
    );
    for (const gateway of staleGateways) {
      await markGatewayDisconnected(env.DB, gateway.id);
    }

    // 3. Retry deleting VPS cleanup
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

    // 4. Backfill missing public IPv4 after droplet assignment.
    const missingIPv4 = await listVPSMissingIPv4(env.DB);
    for (const vps of missingIPv4) {
      try {
        const accessToken = await getAccessToken(
          env.DB,
          vps.user_id,
          env.DO_TOKEN_KEK,
          env.DO_CLIENT_ID,
          env.DO_CLIENT_SECRET,
        );
        const droplet = await getDroplet(accessToken, vps.droplet_id);
        const publicIP = droplet?.networks.v4.find((n) => n.type === "public")?.ip_address;
        if (publicIP) {
          await updateVPSIpv4(env.DB, vps.id, publicIP);
        }
      } catch {
        // Best-effort; next cron will retry.
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
  gatewayIdFromPath: string | null,
): Promise<Response> {
  const auth = await authorizeGatewayRequest(request, env, gatewayIdFromPath);
  if (auth instanceof Response) {
    return auth;
  }

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  const gatewayId = auth.gatewayId;

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

async function authorizeGatewayRequest(
  request: Request,
  env: Env,
  gatewayIdFromPath: string | null,
): Promise<{ gatewayId: string } | Response> {
  const gatewayIdHeader = request.headers.get("X-Gateway-Id");
  if (gatewayIdFromPath && gatewayIdHeader && gatewayIdFromPath !== gatewayIdHeader) {
    return new Response("gateway id mismatch", { status: 400 });
  }
  const gatewayId = gatewayIdFromPath ?? gatewayIdHeader;
  if (!gatewayId || !/^[a-zA-Z0-9_-]+$/.test(gatewayId)) {
    return new Response("invalid gateway id", { status: 400 });
  }

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

  return { gatewayId };
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function handleCORS(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env),
  });
}
