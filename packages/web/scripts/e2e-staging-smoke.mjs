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

    const beforeSessions = await jsonRequest(context, "GET", `/vps/${encodeURIComponent(vpsId)}/sessions`);
    if (!beforeSessions.resp.ok()) {
      throw new Error(`GET sessions failed: ${beforeSessions.resp.status()}`);
    }
    const beforeIds = new Set(
      (Array.isArray(beforeSessions.payload?.sessions) ? beforeSessions.payload.sessions : []).map((s) => s.id),
    );

    await page.click('[data-testid="create-session-button"]', { timeout: timeoutMs });

    const createdSessionId = await pollUntil(async () => {
      const sessionsResp = await jsonRequest(context, "GET", `/vps/${encodeURIComponent(vpsId)}/sessions`);
      if (!sessionsResp.resp.ok()) return null;
      const sessions = Array.isArray(sessionsResp.payload?.sessions) ? sessionsResp.payload.sessions : [];
      const created = sessions.find((s) => !beforeIds.has(s.id));
      return created?.id || null;
    }, { timeout: 45000, interval: 1500 });

    if (!createdSessionId) {
      throw new Error("Session creation not observed in time");
    }

    await page.click(`[data-testid="session-item-${createdSessionId}"]`, { timeout: timeoutMs });
    await page.waitForSelector(`[data-testid="terminal-${createdSessionId}"]`, { timeout: timeoutMs });

    const marker1 = `SMOKE1_${Date.now()}`;
    await page.keyboard.type(`echo ${marker1}`);
    await page.keyboard.press("Enter");

    const seenMarker1 = await pollUntil(async () => {
      return page.evaluate(
        (marker) =>
          Array.from(document.querySelectorAll(".xterm-rows > div"))
            .map((el) => el.textContent || "")
            .join("\n")
            .includes(marker),
        marker1,
      );
    }, { timeout: 45000, interval: 1000 });
    if (!seenMarker1) {
      throw new Error("Terminal did not echo first marker");
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: timeoutMs });
    await page.click(`[data-testid="vps-item-${vpsId}"]`, { timeout: timeoutMs });
    await page.click(`[data-testid="session-item-${createdSessionId}"]`, { timeout: timeoutMs });

    const marker2 = `SMOKE2_${Date.now()}`;
    await page.keyboard.type(`echo ${marker2}`);
    await page.keyboard.press("Enter");
    const seenMarker2 = await pollUntil(async () => {
      return page.evaluate(
        (marker) =>
          Array.from(document.querySelectorAll(".xterm-rows > div"))
            .map((el) => el.textContent || "")
            .join("\n")
            .includes(marker),
        marker2,
      );
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
