/**
 * DO OAuth routes: connect, callback, disconnect.
 */

import type { Env, AuthContext } from "../types.js";
import { createUser, getUser, upsertDOConnection, deleteDOConnection } from "../db/schema.js";
import { importKEK, encryptToken } from "../lib/do-tokens.js";
import { signSessionCookie, sessionCookieHeader } from "../lib/auth.js";
import { exchangeOAuthCode } from "../lib/do-api.js";
import { newUserId, randomHex } from "../lib/ids.js";

const DO_AUTHORIZE_URL = "https://cloud.digitalocean.com/v1/oauth/authorize";

/**
 * GET /auth/do – Redirect to DigitalOcean OAuth authorize URL.
 */
export async function handleDOConnect(
  request: Request,
  env: Env,
): Promise<Response> {
  const state = randomHex(16);
  await env.KV.put(`oauth:state:${state}`, "1", { expirationTtl: 600 });

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
 * GET /auth/do/callback – Exchange code, encrypt + store tokens, set session cookie.
 */
export async function handleDOCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(JSON.stringify({ error: "missing code or state" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate state nonce
  const storedState = await env.KV.get(`oauth:state:${state}`);
  if (!storedState) {
    return new Response(JSON.stringify({ error: "invalid or expired state" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  await env.KV.delete(`oauth:state:${state}`);

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

  // Create or get user
  // For MVP, use a deterministic user ID from the DO account info
  // We'll get the account info to find the user
  const accountResp = await fetch("https://api.digitalocean.com/v2/account", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!accountResp.ok) {
    return new Response(JSON.stringify({ error: "failed to get DO account" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const accountData = (await accountResp.json()) as {
    account: { uuid: string; email: string; team?: { uuid: string } };
  };

  // Look up existing user by email or create new one
  const email = accountData.account.email;
  const existingIdentity = await env.DB
    .prepare("SELECT user_id FROM email_identities WHERE email = ?")
    .bind(email)
    .first<{ user_id: string }>();

  let userId: string;
  if (existingIdentity) {
    userId = existingIdentity.user_id;
  } else {
    userId = newUserId();
    await createUser(env.DB, userId);
    await env.DB
      .prepare(
        "INSERT INTO email_identities (user_id, email, verified_at) VALUES (?, ?, ?)",
      )
      .bind(userId, email, Math.floor(Date.now() / 1000))
      .run();
  }

  // Store encrypted tokens
  await upsertDOConnection(env.DB, {
    user_id: userId,
    access_token_enc: accessTokenEnc,
    refresh_token_enc: refreshTokenEnc,
    token_key_version: 1,
    team_uuid: accountData.account.team?.uuid ?? null,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
  });

  // Issue session cookie
  const sessionToken = await signSessionCookie(userId, env.JWT_SECRET);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": sessionCookieHeader(sessionToken),
    },
  });
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
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
