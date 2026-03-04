import type { Env, AuthContext } from "../types.js";
import { getGatewayByVPS, getVPS } from "../db/schema.js";

export function handleStagingTestPage(_request: Request, env: Env): Response {
  if (!isStagingEnabled(env)) {
    return new Response("not found", { status: 404 });
  }

  return new Response(htmlPage(), {
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

function isStagingEnabled(env: Env): boolean {
  return env.APP_ENV === "staging" || env.APP_ENV === "dev";
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlPage(): string {
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
    #terminal {
      width: 100%;
      min-width: 360px;
      min-height: 360px;
      height: 420px;
      border: 1px solid #222;
      background: #111;
      line-height: 1;
      overflow: hidden;
      box-sizing: border-box;
    }
    .vps-card, .session-card { padding: 8px; border: 1px solid #ddd; margin-top: 8px; border-radius: 4px; }
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
    <div id="vps-list-panel"></div>
  </div>

  <div id="sessions" class="section" style="display:none">
    <h2>Sessions</h2>
    <div class="row">
      <label for="session-vps-select">VPS:</label>
      <select id="session-vps-select"></select>
      <button id="sessions-list">List Sessions</button>
    </div>
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
    <div id="sessions-list-panel"></div>
  </div>

  <div id="terminal-wrap" class="section" style="display:none">
    <h2>Terminal Stream (xterm.js)</h2>
    <div class="row">
      <label for="terminal-session-id">Session:</label>
      <input id="terminal-session-id" placeholder="session id" style="min-width: 280px" />
      <button id="terminal-connect">Connect</button>
      <button id="terminal-disconnect">Disconnect</button>
      <button id="terminal-snapshot">Snapshot</button>
      <button id="terminal-end">End Session</button>
    </div>
    <div class="muted" id="terminal-status">disconnected</div>
    <div id="terminal"></div>
  </div>

  <div id="schema-wrap" class="section" style="display:none">
    <h2>Schema Command Tester (staging only)</h2>
    <div class="row muted">Build a command from protocol schema presets, edit JSON if needed, then relay to gateway via control-plane.</div>
    <div class="row">
      <select id="schema-command-type">
        <option value="session.snapshot">session.snapshot</option>
        <option value="session.resize">session.resize</option>
        <option value="session.input">session.input</option>
        <option value="session.end">session.end</option>
        <option value="ssh.list">ssh.list</option>
        <option value="agents.install">agents.install</option>
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
      <button id="schema-build">Build Preset</button>
      <button id="schema-send">Send Command</button>
    </div>
    <textarea id="schema-json" spellcheck="false"></textarea>
  </div>

  <h2>Last API Result</h2>
  <pre id="out">{}</pre>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js"></script>
  <script>
    const out = document.getElementById("out");
    const meEl = document.getElementById("me");
    const unauth = document.getElementById("auth-unauth");
    const authed = document.getElementById("auth-authed");
    const vps = document.getElementById("vps");
    const sessions = document.getElementById("sessions");
    const terminalWrap = document.getElementById("terminal-wrap");
    const schemaWrap = document.getElementById("schema-wrap");
    const vpsListPanel = document.getElementById("vps-list-panel");
    const sessionsListPanel = document.getElementById("sessions-list-panel");
    const vpsSelect = document.getElementById("session-vps-select");
    const terminalSessionInput = document.getElementById("terminal-session-id");
    const terminalStatus = document.getElementById("terminal-status");
    const schemaCommandType = document.getElementById("schema-command-type");
    const schemaSessionId = document.getElementById("schema-session-id");
    const schemaInputText = document.getElementById("schema-input-text");
    const schemaCols = document.getElementById("schema-cols");
    const schemaRows = document.getElementById("schema-rows");
    const schemaAgent = document.getElementById("schema-agent");
    const schemaJson = document.getElementById("schema-json");

    let vpsRows = [];
    let activeVpsId = "";
    let activeSessionId = "";

    let term = null;
    let fitAddon = null;
    let termResizeObserver = null;
    let fitTimer = null;
    let termSocket = null;
    let termInputDisposable = null;
    let termKeepaliveTimer = null;
    let lastResizeCols = 0;
    let lastResizeRows = 0;
    const terminalMinHeightPx = 360;
    const terminalMaxViewportRatio = 0.88;

    function show(obj) {
      out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    }

    function requestId(prefix) {
      return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
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

    function decodeTerminalFrame(data) {
      const buf = new Uint8Array(data);
      if (buf.length < 2) return null;
      const kind = buf[0];
      const sidLen = buf[1];
      if (buf.length < 2 + sidLen + 8) return null;
      const sidBytes = buf.slice(2, 2 + sidLen);
      const sessionId = new TextDecoder().decode(sidBytes);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const seq = Number(view.getBigUint64(2 + sidLen, false));
      const payload = buf.slice(2 + sidLen + 8);
      return { kind, sessionId, seq, payload };
    }

    function ensureTerminal() {
      if (!window.Terminal) {
        terminalStatus.textContent = "xterm failed to load";
        return false;
      }
      if (!term) {
        term = new window.Terminal({
          cursorBlink: true,
          convertEol: false,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          scrollback: 50000,
          theme: { background: "#111", foreground: "#ddd" },
        });
        if (window.FitAddon && typeof window.FitAddon.FitAddon === "function") {
          fitAddon = new window.FitAddon.FitAddon();
          term.loadAddon(fitAddon);
        }

        const terminalNode = document.getElementById("terminal");
        term.open(terminalNode);
        scheduleTerminalFit();
        setTimeout(scheduleTerminalFit, 120);
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
          document.fonts.ready.then(() => scheduleTerminalFit()).catch(() => {});
        }

        term.onResize(({ cols, rows }) => {
          sendSessionResize(cols, rows);
        });
        window.addEventListener("resize", () => {
          if (!term) return;
          scheduleTerminalFit();
        });
        if (window.ResizeObserver) {
          termResizeObserver = new window.ResizeObserver(() => scheduleTerminalFit());
          termResizeObserver.observe(terminalNode);
        }
      }
      return true;
    }

    function applyTerminalHostSize() {
      const terminalNode = document.getElementById("terminal");
      if (!terminalNode) return;
      if (terminalNode.offsetParent === null) return;

      const rect = terminalNode.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 0;
      if (viewportHeight <= 0) return;

      const availableHeight = Math.floor(viewportHeight - rect.top - 20);
      const maxByViewport = Math.floor(viewportHeight * terminalMaxViewportRatio);
      const targetHeight = Math.max(
        terminalMinHeightPx,
        Math.min(Math.max(availableHeight, terminalMinHeightPx), maxByViewport),
      );

      const currentHeight = parseInt(terminalNode.style.height || "0", 10);
      if (!Number.isFinite(currentHeight) || Math.abs(currentHeight - targetHeight) >= 1) {
        terminalNode.style.height = targetHeight + "px";
      }
      terminalNode.style.width = "100%";
    }

    function scheduleTerminalFit() {
      if (!term) return;
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        if (!term) return;
        applyTerminalHostSize();
        if (fitAddon && typeof fitAddon.fit === "function") {
          try { fitAddon.fit(); } catch {}
        }
        sendSessionResize(term.cols || 80, term.rows || 24);
      }, 16);
    }

    function setTerminalStatus(text) {
      terminalStatus.textContent = text;
    }

    function syncActiveSession(sessionId) {
      if (!sessionId) return;
      activeSessionId = sessionId;
      terminalSessionInput.value = sessionId;
      schemaSessionId.value = sessionId;
    }

    function disconnectTerminal() {
      if (termInputDisposable) {
        termInputDisposable.dispose();
        termInputDisposable = null;
      }
      if (fitTimer) {
        clearTimeout(fitTimer);
        fitTimer = null;
      }
      if (termKeepaliveTimer) {
        clearInterval(termKeepaliveTimer);
        termKeepaliveTimer = null;
      }
      if (termSocket) {
        try { termSocket.close(1000, "user disconnect"); } catch {}
      }
      termSocket = null;
      lastResizeCols = 0;
      lastResizeRows = 0;
      setTerminalStatus("disconnected");
    }

    function sendSessionResize(cols, rows) {
      if (!termSocket || termSocket.readyState !== WebSocket.OPEN) return;
      if (!activeSessionId) return;
      if (cols === lastResizeCols && rows === lastResizeRows) return;
      lastResizeCols = cols;
      lastResizeRows = rows;
      const resizeMsg = {
        type: "session.resize",
        schema_version: "1",
        request_id: requestId("resize"),
        session_id: activeSessionId,
        cols: cols,
        rows: rows,
      };
      try {
        termSocket.send(JSON.stringify(resizeMsg));
      } catch {}
    }

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
        terminalWrap.style.display = "block";
        schemaWrap.style.display = "block";
        meEl.textContent = JSON.stringify(body, null, 2);
        scheduleTerminalFit();
        await listVPS();
      } else {
        unauth.style.display = "block";
        authed.style.display = "none";
        vps.style.display = "none";
        sessions.style.display = "none";
        terminalWrap.style.display = "none";
        schemaWrap.style.display = "none";
        vpsListPanel.innerHTML = "";
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
        const status = escapeHtml(row.status || "unknown");
        const region = escapeHtml(row.region || "");
        const size = escapeHtml(row.size || "");
        const ip = escapeHtml(row.ipv4 || "-");
        return (
          "<div class='vps-card'>" +
          "<div><strong>" + id + "</strong></div>" +
          "<div>Status: " + status + " | Region: " + region + " | Size: " + size + " | IPv4: " + ip + "</div>" +
          "<button data-id='" + id + "' class='use-vps'>Use for Sessions</button>" +
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

    function renderSessions(vpsId, sessionRows) {
      if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
        sessionsListPanel.innerHTML = "<p>No sessions for " + escapeHtml(vpsId) + ".</p>";
        return;
      }

      const html = sessionRows.map((row) => {
        const sid = escapeHtml(row.id);
        const status = escapeHtml(row.status || "unknown");
        const title = escapeHtml(row.title || "");
        const agent = escapeHtml(row.agent_type || "");
        const wd = escapeHtml(row.workdir || "");
        return (
          "<div class='session-card'>" +
          "<div><strong>" + sid + "</strong></div>" +
          "<div>Title: " + title + " | Agent: " + agent + " | Status: " + status + "</div>" +
          "<div>Workdir: " + wd + "</div>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='connect-session'>Connect</button>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='snapshot-session'>Snapshot</button>" +
          "<button data-vps='" + escapeHtml(vpsId) + "' data-sid='" + sid + "' class='end-session'>End</button>" +
          "</div>"
        );
      }).join("");

      sessionsListPanel.innerHTML = html;
    }

    async function listSessions(vpsId) {
      if (!vpsId) return;
      const { res, body } = await call("/vps/" + encodeURIComponent(vpsId) + "/sessions", { method: "GET" });
      if (res.ok && body && Array.isArray(body.sessions)) {
        renderSessions(vpsId, body.sessions);
      }
      return { res, body };
    }

    async function connectTerminal(vpsId, sessionId) {
      if (!vpsId || !sessionId) return;
      if (!ensureTerminal()) return;

      disconnectTerminal();
      activeVpsId = vpsId;
      syncActiveSession(sessionId);

      term.clear();
      term.writeln("Connecting to " + sessionId + " ...");
      scheduleTerminalFit();
      term.focus();

      const path = "/vps/" + encodeURIComponent(vpsId) + "/terminal?session_id=" + encodeURIComponent(sessionId);
      termSocket = new WebSocket(wsUrl(path));
      termSocket.binaryType = "arraybuffer";

      termSocket.addEventListener("open", () => {
        setTerminalStatus("connected: " + sessionId);
        scheduleTerminalFit();
        term.focus();

        termInputDisposable = term.onData((data) => {
          if (!termSocket || termSocket.readyState !== WebSocket.OPEN) return;
          const inputMsg = {
            type: "session.input",
            schema_version: "1",
            request_id: requestId("input"),
            session_id: sessionId,
            data: utf8ToBase64(data),
          };
          try {
            termSocket.send(JSON.stringify(inputMsg));
          } catch {}
        });

        termKeepaliveTimer = setInterval(() => {
          if (!termSocket || termSocket.readyState !== WebSocket.OPEN) return;
          try { termSocket.send(JSON.stringify({ type: "ping" })); } catch {}
        }, 20000);
      });

      termSocket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }

          if (msg.type === "ack" && msg.ok === false) {
            const errText = msg.error || "gateway command failed";
            term.writeln("\\r\\n[ack error] " + errText);
            return;
          }

          if (msg.type === "session.snapshot" && msg.session_id === activeSessionId && typeof msg.content === "string") {
            term.reset();
            term.write(String(msg.content));
            return;
          }

          if (msg.type === "session.error" && msg.session_id === activeSessionId) {
            term.writeln("\\r\\n[session.error] " + (msg.error || "unknown"));
            return;
          }

          if (msg.type === "session.ended" && msg.session_id === activeSessionId) {
            term.writeln("\\r\\n[session ended]");
            return;
          }

          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const frame = decodeTerminalFrame(event.data);
          if (!frame || frame.kind !== 0x01) return;
          if (frame.sessionId !== activeSessionId) return;
          const text = new TextDecoder().decode(frame.payload);
          term.write(text);
          if (termSocket && termSocket.readyState === WebSocket.OPEN) {
            const ackMsg = {
              type: "session.ack",
              schema_version: "1",
              request_id: requestId("ack"),
              session_id: frame.sessionId,
              seq: frame.seq,
            };
            try { termSocket.send(JSON.stringify(ackMsg)); } catch {}
          }
        }
      });

      termSocket.addEventListener("close", (ev) => {
        if (termInputDisposable) {
          termInputDisposable.dispose();
          termInputDisposable = null;
        }
        if (termKeepaliveTimer) {
          clearInterval(termKeepaliveTimer);
          termKeepaliveTimer = null;
        }
        if (term) {
          const reason = ev && ev.reason ? " reason=" + ev.reason : "";
          term.writeln("\\r\\n[terminal socket closed code=" + ev.code + reason + "]");
        }
        termSocket = null;
        setTerminalStatus("disconnected");
      });

      termSocket.addEventListener("error", () => {
        if (term) term.writeln("\\r\\n[terminal socket error]");
      });
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
      disconnectTerminal();
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
      }
    });

    document.getElementById("sessions-list").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      if (!vpsId) return;
      activeVpsId = vpsId;
      await listSessions(vpsId);
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

      const vpsId = target.dataset.vps;
      const sessionId = target.dataset.sid;
      if (!vpsId || !sessionId) return;

      if (target.classList.contains("connect-session")) {
        syncActiveSession(sessionId);
        await connectTerminal(vpsId, sessionId);
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
      const sessionId = terminalSessionInput.value.trim();
      if (!vpsId || !sessionId) return;
      syncActiveSession(sessionId);
      await connectTerminal(vpsId, sessionId);
    });

    document.getElementById("terminal-disconnect").addEventListener("click", () => {
      disconnectTerminal();
    });

    document.getElementById("terminal-snapshot").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      const sessionId = terminalSessionInput.value.trim();
      if (!vpsId || !sessionId) return;
      await call("/vps/" + encodeURIComponent(vpsId) + "/sessions/" + encodeURIComponent(sessionId) + "/snapshot", { method: "GET" });
    });

    document.getElementById("terminal-end").addEventListener("click", async () => {
      const vpsId = vpsSelect.value || activeVpsId;
      const sessionId = terminalSessionInput.value.trim();
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
