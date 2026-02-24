import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleDOConnect,
  handleDOCallback,
  handleDODisconnect,
} from "../src/routes/auth";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(async () => {}),
  getUser: vi.fn(async () => null),
  upsertDOConnection: vi.fn(async () => {}),
  deleteDOConnection: vi.fn(async () => {}),
  importKEK: vi.fn(async () => ({} as CryptoKey)),
  encryptToken: vi.fn(async (token: string) => `enc:${token}`),
  signSessionCookie: vi.fn(async () => "signed-session-token"),
  sessionCookieHeader: vi.fn(
    () => "session=signed-session-token; HttpOnly; Secure; Path=/",
  ),
  exchangeOAuthCode: vi.fn(),
  newUserId: vi.fn(() => "usr-test-1"),
  randomHex: vi.fn(() => "state-nonce-1"),
}));

vi.mock("../src/db/schema.js", () => ({
  createUser: mocks.createUser,
  getUser: mocks.getUser,
  upsertDOConnection: mocks.upsertDOConnection,
  deleteDOConnection: mocks.deleteDOConnection,
}));

vi.mock("../src/lib/do-tokens.js", () => ({
  importKEK: mocks.importKEK,
  encryptToken: mocks.encryptToken,
}));

vi.mock("../src/lib/auth.js", () => ({
  signSessionCookie: mocks.signSessionCookie,
  sessionCookieHeader: mocks.sessionCookieHeader,
}));

vi.mock("../src/lib/do-api.js", () => ({
  exchangeOAuthCode: mocks.exchangeOAuthCode,
}));

vi.mock("../src/lib/ids.js", () => ({
  newUserId: mocks.newUserId,
  randomHex: mocks.randomHex,
}));

function makeEnv() {
  const kv = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => "1"),
    delete: vi.fn(async () => {}),
  };

  const emailIdentityQuery = {
    bind: vi.fn(() => ({
      first: vi.fn(async () => ({ user_id: "usr-existing" })),
      run: vi.fn(async () => ({})),
    })),
  };
  const insertIdentityQuery = {
    bind: vi.fn(() => ({
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({})),
    })),
  };

  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT user_id FROM email_identities")) {
        return emailIdentityQuery;
      }
      return insertIdentityQuery;
    }),
  };

  const env = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    DO_CLIENT_ID: "do-client-id",
    DO_CLIENT_SECRET: "do-client-secret",
    DO_TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    JWT_SECRET: "jwt-secret",
    GATEWAY_TOKEN_SALT: "gateway-token-salt",
  };

  return { env, kv };
}

describe("routes/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates OAuth state and redirects on /auth/do", async () => {
    const { env, kv } = makeEnv();
    const req = new Request("https://cp.example.test/auth/do");

    const res = await handleDOConnect(req, env);

    expect(res.status).toBe(302);
    expect(kv.put).toHaveBeenCalledWith("oauth:state:state-nonce-1", "1", {
      expirationTtl: 600,
    });
    expect(res.headers.get("Location")).toContain("cloud.digitalocean.com/v1/oauth/authorize");
    expect(res.headers.get("Location")).toContain("state=state-nonce-1");
  });

  it("returns 400 on callback when code/state is missing", async () => {
    const { env } = makeEnv();

    const res = await handleDOCallback(
      new Request("https://cp.example.test/auth/do/callback"),
      env,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "missing code or state",
    });
  });

  it("stores encrypted tokens and sets session cookie on successful callback", async () => {
    const { env, kv } = makeEnv();

    mocks.exchangeOAuthCode.mockResolvedValue({
      access_token: "access-abc",
      refresh_token: "refresh-xyz",
      expires_in: 3600,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            account: {
              uuid: "do-account-1",
              email: "user@example.test",
              team: { uuid: "team-123" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const res = await handleDOCallback(
      new Request(
        "https://cp.example.test/auth/do/callback?code=code-1&state=state-nonce-1",
      ),
      env,
    );

    expect(res.status).toBe(302);
    expect(kv.delete).toHaveBeenCalledWith("oauth:state:state-nonce-1");
    expect(mocks.upsertDOConnection).toHaveBeenCalledOnce();
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("session=signed-session-token");
  });

  it("deletes stored DO connection on disconnect", async () => {
    const { env } = makeEnv();

    const res = await handleDODisconnect(
      new Request("https://cp.example.test/auth/do/disconnect", { method: "POST" }),
      env,
      { userId: "usr-1" },
    );

    expect(res.status).toBe(200);
    expect(mocks.deleteDOConnection).toHaveBeenCalledWith(env.DB, "usr-1");
  });
});
