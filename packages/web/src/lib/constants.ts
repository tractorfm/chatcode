/** Base URL for the control plane API. */
export const CP_URL = resolveCPURL();

function resolveCPURL(): string {
  const explicit = (import.meta.env.VITE_CP_URL ?? "").trim();
  if (explicit) return explicit;
  if (typeof window === "undefined") return "";

  const host = window.location.hostname;
  if (host === "app.chatcode.dev") return "https://cp.chatcode.dev";
  if (host === "app.staging.chatcode.dev") return "https://cp.staging.chatcode.dev";
  if (host.endsWith(".chatcode-app-staging.pages.dev")) {
    return "https://cp.staging.chatcode.dev";
  }
  if (host.startsWith("app.preview-") && host.endsWith(".chatcode.dev")) {
    return "https://cp.staging.chatcode.dev";
  }
  if (host.startsWith("app.") && host.includes(".")) {
    return `https://cp.${host.slice(4)}`;
  }
  return "";
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Build a full API URL. In dev mode, requests are proxied via Vite. */
export function apiUrl(path: string): string {
  const normalized = normalizePath(path);
  if (CP_URL) return new URL(normalized, CP_URL).toString();
  if (!isLocalDevHost(location.hostname)) {
    throw new Error(
      `Control plane URL is not configured for host ${location.hostname}. Set VITE_CP_URL.`,
    );
  }
  return `/api${normalized}`;
}

/** Build a WebSocket URL from an API path. */
export function wsUrl(path: string): string {
  const normalized = normalizePath(path);
  if (CP_URL) {
    const url = new URL(normalized, CP_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  if (!isLocalDevHost(location.hostname)) {
    throw new Error(
      `Control plane URL is not configured for host ${location.hostname}. Set VITE_CP_URL.`,
    );
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api${normalized}`;
}

function isLocalDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Generate a request ID for protocol messages. */
let reqCounter = 0;
export function requestId(prefix = "r"): string {
  return `${prefix}-${Date.now()}-${++reqCounter}`;
}

/** Encode a UTF-8 string to base64. */
export function utf8ToBase64(str: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(str), (b) =>
      String.fromCharCode(b),
    ).join(""),
  );
}

export const AGENT_TYPES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex CLI" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "opencode", label: "OpenCode" },
  { value: "none", label: "Plain shell" },
] as const;

export type AgentType = (typeof AGENT_TYPES)[number]["value"];


export function agentLabel(agentType: string): string {
  const match = AGENT_TYPES.find((entry) => entry.value === agentType);
  if (match) return match.label;
  if (agentType === "none") return "Shell";
  return agentType || "Session";
}

export function defaultSessionTitle(agentType: string, ordinal: number): string {
  const base = agentType === "none" ? "Shell" : agentLabel(agentType);
  return `${base} ${Math.max(1, ordinal)}`;
}
