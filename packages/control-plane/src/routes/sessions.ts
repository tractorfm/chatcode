/**
 * Session routes: list, create, delete, snapshot, WS terminal upgrade.
 */

import type { Env, AuthContext } from "../types.js";
import {
  getVPS,
  getGatewayByVPS,
  createSession,
  getSession,
  listSessionsByVPS,
  updateSessionStatus,
} from "../db/schema.js";
import { newSessionId } from "../lib/ids.js";

/**
 * GET /vps/:id/sessions – List sessions for a VPS.
 */
export async function handleSessionList(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const sessions = await listSessionsByVPS(env.DB, vpsId);
  return jsonResponse({ sessions });
}

/**
 * POST /vps/:id/sessions – Create session (relays session.create to gateway via DO).
 */
export async function handleSessionCreate(
  request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }
  if (vps.status !== "active") {
    return jsonResponse({ error: "VPS not active" }, 400);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway || !gateway.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const body = (await request.json()) as {
    title?: string;
    agent_type?: string;
    workdir?: string;
  };

  const sessionId = newSessionId();
  const now = Math.floor(Date.now() / 1000);

  // Write session row
  await createSession(env.DB, {
    id: sessionId,
    user_id: auth.userId,
    vps_id: vpsId,
    title: body.title || "New Session",
    agent_type: body.agent_type || "claude-code",
    workdir: body.workdir || "/home/vibe",
    status: "starting",
    created_at: now,
    last_activity_at: now,
  });

  // Relay session.create command to gateway via GatewayHub DO
  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);

  const cmd = {
    type: "session.create",
    schema_version: "1",
    request_id: sessionId,
    session_id: sessionId,
    name: body.title || "New Session",
    workdir: body.workdir || "/home/vibe",
    agent: body.agent_type || "claude-code",
  };

  const cmdResp = await stub.fetch(
    new Request("http://do/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    }),
  );

  if (!cmdResp.ok) {
    // Mark session as failed
    await updateSessionStatus(env.DB, sessionId, "error");
    const errBody = await cmdResp.text();
    return jsonResponse({ error: `gateway command failed: ${errBody}` }, 502);
  }

  return jsonResponse(
    { session_id: sessionId, status: "starting" },
    201,
  );
}

/**
 * DELETE /vps/:id/sessions/:sid – End session.
 */
export async function handleSessionDelete(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
  sessionId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const session = await getSession(env.DB, sessionId);
  if (!session || session.vps_id !== vpsId) {
    return jsonResponse({ error: "session not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (gateway?.connected) {
    const doId = env.GATEWAY_HUB.idFromName(gateway.id);
    const stub = env.GATEWAY_HUB.get(doId);

    const cmd = {
      type: "session.end",
      schema_version: "1",
      request_id: `end-${sessionId}`,
      session_id: sessionId,
    };

    try {
      await stub.fetch(
        new Request("http://do/cmd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmd),
        }),
      );
    } catch {
      // Best-effort end
    }
  }

  await updateSessionStatus(env.DB, sessionId, "ended");
  return new Response(null, { status: 204 });
}

/**
 * GET /vps/:id/sessions/:sid/snapshot – Request and return terminal snapshot.
 */
export async function handleSessionSnapshot(
  _request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
  sessionId: string,
): Promise<Response> {
  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway?.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);

  const cmd = {
    type: "session.snapshot",
    schema_version: "1",
    request_id: `snap-${sessionId}-${Date.now()}`,
    session_id: sessionId,
  };

  const cmdResp = await stub.fetch(
    new Request("http://do/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    }),
  );

  if (!cmdResp.ok) {
    return jsonResponse({ error: "snapshot request failed" }, 502);
  }

  const ack = await cmdResp.json();
  return jsonResponse(ack);
}

/**
 * GET /vps/:id/terminal?session_id=:sid – WS upgrade → attach to GatewayHub.
 */
export async function handleTerminalUpgrade(
  request: Request,
  env: Env,
  auth: AuthContext,
  vpsId: string,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "expected websocket upgrade" }, 426);
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return jsonResponse({ error: "missing session_id" }, 400);
  }

  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const session = await getSession(env.DB, sessionId);
  if (!session || session.vps_id !== vpsId) {
    return jsonResponse({ error: "session not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway) {
    return jsonResponse({ error: "gateway not found" }, 404);
  }

  // Forward the WebSocket upgrade to the GatewayHub DO
  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);

  // Pass session_id and user_id context via URL
  const doUrl = new URL(`http://do/browser-ws?session_id=${sessionId}&user_id=${auth.userId}`);
  const doReq = new Request(doUrl.toString(), {
    headers: request.headers,
  });

  return stub.fetch(doReq);
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
