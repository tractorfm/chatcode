import type { Env } from "../types.js";

const DEFAULT_APP_ORIGIN = "https://app.chatcode.dev";
const DEFAULT_STAGING_APP_ORIGIN = "https://app.staging.chatcode.dev";
const DEFAULT_STAGING_PAGES_PREVIEW_SUFFIX = ".chatcode-app-staging.pages.dev";

/**
 * Resolve where OAuth/email auth callbacks should land after session cookie issuance.
 */
export function postAuthRedirect(request: Request, env: Env): string {
  const override = env.POST_AUTH_REDIRECT_URL?.trim();
  if (override) return override;

  if (env.APP_ENV === "prod") {
    return env.APP_ORIGIN?.trim() || DEFAULT_APP_ORIGIN;
  }
  if (env.APP_ENV === "staging") {
    return env.STAGING_APP_ORIGIN?.trim() || DEFAULT_STAGING_APP_ORIGIN;
  }

  // Keep staging test page for local/dev workflow.
  return "/staging/test";
}

export function withCORS(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dev-User, X-Dev-Secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  const origin = request.headers.get("Origin");
  if (!origin) return headers;

  if (!isAllowedOrigin(origin, request, env)) {
    return headers;
  }

  headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
}

function isAllowedOrigin(origin: string, request: Request, env: Env): boolean {
  let originURL: URL;
  let requestURL: URL;
  try {
    originURL = new URL(origin);
    requestURL = new URL(request.url);
  } catch {
    return false;
  }

  // Always allow same-origin requests.
  if (originURL.origin === requestURL.origin) return true;

  // Local dev convenience.
  if (
    env.APP_ENV === "dev" &&
    (originURL.hostname === "localhost" || originURL.hostname === "127.0.0.1")
  ) {
    return true;
  }

  const originAllowlist = configuredOrigins(env);
  if (originAllowlist.has(originURL.origin)) return true;

  // Allow Cloudflare Pages preview subdomains in staging.
  if (env.APP_ENV === "staging" && originURL.protocol === "https:") {
    const previewSuffixRaw =
      env.STAGING_PAGES_PREVIEW_SUFFIX?.trim() || DEFAULT_STAGING_PAGES_PREVIEW_SUFFIX;
    const previewSuffix = previewSuffixRaw.replace(/^\./, "");
    if (
      previewSuffix &&
      (originURL.hostname === previewSuffix ||
        originURL.hostname.endsWith(`.${previewSuffix}`))
    ) {
      return true;
    }
  }

  return false;
}

function configuredOrigins(env: Env): Set<string> {
  const values = new Set<string>();

  if (env.APP_ENV === "prod") {
    values.add(env.APP_ORIGIN?.trim() || DEFAULT_APP_ORIGIN);
  } else if (env.APP_ENV === "staging") {
    values.add(env.STAGING_APP_ORIGIN?.trim() || DEFAULT_STAGING_APP_ORIGIN);
  }

  const extra = env.CORS_ALLOWED_ORIGINS?.split(",") ?? [];
  for (const raw of extra) {
    const value = raw.trim();
    if (!value) continue;
    values.add(value);
  }

  return values;
}

