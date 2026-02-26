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
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 20px; line-height: 1.4; }
    button { margin-right: 8px; margin-bottom: 8px; }
    input { margin-right: 8px; padding: 6px; }
    pre { background: #f5f5f5; padding: 12px; overflow: auto; border: 1px solid #ddd; }
    .section { margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Chatcode Staging Test</h1>

  <div id="auth-unauth" class="section" style="display:none">
    <h2>Sign In</h2>
    <form id="email-form">
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
    <input id="vps-region" value="nyc1" placeholder="region (e.g. nyc1)" />
    <input id="vps-size" value="s-1vcpu-512mb-10gb" placeholder="size slug" />
    <input id="vps-image" value="ubuntu-24-04-x64" placeholder="image slug" />
    <br />
    <button id="vps-create">Create VPS</button>
    <input id="manual-label" placeholder="manual label (optional)" />
    <button id="vps-manual">Add VPS (Manual)</button>
    <button id="vps-list">List VPS</button>
    <div id="vps-list-panel"></div>
  </div>

  <h2>Last API Result</h2>
  <pre id="out">{}</pre>

  <script>
    const out = document.getElementById("out");
    const meEl = document.getElementById("me");
    const unauth = document.getElementById("auth-unauth");
    const authed = document.getElementById("auth-authed");
    const vps = document.getElementById("vps");
    const vpsListPanel = document.getElementById("vps-list-panel");

    function show(obj) {
      out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    }

    async function call(path, init) {
      const res = await fetch(path, { credentials: "include", ...init });
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch {}
      show({ status: res.status, body: parsed });
      return { res, body: parsed };
    }

    async function refreshMe() {
      const { res, body } = await call("/auth/me", { method: "GET" });
      if (res.ok) {
        unauth.style.display = "none";
        authed.style.display = "block";
        vps.style.display = "block";
        meEl.textContent = JSON.stringify(body, null, 2);
        await listVPS();
      } else {
        unauth.style.display = "block";
        authed.style.display = "none";
        vps.style.display = "none";
        vpsListPanel.innerHTML = "";
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function renderVPSList(vpsRows) {
      if (!Array.isArray(vpsRows) || vpsRows.length === 0) {
        vpsListPanel.innerHTML = "<p>No VPS yet.</p>";
        return;
      }

      const rows = vpsRows.map((row) => {
        const id = escapeHtml(row.id);
        const status = escapeHtml(row.status || "unknown");
        const region = escapeHtml(row.region || "");
        const size = escapeHtml(row.size || "");
        const ip = escapeHtml(row.ipv4 || "-");
        return (
          "<div style='padding:8px;border:1px solid #ddd;margin-top:8px'>" +
          "<div><strong>" + id + "</strong></div>" +
          "<div>Status: " + status + " | Region: " + region + " | Size: " + size + " | IPv4: " + ip + "</div>" +
          "<button data-id='" + id + "' class='destroy-vps' style='margin-top:6px'>Destroy VPS</button>" +
          "</div>"
        );
      }).join("");

      vpsListPanel.innerHTML = rows;
    }

    async function listVPS() {
      const { res, body } = await call("/vps", { method: "GET" });
      if (res.ok && body && Array.isArray(body.vps)) {
        renderVPSList(body.vps);
      }
      return { res, body };
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
      await call("/auth/logout", { method: "POST" });
      await refreshMe();
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
      if (!target || !target.classList || !target.classList.contains("destroy-vps")) {
        return;
      }
      const id = target.dataset.id;
      if (!id) return;
      if (!confirm("Destroy VPS " + id + "?")) return;

      target.disabled = true;
      try {
        await call("/vps/" + encodeURIComponent(id), { method: "DELETE" });
        await listVPS();
      } finally {
        target.disabled = false;
      }
    });

    refreshMe();
  </script>
</body>
</html>`;
}
