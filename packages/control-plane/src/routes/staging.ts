import type { Env, AuthContext } from "../types.js";
import { getGatewayByVPS, getVPS } from "../db/schema.js";
import {
  STAGING_TERMINAL_COMPONENT_SCRIPT,
  STAGING_TERMINAL_SECTION,
  STAGING_TERMINAL_STYLE,
} from "./staging-terminal-component.js";

export function handleStagingTestPage(_request: Request, env: Env): Response {
  if (!isStagingEnabled(env)) {
    return new Response("not found", { status: 404 });
  }

  return new Response(htmlPage(env), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function handleStagingCommand(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!isStagingEnabled(env)) {
    return jsonResponse({ error: "not found" }, 404);
  }

  let body: { vps_id?: string; cmd?: Record<string, unknown> };
  try {
    body = (await request.json()) as { vps_id?: string; cmd?: Record<string, unknown> };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const vpsId = typeof body.vps_id === "string" ? body.vps_id.trim() : "";
  if (!vpsId) {
    return jsonResponse({ error: "vps_id is required" }, 400);
  }

  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway) {
    return jsonResponse({ error: "gateway not found" }, 404);
  }

  const cmd = body.cmd;
  if (!cmd || typeof cmd !== "object") {
    return jsonResponse({ error: "cmd object is required" }, 400);
  }

  const type = typeof cmd.type === "string" ? cmd.type.trim() : "";
  if (!type) {
    return jsonResponse({ error: "cmd.type is required" }, 400);
  }

  const finalCmd: Record<string, unknown> = { ...cmd };
  if (typeof finalCmd.schema_version !== "string" || !String(finalCmd.schema_version).trim()) {
    finalCmd.schema_version = "1";
  }
  if (typeof finalCmd.request_id !== "string" || !String(finalCmd.request_id).trim()) {
    finalCmd.request_id = `stg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const doId = env.GATEWAY_HUB.idFromName(gateway.id);
  const stub = env.GATEWAY_HUB.get(doId);

  try {
    const resp = await stub.fetch(
      new Request("http://do/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalCmd),
      }),
    );

    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonResponse(
      { error: `failed to relay command: ${err instanceof Error ? err.message : "unknown"}` },
      502,
    );
  }
}


const GATEWAY_UPDATE_TARGETS = new Set([
  "linux-amd64",
  "linux-arm64",
  "darwin-arm64",
]);

export async function handleStagingGatewayUpdatePayload(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!isStagingEnabled(env)) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const url = new URL(request.url);
  const vpsId = (url.searchParams.get("vps_id") || "").trim();
  const target = (url.searchParams.get("target") || "linux-amd64").trim();
  const version = (url.searchParams.get("version") || env.GATEWAY_VERSION || "").trim();
  const baseUrl = (env.GATEWAY_RELEASE_BASE_URL || "").trim().replace(/\/+$/, "");

  if (!vpsId) {
    return jsonResponse({ error: "vps_id is required" }, 400);
  }
  if (!GATEWAY_UPDATE_TARGETS.has(target)) {
    return jsonResponse({ error: "invalid target" }, 400);
  }
  if (!version || !/^v[0-9A-Za-z._-]+$/.test(version)) {
    return jsonResponse({ error: "invalid version" }, 400);
  }
  if (!baseUrl) {
    return jsonResponse({ error: "gateway release base URL is not configured" }, 500);
  }

  const vps = await getVPS(env.DB, vpsId);
  if (!vps || vps.user_id !== auth.userId) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const gateway = await getGatewayByVPS(env.DB, vpsId);
  if (!gateway) {
    return jsonResponse({ error: "gateway not found" }, 404);
  }

  const filename = `chatcode-gateway-${target}`;
  const checksumsUrl = `${baseUrl}/${version}/checksums.txt`;

  let checksumsText = "";
  try {
    const resp = await fetch(checksumsUrl);
    if (!resp.ok) {
      return jsonResponse({ error: `failed to fetch checksums (${resp.status})` }, 502);
    }
    checksumsText = await resp.text();
  } catch (err) {
    return jsonResponse(
      { error: `failed to fetch checksums: ${err instanceof Error ? err.message : "unknown"}` },
      502,
    );
  }

  const sha256 = parseChecksumEntry(checksumsText, filename);
  if (!sha256) {
    return jsonResponse({ error: `checksum not found for ${filename}` }, 404);
  }

  const cmd = {
    type: "gateway.update",
    schema_version: "1",
    request_id: `gw-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: `${baseUrl}/${version}/${filename}`,
    sha256,
    version,
  };

  return jsonResponse({
    gateway_id: gateway.id,
    target,
    version,
    cmd,
  });
}

export function parseChecksumEntry(checksumsText: string, filename: string): string | null {
  const lines = checksumsText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    if (match[2].trim() === filename) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function isStagingEnabled(env: Env): boolean {
  return env.APP_ENV === "staging" || env.APP_ENV === "dev";
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(env: Env): string {
  const gatewayVersion = htmlEscape(env.GATEWAY_VERSION || "");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chatcode Staging Test</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css" />
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 20px; line-height: 1.4; }
    h1, h2 { margin: 0 0 8px 0; }
    button { margin-right: 8px; margin-bottom: 8px; }
    input, select, textarea { margin-right: 8px; margin-bottom: 8px; padding: 6px; }
    pre { background: #f5f5f5; padding: 12px; overflow: auto; border: 1px solid #ddd; white-space: pre-wrap; }
    .section { margin-bottom: 16px; border: 1px solid #ddd; padding: 12px; border-radius: 6px; }
    .row { margin-bottom: 8px; }
    .muted { color: #666; font-size: 12px; }
${STAGING_TERMINAL_STYLE}
    .vps-card, .session-card { padding: 8px; border: 1px solid #ddd; margin-top: 8px; border-radius: 4px; }
    .session-card { padding: 6px 8px; }
    .session-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
    .session-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .session-cmd { display: inline-block; background: #f7f7f7; border: 1px solid #ddd; border-radius: 4px; padding: 2px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .session-tabs { display: flex; gap: 6px; margin-bottom: 8px; }
    .session-tab { border: 1px solid #bbb; background: #f6f6f6; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    .session-tab.active { background: #1a73e8; border-color: #1a73e8; color: #fff; }
    #schema-json { width: 100%; min-height: 150px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>Chatcode Staging Test</h1>

  <div id="auth-unauth" class="section" style="display:none">
    <h2>Sign In</h2>
    <form id="email-form" class="row">
      <input id="email" type="email" placeholder="you@example.com" required />
      <button type="submit">Send Magic Link</button>
    </form>
    <button id="google-btn">Sign in with Google</button>
    <button id="github-btn">Sign in with GitHub</button>
  </div>

  <div id="auth-authed" class="section" style="display:none">
    <h2>Account</h2>
    <pre id="me"></pre>
    <button id="do-connect">Connect DigitalOcean</button>
    <button id="logout">Logout</button>
  </div>

  <div id="vps" class="section" style="display:none">
    <h2>VPS</h2>
    <div class="row">
      <input id="vps-region" value="nyc1" placeholder="region (e.g. nyc1)" />
      <input id="vps-size" value="s-1vcpu-512mb-10gb" placeholder="size slug" />
      <input id="vps-image" value="ubuntu-24-04-x64" placeholder="image slug" />
    </div>
    <div class="row">
      <button id="vps-create">Create VPS</button>
      <input id="manual-label" placeholder="manual label (optional)" />
      <button id="vps-manual">Add VPS (Manual)</button>
      <button id="vps-list">List VPS</button>
    </div>
    <div class="row">
      <label for="gateway-update-target">Gateway update target:</label>
      <select id="gateway-update-target">
        <option value="linux-amd64">linux-amd64</option>
        <option value="linux-arm64">linux-arm64</option>
        <option value="darwin-arm64">darwin-arm64</option>
      </select>
      <input id="gateway-update-version" value="${gatewayVersion}" placeholder="gateway version (default staging version)" />
    </div>
    <div id="vps-list-panel"></div>
  </div>

  <div id="sessions" class="section" style="display:none">
    <h2>Sessions</h2>
    <div class="row">
      <label for="session-vps-select">VPS:</label>
      <select id="session-vps-select"></select>
      <button id="sessions-list">List Sessions</button>
      <button id="agents-list">List Agents</button>
    </div>
    <pre id="agents-list-panel" class="muted"></pre>
    <div class="row">
      <input id="session-title" value="staging-session" placeholder="title" />
      <select id="session-agent">
        <option value="none">none</option>
        <option value="claude-code">claude-code</option>
        <option value="codex">codex</option>
        <option value="gemini">gemini</option>
        <option value="opencode">opencode</option>
      </select>
      <input id="session-workdir" value="/home/vibe/workspace" placeholder="workdir" />
      <button id="session-create">Create Session</button>
    </div>
    <div id="sessions-tabs" class="session-tabs"></div>
    <div id="sessions-list-panel"></div>
  </div>

${STAGING_TERMINAL_SECTION}

  <div id="schema-wrap" class="section" style="display:none">
    <h2>Schema Command Tester (staging only)</h2>
    <div class="row muted">Build a command from protocol schema presets, edit JSON if needed, then relay to gateway via control-plane.</div>
    <div class="row">
      <select id="schema-command-type">
        <option value="session.snapshot">session.snapshot</option>
        <option value="session.resize">session.resize</option>
        <option value="session.input">session.input</option>
        <option value="session.end">session.end</option>
        <option value="ssh.authorize">ssh.authorize</option>
        <option value="ssh.revoke">ssh.revoke</option>
        <option value="ssh.list">ssh.list</option>
        <option value="agents.list">agents.list</option>
        <option value="agents.install">agents.install</option>
        <option value="gateway.update">gateway.update</option>
      </select>
      <input id="schema-session-id" placeholder="session_id" style="min-width: 240px" />
      <input id="schema-input-text" placeholder="input text for session.input" style="min-width: 260px" />
      <input id="schema-cols" type="number" min="1" value="120" placeholder="cols" style="width:90px" />
      <input id="schema-rows" type="number" min="1" value="32" placeholder="rows" style="width:90px" />
      <select id="schema-agent">
        <option value="claude-code">claude-code</option>
        <option value="codex">codex</option>
        <option value="gemini">gemini</option>
        <option value="opencode">opencode</option>
      </select>
    </div>
    <div class="row">
      <input id="schema-ssh-label" placeholder="ssh label (for ssh.authorize)" style="min-width: 220px" />
      <input id="schema-ssh-fingerprint" placeholder="fingerprint (for ssh.revoke)" style="min-width: 280px" />
    </div>
    <div class="row">
      <input id="schema-ssh-public-key" placeholder="ssh-ed25519 ... (for ssh.authorize)" style="min-width: 680px; width: 100%" />
    </div>
    <div class="row">
      <button id="schema-build">Build Preset</button>
      <button id="schema-send">Send Command</button>
    </div>
    <textarea id="schema-json" spellcheck="false"></textarea>
  </div>

  <h2>Last API Result</h2>
  <pre id="out">{}</pre>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js"></script>
  <script>${STAGING_TERMINAL_COMPONENT_SCRIPT}</script>
  <script>
    const out = document.getElementById("out");
    const meEl = document.getElementById("me");
    const unauth = document.getElementById("auth-unauth");
    const authed = document.getElementById("auth-authed");
    const vps = document.getElementById("vps");
    const sessions = document.getElementById("sessions");
    const schemaWrap = document.getElementById("schema-wrap");
    const vpsListPanel = document.getElementById("vps-list-panel");
    const agentsListPanel = document.getElementById("agents-list-panel");
    const sessionsListPanel = document.getElementById("sessions-list-panel");
    const sessionsTabs = document.getElementById("sessions-tabs");
    const vpsSelect = document.getElementById("session-vps-select");
    const schemaCommandType = document.getElementById("schema-command-type");
    const schemaSessionId = document.getElementById("schema-session-id");
    const schemaInputText = document.getElementById("schema-input-text");
    const schemaCols = document.getElementById("schema-cols");
    const schemaRows = document.getElementById("schema-rows");
    const schemaAgent = document.getElementById("schema-agent");
    const schemaSSHLabel = document.getElementById("schema-ssh-label");
    const schemaSSHFingerprint = document.getElementById("schema-ssh-fingerprint");
    const schemaSSHPublicKey = document.getElementById("schema-ssh-public-key");
    const schemaJson = document.getElementById("schema-json");
    const gatewayUpdateTarget = document.getElementById("gateway-update-target");
    const gatewayUpdateVersion = document.getElementById("gateway-update-version");

    let vpsRows = [];
    let activeVpsId = "";
    let activeSessionId = "";
    let activeSessionsTab = "open";
    const sessionsByVps = new Map();

    function show(obj) {
      out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    }

    function requestId(prefix) {
      return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    async function call(path, init) {
      const res = await fetch(path, { credentials: "include", ...init });
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch {}
      show({ status: res.status, body: parsed });
      return { res, body: parsed };
    }

    async function fetchJSON(path, init) {
      const res = await fetch(path, { credentials: "include", ...init });
      const text = await res.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      return { res, body };
    }

    function wsUrl(path) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + window.location.host + path;
    }

    function utf8ToBase64(text) {
      const bytes = new TextEncoder().encode(text);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    let terminalComponent = null;

    function syncActiveSession(sessionId) {
      if (!sessionId) return;
      activeSessionId = sessionId;
      schemaSessionId.value = sessionId;
      if (terminalComponent) terminalComponent.setSessionId(sessionId);
    }

    terminalComponent = createStagingTerminalComponent({
      terminalMinHeightPx: 720,
      requestId: requestId,
      wsUrl: wsUrl,
      utf8ToBase64: utf8ToBase64,
      onSessionSelected: (sessionId) => {
        if (!sessionId) return;
        activeSessionId = sessionId;
        schemaSessionId.value = sessionId;
      },
    });

    function buildSchemaPreset() {
      const type = schemaCommandType.value;
      const sessionId = schemaSessionId.value.trim() || activeSessionId;
      const cmd = {
        type: type,
        schema_version: "1",
        request_id: requestId("schema"),
      };

      if (type === "session.snapshot" || type === "session.end") {
        cmd.session_id = sessionId;
      }

      if (type === "session.resize") {
        cmd.session_id = sessionId;
        cmd.cols = Number(schemaCols.value || 120);
        cmd.rows = Number(schemaRows.value || 32);
      }

      if (type === "session.input") {
        cmd.session_id = sessionId;
        const text = schemaInputText.value || "\\n";
        cmd.data = utf8ToBase64(text);
      }

      if (type === "agents.install") {
        cmd.agent = schemaAgent.value || "claude-code";
      }

      if (type === "ssh.authorize") {
        cmd.label = (schemaSSHLabel.value || "staging-key").trim();
        cmd.public_key = (schemaSSHPublicKey.value || "").trim();
      }

      if (type === "ssh.revoke") {
        cmd.fingerprint = (schemaSSHFingerprint.value || "").trim();
      }

      if (type === "gateway.update") {
        cmd.url = "https://releases.chatcode.dev/gateway/<version>/chatcode-gateway-linux-amd64";
        cmd.sha256 = "<sha256>";
        cmd.version = (gatewayUpdateVersion && gatewayUpdateVersion.value.trim()) || "${gatewayVersion}";
      }

      return cmd;
    }

    async function sendSchemaCommand() {
      if (!activeVpsId && !vpsSelect.value) {
        show("Select VPS first");
        return;
      }

      let cmd;
      try {
        cmd = JSON.parse(schemaJson.value);
      } catch {
        show("Invalid JSON in schema command payload");
        return;
      }

      const vpsId = vpsSelect.value || activeVpsId;
      const { res, body } = await call("/staging/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vps_id: vpsId, cmd: cmd }),
      });

      if (res.ok && cmd && typeof cmd.session_id === "string") {
        syncActiveSession(cmd.session_id);
      }

      if (vpsId) {
        await listSessions(vpsId);
      }

      return { res, body };
    }

    async function refreshMe() {
      const { res, body } = await call("/auth/me", { method: "GET" });
      if (res.ok) {
        unauth.style.display = "none";
        authed.style.display = "block";
        vps.style.display = "block";
        sessions.style.display = "block";
        terminalComponent.setVisible(true);
        schemaWrap.style.display = "block";
        meEl.textContent = JSON.stringify(body, null, 2);
        terminalComponent.scheduleFit();
        await listVPS();
      } else {
        unauth.style.display = "block";
        authed.style.display = "none";
        vps.style.display = "none";
        sessions.style.display = "none";
        terminalComponent.setVisible(false);
        schemaWrap.style.display = "none";
        vpsListPanel.innerHTML = "";
        agentsListPanel.textContent = "";
        sessionsTabs.innerHTML = "";
        sessionsListPanel.innerHTML = "";
      }
    }

    function renderVPSList(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        vpsListPanel.innerHTML = "<p>No VPS yet.</p>";
        return;
      }

      const html = rows.map((row) => {
        const id = escapeHtml(row.id);
        const label = escapeHtml(row.label || row.id);
        const status = escapeHtml(row.status || "unknown");
        const region = escapeHtml(row.region || "");
        const size = escapeHtml(row.size || "");
        const ip = escapeHtml(row.ipv4 || "-");
        const provider = escapeHtml(row.provider || "");
        const gatewayVersion = escapeHtml(row.gateway_version || "-");
        const gatewayState = row.gateway_connected ? "connected" : "disconnected";
        return (
          "<div class='vps-card'>" +
          "<div><strong>" + label + "</strong> <span class='muted'>(" + id + ")</span></div>" +
          "<div>Status: " + status + " | Region: " + region + " | Size: " + size + " | IPv4: " + ip + "</div>" +
          "<div class='muted'>Provider: " + provider + " | Gateway: " + gatewayVersion + " (" + gatewayState + ")</div>" +
          "<button data-id='" + id + "' class='use-vps'>Use for Sessions</button>" +
          "<button data-id='" + id + "' data-label='" + label + "' class='rename-vps'>Rename</button>" +
          (row.provider === "digitalocean"
            ? "<button data-id='" + id + "' data-status='" + status + "' class='power-vps'>" + (row.status === "active" ? "Power Off" : "Power On") + "</button>"
            : "") +
          "<button data-id='" + id + "' class='update-gateway'>Update Gateway</button>" +
          "<button data-id='" + id + "' class='destroy-vps'>Destroy VPS</button>" +
          "</div>"
        );
      }).join("");

      vpsListPanel.innerHTML = html;
    }

    function renderVPSSelect(rows) {
      const selected = activeVpsId || (rows[0] && rows[0].id) || "";
      activeVpsId = selected;
      vpsSelect.innerHTML = rows.map((row) => {
        const id = escapeHtml(row.id);
        const status = escapeHtml(row.status || "unknown");
        const selectedAttr = row.id === selected ? " selected" : "";
        return "<option value='" + id + "'" + selectedAttr + ">" + id + " (" + status + ")</option>";
      }).join("");
    }

    function isClosedSessionStatus(status) {
      const normalized = String(status || "").toLowerCase();
      return (
        normalized === "ended" ||
        normalized === "error" ||
        normalized === "failed" ||
        normalized === "closed" ||
        normalized.endsWith("_timeout")
      );
    }

    function renderSessionTabs(rows) {
      const openCount = rows.filter((row) => !isClosedSessionStatus(row.status)).length;
      const closedCount = rows.length - openCount;
      const tabs = [
        { key: "open", label: "Open (" + openCount + ")" },
        { key: "closed", label: "Closed (" + closedCount + ")" },
        { key: "all", label: "All (" + rows.length + ")" },
      ];
      sessionsTabs.innerHTML = tabs
        .map((tab) => {
          const activeClass = tab.key === activeSessionsTab ? " active" : "";
          return (
            "<button class='session-tab" +
            activeClass +
            "' data-tab='" +
            tab.key +
            "'>" +
            escapeHtml(tab.label) +
            "</button>"
          );
        })
        .join("");
    }

    async function listVPS() {
      const { res, body } = await call("/vps", { method: "GET" });
      if (res.ok && body && Array.isArray(body.vps)) {
        vpsRows = body.vps;
        renderVPSList(vpsRows);
        renderVPSSelect(vpsRows);
        if (activeVpsId) await listSessions(activeVpsId);
      }
      return { res, body };
    }

    async function pollGatewayUpdate(vpsId, version) {
      const deadline = Date.now() + 45000;
      let sawDisconnect = false;
      while (Date.now() < deadline) {
        await sleep(2000);
        const { res, body } = await fetchJSON("/vps", { method: "GET" });
        if (!res.ok || !body || !Array.isArray(body.vps)) continue;
        vpsRows = body.vps;
        renderVPSList(vpsRows);
        renderVPSSelect(vpsRows);
        const row = body.vps.find((entry) => entry && entry.id === vpsId);
        if (!row) continue;
        if (row.gateway_connected === false) {
          sawDisconnect = true;
        }
        if (row.gateway_version === version && row.gateway_connected === true) {
          show({
            status: 200,
            body: {
              ok: true,
              message: "gateway update completed",
              vps_id: vpsId,
              version: row.gateway_version,
              saw_disconnect: sawDisconnect,
            },
          });
          return true;
        }
      }
      show({
        status: 202,
        body: {
          ok: false,
          message: "gateway update accepted but timed out while waiting for reconnect",
          vps_id: vpsId,
          target_version: version,
        },
      });
      return false;
    }

    function renderSessions(vpsId, sessionRows) {
      if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
        sessionsTabs.innerHTML = "";
        sessionsListPanel.innerHTML = "<p>No sessions for " + escapeHtml(vpsId) + ".</p>";
        return;
      }

      renderSessionTabs(sessionRows);

      const filteredRows = sessionRows.filter((row) => {
        if (activeSessionsTab === "all") return true;
        const closed = isClosedSessionStatus(row.status);
        return activeSessionsTab === "closed" ? closed : !closed;
      });

      if (filteredRows.length === 0) {
        sessionsListPanel.innerHTML =
          "<p>No " + escapeHtml(activeSessionsTab) + " sessions for " + escapeHtml(vpsId) + ".</p>";
        return;
      }

      const html = filteredRows.map((row) => {
        const sidRaw = String(row.id || "");
        const sid = escapeHtml(sidRaw);
        const status = escapeHtml(row.status || "unknown");
        const title = escapeHtml(row.title || "");
        const agent = escapeHtml(row.agent_type || "");
        const wd = escapeHtml(row.workdir || "");
        const attachCmd = buildSessionAttachCommand(vpsId, sidRaw);
        const attachLine = attachCmd
          ? (
            "<div class='session-line muted'>" +
            "<span>SSH attach:</span>" +
            "<code class='session-cmd'>" + escapeHtml(attachCmd) + "</code>" +
            "<button data-cmd='" + escapeHtml(attachCmd) + "' class='copy-session-ssh'>Copy</button>" +
            "</div>"
          )
          : "<div class='session-line muted'>SSH attach: waiting for VPS IPv4</div>";
        return (
          "<div class='session-card'>" +
          "<div class='session-line'><strong>" + sid + "</strong><span>[" + status + "]</span><span>" + title + "</span><span>" + agent + "</span></div>" +
          "<div class='session-line muted'>Workdir: " + wd + "</div>" +
          attachLine +
          "<div class='session-actions'>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='connect-session'>Connect</button>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' data-title='" + title + "' class='rename-session'>Rename</button>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='snapshot-session'>Snapshot</button>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='end-session'>End</button>" +
          "</div>" +
          "</div>"
        );
      }).join("");

      sessionsListPanel.innerHTML = html;
    }

    function findVPS(vpsId) {
      return vpsRows.find((row) => row && row.id === vpsId) || null;
    }

    function buildSessionAttachCommand(vpsId, sessionId) {
      if (!vpsId || !sessionId) return "";
      const vps = findVPS(vpsId);
      const ip = vps && typeof vps.ipv4 === "string" ? vps.ipv4.trim() : "";
      if (!ip) return "";
      const tmuxName = "vibe-" + sessionId;
      return "ssh vibe@" + ip + " -t 'env TMUX_TMPDIR=/tmp/chatcode tmux attach -t " + tmuxName + "'";
    }

    async function copyToClipboard(text) {
      if (!text) return false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.focus();
      area.select();
      try {
        return document.execCommand("copy");
      } finally {
        document.body.removeChild(area);
      }
    }

    async function listSessions(vpsId) {
      if (!vpsId) return;
      const { res, body } = await call("/vps/" + encodeURIComponent(vpsId) + "/sessions", { method: "GET" });
      if (res.ok && body && Array.isArray(body.sessions)) {
        sessionsByVps.set(vpsId, body.sessions);
        renderSessions(vpsId, body.sessions);
      }
      return { res, body };
    }

    async function listAgents(vpsId) {
      if (!vpsId) return;
      const { res, body } = await call("/vps/" + encodeURIComponent(vpsId) + "/agents", { method: "GET" });
      if (res.ok && body && Array.isArray(body.agents)) {
        agentsListPanel.textContent = JSON.stringify(body.agents, null, 2);
      }
      return { res, body };
    }

    async function renameVPS(id, currentLabel) {
      const nextLabel = prompt("Rename server", currentLabel || "");
      if (nextLabel === null) return;
      await call("/vps/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: nextLabel }),
      });
      await listVPS();
    }

    async function renameSession(vpsId, sessionId, currentTitle) {
      const nextTitle = prompt("Rename session", currentTitle || "");
      if (nextTitle === null) return;
      await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      await listSessions(vpsId);
    }

    async function updateGateway(vpsId) {
      const target = (gatewayUpdateTarget && gatewayUpdateTarget.value) || "linux-amd64";
      const version = (gatewayUpdateVersion && gatewayUpdateVersion.value.trim()) || "";
      const query = new URLSearchParams({ vps_id: vpsId, target: target });
      if (version) query.set("version", version);
      const payload = await call("/staging/gateway-update-payload?" + query.toString(), { method: "GET" });
      if (!payload.res.ok || !payload.body || !payload.body.cmd) {
        return payload;
      }
      const result = await call("/staging/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vps_id: vpsId, cmd: payload.body.cmd }),
      });
      if (result.res.ok && payload.body.cmd.version) {
        await pollGatewayUpdate(vpsId, String(payload.body.cmd.version));
      } else {
        await listVPS();
      }
      return result;
    }

    document.getElementById("email-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      await call("/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    });

    document.getElementById("google-btn").addEventListener("click", () => {
      window.location.href = "/auth/google/start";
    });

    document.getElementById("github-btn").addEventListener("click", () => {
      window.location.href = "/auth/github/start";
    });

    document.getElementById("do-connect").addEventListener("click", () => {
      window.location.href = "/auth/do";
    });

    document.getElementById("logout").addEventListener("click", async () => {
      terminalComponent.disconnect();
      await call("/auth/logout", { method: "POST" });
      await refreshMe();
    });

    vpsSelect.addEventListener("change", async () => {
      activeVpsId = vpsSelect.value || "";
      if (activeVpsId) await listSessions(activeVpsId);
    });

    const vpsCreateBtn = document.getElementById("vps-create");
    const vpsManualBtn = document.getElementById("vps-manual");

    vpsCreateBtn.addEventListener("click", async () => {
      if (vpsCreateBtn.disabled) return;
      vpsCreateBtn.disabled = true;
      try {
        const region = document.getElementById("vps-region").value || "nyc1";
        const size = document.getElementById("vps-size").value || "s-1vcpu-512mb-10gb";
        const image = document.getElementById("vps-image").value || "ubuntu-24-04-x64";
        await call("/vps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region, size, image }),
        });
        await listVPS();
      } finally {
        vpsCreateBtn.disabled = false;
      }
    });

    vpsManualBtn.addEventListener("click", async () => {
      if (vpsManualBtn.disabled) return;
      vpsManualBtn.disabled = true;
      try {
        const label = document.getElementById("manual-label").value;
        await call("/vps/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        await listVPS();
      } finally {
        vpsManualBtn.disabled = false;
      }
    });

    document.getElementById("vps-list").addEventListener("click", async () => {
      await listVPS();
    });

    vpsListPanel.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList) return;

      if (target.classList.contains("destroy-vps")) {
        const id = target.dataset.id;
        if (!id) return;
        if (!confirm("Destroy VPS " + id + "?")) return;

        target.disabled = true;
        try {
          await call("/vps/" + encodeURIComponent(id), { method: "DELETE" });
          if (id === activeVpsId) {
            activeVpsId = "";
            sessionsListPanel.innerHTML = "";
          }
          await listVPS();
        } finally {
          target.disabled = false;
        }
      }

      if (target.classList.contains("use-vps")) {
        const id = target.dataset.id;
        if (!id) return;
        activeVpsId = id;
        vpsSelect.value = id;
        await listSessions(id);
        return;
      }

      if (target.classList.contains("rename-vps")) {
        const id = target.dataset.id;
        if (!id) return;
        await renameVPS(id, target.dataset.label || "");
        return;
      }

      if (target.classList.contains("power-vps")) {
        const id = target.dataset.id;
        const status = target.dataset.status || "";
        if (!id) return;
        const path = status === "active" ? "/power-off" : "/power-on";
        await call("/vps/" + encodeURIComponent(id) + path, { method: "POST" });
        await listVPS();
        return;
      }

      if (target.classList.contains("update-gateway")) {
        const id = target.dataset.id;
        if (!id) return;
        target.disabled = true;
        try {
          await updateGateway(id);
        } finally {
          target.disabled = false;
        }
        return;
      }
    });

    document.getElementById("sessions-list").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      if (!vpsId) return;
      activeVpsId = vpsId;
      await listSessions(vpsId);
    });

    document.getElementById("agents-list").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      if (!vpsId) return;
      activeVpsId = vpsId;
      await listAgents(vpsId);
    });

    sessionsTabs.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("session-tab")) {
        return;
      }
      const tab = target.dataset.tab;
      if (!tab || (tab !== "open" && tab !== "closed" && tab !== "all")) {
        return;
      }
      activeSessionsTab = tab;
      const vpsId = vpsSelect.value || activeVpsId;
      if (!vpsId) return;
      const rows = sessionsByVps.get(vpsId) || [];
      renderSessions(vpsId, rows);
    });

    document.getElementById("session-create").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      if (!vpsId) {
        show("Select VPS first");
        return;
      }
      activeVpsId = vpsId;
      const title = document.getElementById("session-title").value || "staging-session";
      const agent = document.getElementById("session-agent").value || "none";
      const workdir = document.getElementById("session-workdir").value || "/home/vibe/workspace";

      const { res, body } = await call("/vps/" + encodeURIComponent(vpsId) + "/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title, agent_type: agent, workdir: workdir }),
      });

      if (res.ok && body && body.session_id) {
        syncActiveSession(body.session_id);
      }

      await listSessions(vpsId);
    });

    sessionsListPanel.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList) return;

      if (target.classList.contains("copy-session-ssh")) {
        const cmd = target.dataset.cmd || "";
        if (!cmd) return;
        try {
          const ok = await copyToClipboard(cmd);
          show(ok ? "Copied: " + cmd : "Copy failed");
        } catch (err) {
          show("Copy failed: " + (err instanceof Error ? err.message : "unknown"));
        }
        return;
      }

      const vpsId = target.dataset.vps;
      const sessionId = target.dataset.sid;
      if (!vpsId || !sessionId) return;

      if (target.classList.contains("connect-session")) {
        syncActiveSession(sessionId);
        await terminalComponent.connect(vpsId, sessionId);
        return;
      }

      if (target.classList.contains("rename-session")) {
        await renameSession(vpsId, sessionId, target.dataset.title || "");
        return;
      }

      if (target.classList.contains("snapshot-session")) {
        await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId) + "/snapshot", { method: "GET" });
        return;
      }

      if (target.classList.contains("end-session")) {
        await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
        await listSessions(vpsId);
      }
    });

    document.getElementById("terminal-connect").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      const sessionId = terminalComponent.getSessionId().trim();
      if (!vpsId || !sessionId) return;
      syncActiveSession(sessionId);
      await terminalComponent.connect(vpsId, sessionId);
    });

    document.getElementById("terminal-disconnect").addEventListener("click", () => {
      terminalComponent.disconnect();
    });

    document.getElementById("terminal-snapshot").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      const sessionId = terminalComponent.getSessionId().trim();
      if (!vpsId || !sessionId) return;
      await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId) + "/snapshot", { method: "GET" });
    });

    document.getElementById("terminal-end").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      const sessionId = terminalComponent.getSessionId().trim();
      if (!vpsId || !sessionId) return;
      await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
      await listSessions(vpsId);
    });

    document.getElementById("schema-build").addEventListener("click", () => {
      const preset = buildSchemaPreset();
      schemaJson.value = JSON.stringify(preset, null, 2);
    });

    document.getElementById("schema-send").addEventListener("click", async () => {
      await sendSchemaCommand();
    });

    schemaCommandType.addEventListener("change", () => {
      const preset = buildSchemaPreset();
      schemaJson.value = JSON.stringify(preset, null, 2);
    });

    const initialPreset = buildSchemaPreset();
    schemaJson.value = JSON.stringify(initialPreset, null, 2);

    refreshMe();
  </script>
</body>
</html>`;
}
