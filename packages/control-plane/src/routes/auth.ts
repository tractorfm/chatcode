/**
 * Auth routes:
 * - email magic link
 * - Google OAuth
 * - GitHub OAuth
 * - DigitalOcean OAuth connect/disconnect (requires logged-in user for connect)
 * - current user + logout
 */

import type { Env, AuthContext } from "../types.js";
import {
  deleteDOConnection,
  listAuthIdentitiesByUser,
  upsertDOConnection,
  getPrimaryEmailForUser,
} from "../db/schema.js";
import { importKEK, encryptToken } from "../lib/do-tokens.js";
import {
  clearSessionCookieHeader,
  normalizeEmail,
  sessionCookieHeader,
  signSessionCookie,
} from "../lib/auth.js";
import { exchangeOAuthCode } from "../lib/do-api.js";
import { resolveOrCreateUserByIdentity, IdentityConflictError, InvalidEmailError } from "../lib/identity.js";
import { randomHex } from "../lib/ids.js";
import { sendMagicLinkEmail } from "../lib/ses.js";

const DO_AUTHORIZE_URL = "https://cloud.digitalocean.com/v1/oauth/authorize";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const OAUTH_STATE_TTL_SEC = 600;
const EMAIL_TOKEN_TTL_SEC = 600;
const DEFAULT_POST_AUTH_REDIRECT = "/staging/test";

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

interface GitHubUser {
  id?: number;
}

interface GitHubEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

/**
 * POST /auth/email/start
 */
export async function handleEmailStart(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body.email ?? "");
  if (!looksLikeEmail(email)) {
    return jsonResponse({ error: "invalid email" }, 400);
  }

  const sesCfg = getSESConfig(env);
  if (!sesCfg) {
    return jsonResponse({ error: "email delivery is not configured" }, 503);
  }

  const token = randomHex(24);
  await env.KV.put(`auth:email:token:${token}`, email, { expirationTtl: EMAIL_TOKEN_TTL_SEC });

  const verifyUrl = new URL("/auth/email/verify", request.url);
  verifyUrl.searchParams.set("token", token);

  try {
    await sendMagicLinkEmail(sesCfg, email, verifyUrl.toString());
  } catch (err) {
    console.error("failed to send magic link email", err);
    return jsonResponse({ error: "failed to send sign-in email" }, 502);
  }

  return jsonResponse({ ok: true });
}

/**
 * GET /auth/email/verify
 */
export async function handleEmailVerify(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return jsonResponse({ error: "missing token" }, 400);
  }

  const kvKey = `auth:email:token:${token}`;
  const email = await env.KV.get(kvKey);
  if (!email) {
    return jsonResponse({ error: "invalid or expired token" }, 400);
  }
  await env.KV.delete(kvKey);

  try {
    const identity = await resolveOrCreateUserByIdentity(env.DB, {
      provider: "email",
      providerUserId: email,
      email,
      emailVerified: true,
    });
    const sessionToken = await signSessionCookie(identity.userId, env.JWT_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: DEFAULT_POST_AUTH_REDIRECT,
        "Set-Cookie": sessionCookieHeader(sessionToken),
      },
    });
  } catch (err) {
    return mapIdentityError(err);
  }
}

/**
 * GET /auth/google/start
 */
export async function handleGoogleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) {
    return jsonResponse({ error: "google auth not configured" }, 503);
  }

  const state = randomHex(16);
  await env.KV.put(`oauth:state:google:${state}`, "1", { expirationTtl: OAUTH_STATE_TTL_SEC });

  const redirectUri = new URL("/auth/google/callback", request.url).toString();
  const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

/**
 * GET /auth/google/callback
 */
export async function handleGoogleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return jsonResponse({ error: "google auth not configured" }, 503);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return jsonResponse({ error: "missing code or state" }, 400);
  }

  const stateKey = `oauth:state:google:${state}`;
  const stored = await env.KV.get(stateKey);
  if (!stored) {
    return jsonResponse({ error: "invalid or expired state" }, 400);
  }
  await env.KV.delete(stateKey);

  const redirectUri = new URL("/auth/google/callback", request.url).toString();
  const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    console.error("google oauth exchange failed", tokenResp.status, text);
    return jsonResponse({ error: "google oauth exchange failed" }, 502);
  }
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    return jsonResponse({ error: "google oauth response missing access_token" }, 502);
  }

  const profileResp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileResp.ok) {
    const text = await profileResp.text();
    console.error("google userinfo failed", profileResp.status, text);
    return jsonResponse({ error: "google profile fetch failed" }, 502);
  }
  const profile = (await profileResp.json()) as GoogleUserInfo;

  if (!profile.sub || !profile.email) {
    return jsonResponse({ error: "google profile missing required fields" }, 400);
  }
  if (!profile.email_verified) {
    return jsonResponse({ error: "google email is not verified" }, 400);
  }

  try {
    const identity = await resolveOrCreateUserByIdentity(env.DB, {
      provider: "google",
      providerUserId: profile.sub,
      email: profile.email,
      emailVerified: true,
    });
    const sessionToken = await signSessionCookie(identity.userId, env.JWT_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: DEFAULT_POST_AUTH_REDIRECT,
        "Set-Cookie": sessionCookieHeader(sessionToken),
      },
    });
  } catch (err) {
    return mapIdentityError(err);
  }
}

/**
 * GET /auth/github/start
 */
export async function handleGitHubStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) {
    return jsonResponse({ error: "github auth not configured" }, 503);
  }

  const state = randomHex(16);
  await env.KV.put(`oauth:state:github:${state}`, "1", { expirationTtl: OAUTH_STATE_TTL_SEC });

  const redirectUri = new URL("/auth/github/callback", request.url).toString();
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "user:email");
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

/**
 * GET /auth/github/callback
 */
export async function handleGitHubCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return jsonResponse({ error: "github auth not configured" }, 503);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return jsonResponse({ error: "missing code or state" }, 400);
  }

  const stateKey = `oauth:state:github:${state}`;
  const stored = await env.KV.get(stateKey);
  if (!stored) {
    return jsonResponse({ error: "invalid or expired state" }, 400);
  }
  await env.KV.delete(stateKey);

  const redirectUri = new URL("/auth/github/callback", request.url).toString();
  const tokenResp = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "chatcode-control-plane",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      state,
    }),
  });
  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    console.error("github oauth exchange failed", tokenResp.status, text);
    return jsonResponse({ error: "github oauth exchange failed" }, 502);
  }
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    return jsonResponse({ error: "github oauth response missing access_token" }, 502);
  }

  const commonHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tokenData.access_token}`,
    "User-Agent": "chatcode-control-plane",
  };

  const userResp = await fetch(GITHUB_USER_URL, { headers: commonHeaders });
  if (!userResp.ok) {
    const text = await userResp.text();
    console.error("github user fetch failed", userResp.status, text);
    return jsonResponse({ error: "github user fetch failed" }, 502);
  }
  const ghUser = (await userResp.json()) as GitHubUser;
  if (!ghUser.id) {
    return jsonResponse({ error: "github user missing id" }, 400);
  }

  const emailResp = await fetch(GITHUB_EMAILS_URL, { headers: commonHeaders });
  if (!emailResp.ok) {
    const text = await emailResp.text();
    console.error("github email fetch failed", emailResp.status, text);
    return jsonResponse({ error: "github email fetch failed" }, 502);
  }
  const emails = (await emailResp.json()) as GitHubEmail[];
  const selected = pickGitHubVerifiedEmail(emails);
  if (!selected) {
    return jsonResponse({ error: "github account has no verified email" }, 400);
  }

  try {
    const identity = await resolveOrCreateUserByIdentity(env.DB, {
      provider: "github",
      providerUserId: String(ghUser.id),
      email: selected.email,
      emailVerified: true,
    });
    const sessionToken = await signSessionCookie(identity.userId, env.JWT_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: DEFAULT_POST_AUTH_REDIRECT,
        "Set-Cookie": sessionCookieHeader(sessionToken),
      },
    });
  } catch (err) {
    return mapIdentityError(err);
  }
}

/**
 * GET /auth/do – Redirect to DigitalOcean OAuth authorize URL.
 * Requires an authenticated user context (connect-account flow).
 */
export async function handleDOConnect(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const state = randomHex(16);
  await env.KV.put(`oauth:state:do:${state}`, auth.userId, { expirationTtl: OAUTH_STATE_TTL_SEC });

  const redirectUri = new URL("/auth/do/callback", request.url).toString();
  const authorizeUrl = new URL(DO_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.DO_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "read write");
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

/**
 * GET /auth/do/callback – Exchange code, encrypt + store tokens.
 */
export async function handleDOCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return jsonResponse({ error: "missing code or state" }, 400);
  }

  const stateKey = `oauth:state:do:${state}`;
  const expectedUserId = await env.KV.get(stateKey);
  if (!expectedUserId) {
    return jsonResponse({ error: "invalid or expired state" }, 400);
  }
  await env.KV.delete(stateKey);

  // Exchange code for tokens
  const redirectUri = new URL("/auth/do/callback", request.url).toString();
  const tokens = await exchangeOAuthCode(
    code,
    redirectUri,
    env.DO_CLIENT_ID,
    env.DO_CLIENT_SECRET,
  );

  // Encrypt tokens
  const kek = await importKEK(env.DO_TOKEN_KEK);
  const accessTokenEnc = await encryptToken(tokens.access_token, kek);
  const refreshTokenEnc = await encryptToken(tokens.refresh_token, kek);

  const accountResp = await fetch("https://api.digitalocean.com/v2/account", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!accountResp.ok) {
    return jsonResponse({ error: "failed to get DO account" }, 500);
  }
  const accountData = (await accountResp.json()) as {
    account: { uuid: string; email: string; team?: { uuid: string } };
  };

  try {
    const identity = await resolveOrCreateUserByIdentity(env.DB, {
      provider: "digitalocean",
      providerUserId: accountData.account.uuid,
      email: accountData.account.email,
      emailVerified: true,
      expectedUserId,
    });

    await upsertDOConnection(env.DB, {
      user_id: identity.userId,
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      token_key_version: 1,
      team_uuid: accountData.account.team?.uuid ?? null,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    });

    const sessionToken = await signSessionCookie(identity.userId, env.JWT_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: DEFAULT_POST_AUTH_REDIRECT,
        "Set-Cookie": sessionCookieHeader(sessionToken),
      },
    });
  } catch (err) {
    return mapIdentityError(err);
  }
}

/**
 * POST /auth/do/disconnect – Delete DO tokens from D1.
 */
export async function handleDODisconnect(
  _request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  await deleteDOConnection(env.DB, auth.userId);
  return jsonResponse({ ok: true });
}

/**
 * GET /auth/me
 */
export async function handleAuthMe(
  _request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const email = await getPrimaryEmailForUser(env.DB, auth.userId);
  const identities = await listAuthIdentitiesByUser(env.DB, auth.userId);
  const providers = Array.from(new Set(identities.map((row) => row.provider)));

  return jsonResponse({
    user_id: auth.userId,
    email,
    providers,
  });
}

/**
 * POST /auth/logout
 */
export async function handleLogout(_request: Request): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}

function mapIdentityError(err: unknown): Response {
  if (err instanceof IdentityConflictError) {
    return jsonResponse({ error: err.message }, 409);
  }
  if (err instanceof InvalidEmailError) {
    return jsonResponse({ error: err.message }, 400);
  }
  console.error("identity resolution error", err);
  return jsonResponse({ error: "identity resolution failed" }, 500);
}

function getSESConfig(env: Env): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fromAddress: string;
} | null {
  if (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY || !env.SES_REGION || !env.SES_FROM_ADDRESS) {
    return null;
  }
  return {
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region: env.SES_REGION,
    fromAddress: env.SES_FROM_ADDRESS,
  };
}

function looksLikeEmail(value: string): boolean {
  if (!value || value.length < 3 || value.length > 320) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  return value.slice(at + 1).includes(".");
}

function pickGitHubVerifiedEmail(emails: GitHubEmail[]): GitHubEmail | null {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  return (
    emails.find((e) => e.primary && e.verified && looksLikeEmail(normalizeEmail(e.email))) ??
    emails.find((e) => e.verified && looksLikeEmail(normalizeEmail(e.email))) ??
    null
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
