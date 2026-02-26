/** Cloudflare Worker environment bindings. */
export interface Env {
  // D1
  DB: D1Database;

  // KV
  KV: KVNamespace;

  // Durable Objects
  GATEWAY_HUB: DurableObjectNamespace;

  // Vars
  DO_CLIENT_ID: string;
  GATEWAY_VERSION?: string;
  GATEWAY_RELEASE_BASE_URL?: string;
  AUTH_MODE?: string; // "dev" for local dev only

  // Secrets (set via `wrangler secret put`)
  DO_CLIENT_SECRET: string;
  JWT_SECRET: string;
  GATEWAY_TOKEN_SALT: string;
  DO_TOKEN_KEK: string; // base64-encoded AES-256 key
}

/** Authenticated request context passed to route handlers. */
export interface AuthContext {
  userId: string;
}

/** Standard JSON error response body. */
export interface ErrorResponse {
  error: string;
}
