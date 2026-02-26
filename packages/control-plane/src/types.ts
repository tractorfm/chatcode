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
  GOOGLE_CLIENT_ID?: string;
  GITHUB_CLIENT_ID?: string;
  APP_ENV?: "dev" | "staging" | "prod";
  DEFAULT_DROPLET_REGION?: string;
  DEFAULT_DROPLET_SIZE?: string;
  DEFAULT_DROPLET_IMAGE?: string;
  GATEWAY_VERSION?: string;
  GATEWAY_RELEASE_BASE_URL?: string;
  AUTH_MODE?: string; // "dev" for local dev only

  // Secrets (set via `wrangler secret put`)
  DO_CLIENT_SECRET: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_SECRET?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SES_REGION?: string;
  SES_FROM_ADDRESS?: string;
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
