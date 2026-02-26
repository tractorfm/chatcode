/**
 * Request authentication:
 * - Session cookie sign/verify (HMAC-SHA256) for browser requests
 * - Gateway HMAC token verification (timing-safe)
 * - AUTH_MODE=dev passthrough via X-Dev-User header
 */

import type { Env, AuthContext } from "../types.js";

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Session cookie (browser auth)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

interface SessionPayload {
  userId: string;
  expires: number; // Unix seconds
}

/** Sign a session cookie value: base64(JSON payload) + "." + base64(HMAC). */
export async function signSessionCookie(
  userId: string,
  jwtSecret: string,
): Promise<string> {
  const payload: SessionPayload = {
    userId,
    expires: Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE,
  };
  const payloadB64 = btoa(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, jwtSecret);
  return `${payloadB64}.${sig}`;
}

/** Verify and decode a session cookie value. Returns userId or null. */
export async function verifySessionCookie(
  cookie: string,
  jwtSecret: string,
): Promise<string | null> {
  const dotIdx = cookie.indexOf(".");
  if (dotIdx === -1) return null;

  const payloadB64 = cookie.slice(0, dotIdx);
  const sig = cookie.slice(dotIdx + 1);

  const expectedSig = await hmacSign(payloadB64, jwtSecret);
  if (!timingSafeEqual(sig, expectedSig)) return null;

  try {
    const payload: SessionPayload = JSON.parse(atob(payloadB64));
    if (payload.expires < Math.floor(Date.now() / 1000)) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

/** Build Set-Cookie header value. */
export function sessionCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

/** Build Set-Cookie header to clear the session cookie. */
export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Parse session cookie from Cookie header. */
function parseSessionCookie(cookieHeader: string): string | null {
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? match.slice(COOKIE_NAME.length + 1) : null;
}

/** Normalize user email for stable account identity matching. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Request auth middleware
// ---------------------------------------------------------------------------

/** Authenticate a request. Returns AuthContext or a 401 Response. */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  // Dev mode: accept X-Dev-User header
  if (env.AUTH_MODE === "dev") {
    const devUser = request.headers.get("X-Dev-User");
    if (devUser) {
      return { userId: devUser };
    }
  }

  // Production: validate session cookie
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = parseSessionCookie(cookieHeader);
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = await verifySessionCookie(token, env.JWT_SECRET);
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { userId };
}

// ---------------------------------------------------------------------------
// Gateway HMAC token verification
// ---------------------------------------------------------------------------

/** Hash a gateway auth token with HMAC-SHA256. */
export async function hashGatewayToken(
  token: string,
  salt: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return bytesToHex(new Uint8Array(sig));
}

/** Verify a gateway auth token against stored hash (timing-safe). */
export async function verifyGatewayToken(
  token: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const candidateHash = await hashGatewayToken(token, salt);
  return timingSafeEqual(candidateHash, storedHash);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}
