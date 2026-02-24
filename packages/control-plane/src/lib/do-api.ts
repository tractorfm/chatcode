/**
 * DigitalOcean API client (typed).
 * Handles droplet CRUD, power actions, and token refresh.
 */

import { getDOConnection, upsertDOConnection } from "../db/schema.js";
import { importKEK, encryptToken, decryptToken } from "./do-tokens.js";

const DO_API = "https://api.digitalocean.com/v2";
const DO_TOKEN_URL = "https://cloud.digitalocean.com/v1/oauth/token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DODroplet {
  id: number;
  name: string;
  status: string;
  networks: {
    v4: Array<{ ip_address: string; type: string }>;
  };
  region: { slug: string };
  size_slug: string;
}

export interface CreateDropletParams {
  name: string;
  region: string;
  size: string;
  image: string;
  user_data: string;
  ssh_keys?: number[];
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/** Per-isolate in-memory lock for concurrent refresh dedup. */
const refreshInFlight = new Map<string, Promise<string>>();

/**
 * Get a valid DO access token for the user. Refreshes if expired.
 * Returns the decrypted access token.
 */
export async function getAccessToken(
  db: D1Database,
  userId: string,
  kekBase64: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const conn = await getDOConnection(db, userId);
  if (!conn) throw new Error("no DO connection");

  const kek = await importKEK(kekBase64);
  const now = Math.floor(Date.now() / 1000);

  // If not expired, decrypt and return
  if (conn.expires_at > now + 60) {
    return decryptToken(conn.access_token_enc, kek);
  }

  // Need refresh – dedup concurrent refreshes in this isolate
  const existing = refreshInFlight.get(userId);
  if (existing) return existing;

  const refreshPromise = (async () => {
    try {
      const refreshToken = await decryptToken(conn.refresh_token_enc, kek);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const resp = await fetch(DO_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DO token refresh failed: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      const newAccessEnc = await encryptToken(data.access_token, kek);
      const newRefreshEnc = await encryptToken(data.refresh_token, kek);

      await upsertDOConnection(db, {
        user_id: userId,
        access_token_enc: newAccessEnc,
        refresh_token_enc: newRefreshEnc,
        token_key_version: conn.token_key_version,
        team_uuid: conn.team_uuid,
        expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      });

      return data.access_token;
    } finally {
      refreshInFlight.delete(userId);
    }
  })();

  refreshInFlight.set(userId, refreshPromise);
  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Droplet API
// ---------------------------------------------------------------------------

async function doFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${DO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export async function createDroplet(
  token: string,
  params: CreateDropletParams,
): Promise<DODroplet> {
  const resp = await doFetch("/droplets", token, {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DO create droplet failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { droplet: DODroplet };
  return data.droplet;
}

export async function getDroplet(
  token: string,
  dropletId: number,
): Promise<DODroplet | null> {
  const resp = await doFetch(`/droplets/${dropletId}`, token);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DO get droplet failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { droplet: DODroplet };
  return data.droplet;
}

export async function deleteDroplet(
  token: string,
  dropletId: number,
): Promise<void> {
  const resp = await doFetch(`/droplets/${dropletId}`, token, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(`DO delete droplet failed: ${resp.status} ${text}`);
  }
}

export async function powerOffDroplet(
  token: string,
  dropletId: number,
): Promise<void> {
  const resp = await doFetch(`/droplets/${dropletId}/actions`, token, {
    method: "POST",
    body: JSON.stringify({ type: "power_off" }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DO power off failed: ${resp.status} ${text}`);
  }
}

export async function powerOnDroplet(
  token: string,
  dropletId: number,
): Promise<void> {
  const resp = await doFetch(`/droplets/${dropletId}/actions`, token, {
    method: "POST",
    body: JSON.stringify({ type: "power_on" }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DO power on failed: ${resp.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth exchange
// ---------------------------------------------------------------------------

export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(DO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DO OAuth exchange failed: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>;
}
