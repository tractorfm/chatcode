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
  updateGatewayConnected,
} from "../db/schema.js";
import { newSessionId } from "../lib/ids.js";

const GATEWAY_LAST_SEEN_FRESH_SECONDS = 90;
const MANAGED_AGENT_TYPES = new Set(["claude-code", "codex", "gemini", "opencode"]);

interface GatewayAgentStatus {
  agent: string;
  binary: string;
  installed: boolean;
  version?: string;
}

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
 * GET /vps/:id/agents – query gateway for installed agent CLIs.
 */
export async function handleAgentList(
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
  if (!gateway?.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }
  if (!(await isGatewayLive(env, gateway.id, gateway.last_seen_at))) {
    await updateGatewayConnected(env.DB, gateway.id, false);
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const agents = await fetchGatewayAgents(env, doId);
  if (!agents) {
    return jsonResponse({ error: "agents.list failed" }, 502);
  }

  return jsonResponse({ agents });
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
  if (!(await isGatewayLive(env, gateway.id, gateway.last_seen_at))) {
    await updateGatewayConnected(env.DB, gateway.id, false);
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const body = (await request.json()) as {
    title?: string;
    agent_type?: string;
    workdir?: string;
  };
  const agentType = body.agent_type || "claude-code";

  if (MANAGED_AGENT_TYPES.has(agentType)) {
    const doId = env.GATEWAY_HUB.idFromName(gateway.id);
    const agents = await fetchGatewayAgents(env, doId);
    if (agents) {
      const target = agents.find((item) => item.agent === agentType);
      if (!target?.installed) {
        return jsonResponse(
          {
            error: `${agentType} is not installed. Run agents.install first.`,
            code: "agent_not_installed",
            agent: agentType,
          },
          409,
        );
      }
    } else {
      console.warn(`agents.list unavailable for ${gateway.id}; proceeding with session.create`);
    }
  }

  const sessionId = newSessionId();
  const now = Math.floor(Date.now() / 1000);

  // Write session row
  await createSession(env.DB, {
    id: sessionId,
    user_id: auth.userId,
    vps_id: vpsId,
    title: body.title || "New Session",
    agent_type: agentType,
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
    agent: agentType,
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
    const errPayload = await cmdResp.json().catch(() => null) as { error?: string } | null;
    const error = errPayload?.error || "gateway command failed";

    if (error === "gateway not connected") {
      await updateGatewayConnected(env.DB, gateway.id, false);
      return jsonResponse({ error }, 503);
    }

    return jsonResponse({ error }, cmdResp.status === 504 ? 504 : 502);
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

  const session = await getSession(env.DB, sessionId);
  if (!session || session.vps_id !== vpsId) {
    return jsonResponse({ error: "session not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway?.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }
  if (!(await isGatewayLive(env, gateway.id, gateway.last_seen_at))) {
    await updateGatewayConnected(env.DB, gateway.id, false);
    return jsonResponse({ error: "gateway not connected" }, 503);
  }

  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);

  const cmd = {
    type: "session.snapshot",
    schema_version: "1",
    request_id: newRequestId(`snap-${sessionId}`),
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
  if (!gateway.connected) {
    return jsonResponse({ error: "gateway not connected" }, 503);
  }
  if (!(await isGatewayLive(env, gateway.id, gateway.last_seen_at))) {
    await updateGatewayConnected(env.DB, gateway.id, false);
    return jsonResponse({ error: "gateway not connected" }, 503);
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

async function isGatewayLive(
  env: Env,
  gatewayId: string,
  lastSeenAt: number | null | undefined,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  if (typeof lastSeenAt === "number" && now - lastSeenAt <= GATEWAY_LAST_SEEN_FRESH_SECONDS) {
    return true;
  }

  try {
    const doId = env.GATEWAY_HUB.idFromName(gatewayId);
    const stub = env.GATEWAY_HUB.get(doId);
    const statusResp = await stub.fetch(new Request("http://do/status"));
    if (!statusResp.ok) return false;
    const status = await statusResp.json<{ connected?: unknown }>();
    return Boolean(status.connected);
  } catch {
    return false;
  }
}

async function fetchGatewayAgents(
  env: Env,
  doId: DurableObjectId,
): Promise<GatewayAgentStatus[] | null> {
  const stub = env.GATEWAY_HUB.get(doId);
  const cmd = {
    type: "agents.list",
    schema_version: "1",
    request_id: newRequestId("agents"),
  };

  const cmdResp = await stub.fetch(
    new Request("http://do/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    }),
  );
  if (!cmdResp.ok) {
    return null;
  }

  const payload = (await cmdResp.json()) as {
    type?: string;
    agents?: GatewayAgentStatus[];
  };
  if (payload.type !== "agents.status" || !Array.isArray(payload.agents)) {
    return null;
  }
  return payload.agents;
}

function newRequestId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
