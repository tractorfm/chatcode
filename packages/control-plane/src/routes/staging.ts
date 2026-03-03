import type { Env } from "../types.js";

export function handleStagingTestPage(_request: Request, env: Env): Response {
  if (env.APP_ENV !== "staging" && env.APP_ENV !== "dev") {
    return new Response("not found", { status: 404 });
  }

  return new Response(htmlPage(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function htmlPage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chatcode Staging Test</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 20px; line-height: 1.4; }
    h1, h2 { margin: 0 0 8px 0; }
    button { margin-right: 8px; margin-bottom: 8px; }
    input, select { margin-right: 8px; margin-bottom: 8px; padding: 6px; }
    pre { background: #f5f5f5; padding: 12px; overflow: auto; border: 1px solid #ddd; white-space: pre-wrap; }
    .section { margin-bottom: 16px; border: 1px solid #ddd; padding: 12px; border-radius: 6px; }
    .row { margin-bottom: 8px; }
    .muted { color: #666; font-size: 12px; }
    #terminal { height: 420px; width: 100%; border: 1px solid #222; background: #111; }
    .vps-card, .session-card { padding: 8px; border: 1px solid #ddd; margin-top: 8px; border-radius: 4px; }
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

  <h2>Last API Result</h2>
  <pre id="out">{}</pre>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    const out = document.getElementById("out");
    const meEl = document.getElementById("me");
    const unauth = document.getElementById("auth-unauth");
    const authed = document.getElementById("auth-authed");
    const vps = document.getElementById("vps");
    const sessions = document.getElementById("sessions");
    const terminalWrap = document.getElementById("terminal-wrap");
    const vpsListPanel = document.getElementById("vps-list-panel");
    const sessionsListPanel = document.getElementById("sessions-list-panel");
    const vpsSelect = document.getElementById("session-vps-select");
    const terminalSessionInput = document.getElementById("terminal-session-id");
    const terminalStatus = document.getElementById("terminal-status");

    let vpsRows = [];
    let activeVpsId = "";
    let activeSessionId = "";

    let term = null;
    let termSocket = null;
    let termInputDisposable = null;

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
          convertEol: true,
          fontSize: 13,
          scrollback: 5000,
          theme: { background: "#111", foreground: "#ddd" },
        });
        term.open(document.getElementById("terminal"));
      }
      return true;
    }

    function setTerminalStatus(text) {
      terminalStatus.textContent = text;
    }

    function disconnectTerminal() {
      if (termInputDisposable) {
        termInputDisposable.dispose();
        termInputDisposable = null;
      }
      if (termSocket) {
        try { termSocket.close(1000, "user disconnect"); } catch {}
      }
      termSocket = null;
      setTerminalStatus("disconnected");
    }

    async function refreshMe() {
      const { res, body } = await call("/auth/me", { method: "GET" });
      if (res.ok) {
        unauth.style.display = "none";
        authed.style.display = "block";
        vps.style.display = "block";
        sessions.style.display = "block";
        terminalWrap.style.display = "block";
        meEl.textContent = JSON.stringify(body, null, 2);
        await listVPS();
      } else {
        unauth.style.display = "block";
        authed.style.display = "none";
        vps.style.display = "none";
        sessions.style.display = "none";
        terminalWrap.style.display = "none";
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
      activeSessionId = sessionId;
      terminalSessionInput.value = sessionId;

      term.clear();
      term.writeln("Connecting to " + sessionId + " ...");

      const path = "/vps/" + encodeURIComponent(vpsId) + "/terminal?session_id=" + encodeURIComponent(sessionId);
      termSocket = new WebSocket(wsUrl(path));
      termSocket.binaryType = "arraybuffer";

      termSocket.addEventListener("open", () => {
        setTerminalStatus("connected: " + sessionId);

        const resizeMsg = {
          type: "session.resize",
          schema_version: "1",
          request_id: requestId("resize-init"),
          session_id: sessionId,
          cols: term.cols || 80,
          rows: term.rows || 24,
        };
        try { termSocket.send(JSON.stringify(resizeMsg)); } catch {}

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
      });

      termSocket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }

          if (msg.type === "session.snapshot" && msg.session_id === activeSessionId && typeof msg.content === "string") {
            term.clear();
            term.write(msg.content);
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
        }
      });

      termSocket.addEventListener("close", () => {
        if (termInputDisposable) {
          termInputDisposable.dispose();
          termInputDisposable = null;
        }
        if (term) term.writeln("\\r\\n[terminal socket closed]");
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
        activeSessionId = body.session_id;
        terminalSessionInput.value = body.session_id;
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

    refreshMe();
  </script>
</body>
</html>`;
}
