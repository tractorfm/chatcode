#!/usr/bin/env node

import process from "node:process";
import { chromium } from "playwright";

const appURL = process.env.E2E_APP_URL || "https://app.staging.chatcode.dev";
const cpURL = process.env.E2E_CP_URL || "https://cp.staging.chatcode.dev";
const devUser = process.env.E2E_DEV_USER || "";
const devSecret = process.env.E2E_DEV_SECRET || "";
const configuredVpsId = process.env.E2E_VPS_ID || "";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 30000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(fn, opts = {}) {
  const timeout = opts.timeout ?? timeoutMs;
  const interval = opts.interval ?? 1000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

async function jsonRequest(context, method, path, body) {
  const resp = await context.request.fetch(`${cpURL}${path}`, {
    method,
    data: body,
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  return { resp, payload };
}

async function main() {
  if (!devUser || !devSecret) {
    throw new Error("Missing E2E_DEV_USER/E2E_DEV_SECRET");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const loginResp = await context.request.fetch(`${cpURL}/auth/dev/login`, {
      method: "POST",
      headers: {
        "X-Dev-User": devUser,
        "X-Dev-Secret": devSecret,
      },
    });
    if (!loginResp.ok()) {
      throw new Error(`auth/dev/login failed: ${loginResp.status()} ${await loginResp.text()}`);
    }

    const listResp = await jsonRequest(context, "GET", "/vps");
    if (!listResp.resp.ok()) {
      throw new Error(`GET /vps failed: ${listResp.resp.status()} ${JSON.stringify(listResp.payload)}`);
    }
    const vpsList = Array.isArray(listResp.payload?.vps) ? listResp.payload.vps : [];
    const targetVps =
      vpsList.find((v) => v.id === configuredVpsId) ??
      vpsList.find((v) => v.status === "active" && v.gateway_connected);
    if (!targetVps?.id) {
      throw new Error("No active+connected VPS found for smoke run (set E2E_VPS_ID).");
    }
    const vpsId = targetVps.id;

    await page.goto(appURL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: timeoutMs });
    await page.click(`[data-testid="vps-item-${vpsId}"]`, { timeout: timeoutMs });

    const listSessionsResp = await jsonRequest(context, "GET", `/vps/${encodeURIComponent(vpsId)}/sessions`);
    if (!listSessionsResp.resp.ok()) {
      throw new Error(`GET sessions failed: ${listSessionsResp.resp.status()}`);
    }
    const existingSessions = Array.isArray(listSessionsResp.payload?.sessions)
      ? listSessionsResp.payload.sessions
      : [];
    const openSessions = existingSessions.filter((s) =>
      !["ended", "error", "provisioning_timeout"].includes(String(s.status || "")),
    );
    if (openSessions.length >= 5) {
      const victims = openSessions.slice(0, openSessions.length - 4);
      for (const victim of victims) {
        await jsonRequest(
          context,
          "DELETE",
          `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(victim.id)}`,
        );
      }
      await sleep(1200);
    }

    const createResp = await jsonRequest(
      context,
      "POST",
      `/vps/${encodeURIComponent(vpsId)}/sessions`,
      {
        title: `smoke-${Date.now()}`,
        agent_type: "none",
        workdir: "/home/vibe/workspace",
      },
    );
    if (!createResp.resp.ok()) {
      throw new Error(`Session create failed: ${createResp.resp.status()} ${JSON.stringify(createResp.payload)}`);
    }
    const createdSessionId = typeof createResp.payload?.session_id === "string"
      ? createResp.payload.session_id
      : null;

    if (!createdSessionId) {
      throw new Error("Session create response missing session_id");
    }

    // Force sidebar session list refresh after out-of-band API create.
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: timeoutMs });
    await page.click(`[data-testid="vps-item-${vpsId}"]`, { timeout: timeoutMs });
    await page.waitForSelector(`[data-testid="session-item-${createdSessionId}"]`, { timeout: 45000 });
    await page.click(`[data-testid="session-item-${createdSessionId}"]`, { timeout: timeoutMs });
    await page.waitForSelector(`[data-testid="terminal-${createdSessionId}"]`, { timeout: timeoutMs });
    await pollUntil(async () => {
      const sessionsResp = await jsonRequest(context, "GET", `/vps/${encodeURIComponent(vpsId)}/sessions`);
      if (!sessionsResp.resp.ok()) return false;
      const sessions = Array.isArray(sessionsResp.payload?.sessions) ? sessionsResp.payload.sessions : [];
      const session = sessions.find((s) => s.id === createdSessionId);
      return session?.status === "running";
    }, { timeout: 45000, interval: 1000 });
    await page.click(`[data-testid="terminal-${createdSessionId}"]`);
    const activeInput = page
      .locator(`[data-testid="terminal-${createdSessionId}"]`)
      .locator(".xterm-helper-textarea")
      .first();
    await activeInput.focus();

    const marker1 = `SMOKE1_${Date.now()}`;
    const input1 = await jsonRequest(context, "POST", "/staging/cmd", {
      vps_id: vpsId,
      cmd: {
        type: "session.input",
        schema_version: "1",
        request_id: `smoke-in-${Date.now()}`,
        session_id: createdSessionId,
        data: Buffer.from(`echo ${marker1}\n`).toString("base64"),
      },
    });
    if (!input1.resp.ok()) {
      throw new Error(`staging cmd input failed: ${input1.resp.status()} ${JSON.stringify(input1.payload)}`);
    }

    const seenMarker1 = await pollUntil(async () => {
      const snap = await jsonRequest(
        context,
        "GET",
        `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(createdSessionId)}/snapshot`,
      );
      if (!snap.resp.ok()) return false;
      const content = typeof snap.payload?.content === "string" ? snap.payload.content : "";
      return content.includes(marker1);
    }, { timeout: 45000, interval: 1000 });
    if (!seenMarker1) {
      throw new Error("Terminal did not echo first marker");
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: timeoutMs });
    await page.click(`[data-testid="vps-item-${vpsId}"]`, { timeout: timeoutMs });
    await page.click(`[data-testid="session-item-${createdSessionId}"]`, { timeout: timeoutMs });
    const reloadedInput = page
      .locator(`[data-testid="terminal-${createdSessionId}"]`)
      .locator(".xterm-helper-textarea")
      .first();
    await reloadedInput.focus();

    const marker2 = `SMOKE2_${Date.now()}`;
    const input2 = await jsonRequest(context, "POST", "/staging/cmd", {
      vps_id: vpsId,
      cmd: {
        type: "session.input",
        schema_version: "1",
        request_id: `smoke-in-${Date.now()}`,
        session_id: createdSessionId,
        data: Buffer.from(`echo ${marker2}\n`).toString("base64"),
      },
    });
    if (!input2.resp.ok()) {
      throw new Error(`staging cmd input after reload failed: ${input2.resp.status()} ${JSON.stringify(input2.payload)}`);
    }
    const seenMarker2 = await pollUntil(async () => {
      const snap = await jsonRequest(
        context,
        "GET",
        `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(createdSessionId)}/snapshot`,
      );
      if (!snap.resp.ok()) return false;
      const content = typeof snap.payload?.content === "string" ? snap.payload.content : "";
      return content.includes(marker2);
    }, { timeout: 45000, interval: 1000 });
    if (!seenMarker2) {
      throw new Error("Terminal did not echo marker after reload");
    }

    const endResp = await jsonRequest(
      context,
      "DELETE",
      `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(createdSessionId)}`,
    );
    if (endResp.resp.status() !== 204) {
      throw new Error(`Failed to end session ${createdSessionId}: ${endResp.resp.status()}`);
    }

    console.log(`Smoke OK on VPS ${vpsId}, session ${createdSessionId}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[e2e-smoke] failed:", err);
  process.exit(1);
});
