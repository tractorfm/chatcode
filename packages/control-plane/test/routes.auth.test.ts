import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleDOConnect,
  handleDOCallback,
  handleDODisconnect,
  handleLogout,
  handleEmailStart,
  handleAuthMe,
} from "../src/routes/auth";

const mocks = vi.hoisted(() => ({
  deleteDOConnection: vi.fn(async () => {}),
  listAuthIdentitiesByUser: vi.fn(async () => []),
  upsertDOConnection: vi.fn(async () => {}),
  getPrimaryEmailForUser: vi.fn(async () => "user@example.test"),
  importKEK: vi.fn(async () => ({} as CryptoKey)),
  encryptToken: vi.fn(async (token: string) => `enc:${token}`),
  exchangeOAuthCode: vi.fn(),
  resolveOrCreateUserByIdentity: vi.fn(),
  randomHex: vi.fn(() => "state-nonce-1"),
  sendMagicLinkEmail: vi.fn(async () => {}),
}));

vi.mock("../src/db/schema.js", () => ({
  deleteDOConnection: mocks.deleteDOConnection,
  listAuthIdentitiesByUser: mocks.listAuthIdentitiesByUser,
  upsertDOConnection: mocks.upsertDOConnection,
  getPrimaryEmailForUser: mocks.getPrimaryEmailForUser,
}));

vi.mock("../src/lib/do-tokens.js", () => ({
  importKEK: mocks.importKEK,
  encryptToken: mocks.encryptToken,
}));

vi.mock("../src/lib/do-api.js", () => ({
  exchangeOAuthCode: mocks.exchangeOAuthCode,
}));

vi.mock("../src/lib/identity.js", () => ({
  resolveOrCreateUserByIdentity: mocks.resolveOrCreateUserByIdentity,
  IdentityConflictError: class IdentityConflictError extends Error {},
  InvalidEmailError: class InvalidEmailError extends Error {},
}));

vi.mock("../src/lib/ids.js", () => ({
  randomHex: mocks.randomHex,
}));

vi.mock("../src/lib/ses.js", () => ({
  sendMagicLinkEmail: mocks.sendMagicLinkEmail,
}));

function makeEnv() {
  const kv = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => "usr-test-1"),
    delete: vi.fn(async () => {}),
  };

  const env = {
    DB: {} as D1Database,
    KV: kv as unknown as KVNamespace,
    DO_CLIENT_ID: "do-client-id",
    DO_CLIENT_SECRET: "do-client-secret",
    DO_TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    JWT_SECRET: "jwt-secret",
    GATEWAY_TOKEN_SALT: "gateway-token-salt",
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "us-east-1",
    SES_FROM_ADDRESS: "noreply@staging.chatcode.dev",
  };

  return { env, kv };
}

describe("routes/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOrCreateUserByIdentity.mockResolvedValue({
      userId: "usr-test-1",
      email: "user@example.test",
      created: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores auth user in state and redirects on /auth/do", async () => {
    const { env, kv } = makeEnv();
    const req = new Request("https://cp.example.test/auth/do");

    const res = await handleDOConnect(req, env, { userId: "usr-test-1" });

    expect(res.status).toBe(302);
    expect(kv.put).toHaveBeenCalledWith("oauth:state:do:state-nonce-1", "usr-test-1", {
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

  it("stores encrypted tokens on successful DO callback", async () => {
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
    expect(kv.delete).toHaveBeenCalledWith("oauth:state:do:state-nonce-1");
    expect(mocks.resolveOrCreateUserByIdentity).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        provider: "digitalocean",
        providerUserId: "do-account-1",
        expectedUserId: "usr-test-1",
      }),
    );
    expect(mocks.upsertDOConnection).toHaveBeenCalledOnce();
    expect(res.headers.get("Location")).toBe("/staging/test");
    expect(res.headers.get("Set-Cookie")).toContain("session=");
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

  it("clears session cookie on logout", async () => {
    const res = await handleLogout(
      new Request("https://cp.example.test/auth/logout", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("starts email auth and sends magic link through SES", async () => {
    const { env, kv } = makeEnv();
    const req = new Request("https://cp.example.test/auth/email/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "User@Example.test" }),
    });

    const res = await handleEmailStart(req, env);
    expect(res.status).toBe(200);
    expect(kv.put).toHaveBeenCalledWith(
      "auth:email:token:state-nonce-1",
      "user@example.test",
      { expirationTtl: 600 },
    );
    expect(mocks.sendMagicLinkEmail).toHaveBeenCalledOnce();
  });

  it("returns current user identity summary on /auth/me", async () => {
    const { env } = makeEnv();
    mocks.listAuthIdentitiesByUser.mockResolvedValue([
      { provider: "email" },
      { provider: "github" },
      { provider: "github" },
    ]);

    const res = await handleAuthMe(
      new Request("https://cp.example.test/auth/me"),
      env,
      { userId: "usr-test-1" },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      user_id: "usr-test-1",
      email: "user@example.test",
      providers: ["email", "github"],
    });
  });
});
