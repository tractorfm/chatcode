import { describe, expect, it } from "vitest";
import { corsHeaders, postAuthRedirect, withCORS } from "../src/lib/http";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: "dev",
    ...overrides,
  } as any;
}

describe("postAuthRedirect", () => {
  it("uses staging app origin when APP_ENV=staging", () => {
    const env = makeEnv({ APP_ENV: "staging" });
    const request = new Request("https://cp.staging.chatcode.dev/auth/google/callback");
    expect(postAuthRedirect(request, env)).toBe("https://app.staging.chatcode.dev");
  });

  it("uses prod app origin when APP_ENV=prod", () => {
    const env = makeEnv({ APP_ENV: "prod" });
    const request = new Request("https://cp.chatcode.dev/auth/google/callback");
    expect(postAuthRedirect(request, env)).toBe("https://app.chatcode.dev");
  });

  it("honors explicit redirect override", () => {
    const env = makeEnv({
      APP_ENV: "staging",
      POST_AUTH_REDIRECT_URL: "https://custom.example.dev/welcome",
      CORS_ALLOWED_ORIGINS: "https://custom.example.dev",
    });
    const request = new Request("https://cp.staging.chatcode.dev/auth/google/callback");
    expect(postAuthRedirect(request, env)).toBe("https://custom.example.dev/welcome");
  });

  it("ignores unsafe override and falls back to env default", () => {
    const env = makeEnv({
      APP_ENV: "staging",
      POST_AUTH_REDIRECT_URL: "javascript:alert(1)",
      STAGING_APP_ORIGIN: "https://app.staging.chatcode.dev",
    });
    const request = new Request("https://cp.staging.chatcode.dev/auth/google/callback");
    expect(postAuthRedirect(request, env)).toBe("https://app.staging.chatcode.dev");
  });
});

describe("corsHeaders", () => {
  it("allows credentialed staging app origin", () => {
    const env = makeEnv({
      APP_ENV: "staging",
      STAGING_APP_ORIGIN: "https://app.staging.chatcode.dev",
    });
    const request = new Request("https://cp.staging.chatcode.dev/auth/me", {
      headers: { Origin: "https://app.staging.chatcode.dev" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.staging.chatcode.dev");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("allows staging Pages previews by hostname suffix", () => {
    const env = makeEnv({
      APP_ENV: "staging",
      STAGING_PAGES_PREVIEW_SUFFIX: ".chatcode-app-staging.pages.dev",
    });
    const request = new Request("https://cp.staging.chatcode.dev/vps", {
      headers: { Origin: "https://frontend-claude.chatcode-app-staging.pages.dev" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://frontend-claude.chatcode-app-staging.pages.dev",
    );
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("rejects disallowed origins", () => {
    const env = makeEnv({ APP_ENV: "staging" });
    const request = new Request("https://cp.staging.chatcode.dev/vps", {
      headers: { Origin: "https://evil.example.com" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("allows localhost in dev", () => {
    const env = makeEnv({ APP_ENV: "dev" });
    const request = new Request("https://cp.staging.chatcode.dev/auth/me", {
      headers: { Origin: "http://localhost:5173" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("allows origins from explicit CORS_ALLOWED_ORIGINS list", () => {
    const env = makeEnv({
      APP_ENV: "staging",
      CORS_ALLOWED_ORIGINS: "https://one.example.com, https://two.example.com",
    });
    const request = new Request("https://cp.staging.chatcode.dev/auth/me", {
      headers: { Origin: "https://two.example.com" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://two.example.com");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("advertises PATCH in allowed methods", () => {
    const env = makeEnv({ APP_ENV: "staging" });
    const request = new Request("https://cp.staging.chatcode.dev/vps/vps-1", {
      headers: { Origin: "https://app.staging.chatcode.dev" },
    });
    const headers = corsHeaders(request, env);
    expect(headers["Access-Control-Allow-Methods"]).toContain("PATCH");
  });
});

describe("withCORS", () => {
  it("preserves body/status and appends CORS headers", async () => {
    const env = makeEnv({ APP_ENV: "dev" });
    const req = new Request("https://cp.dev.test/auth/me", {
      headers: { Origin: "http://localhost:5173" },
    });
    const res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const wrapped = withCORS(res, req, env);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    await expect(wrapped.json()).resolves.toEqual({ ok: true });
  });
});
