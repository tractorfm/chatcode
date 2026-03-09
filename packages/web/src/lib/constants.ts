/** Base URL for the control plane API. */
export const CP_URL = import.meta.env.VITE_CP_URL ?? "";

/** Build a full API URL. In dev mode, requests are proxied via Vite. */
export function apiUrl(path: string): string {
  if (CP_URL) return CP_URL + path;
  return "/api" + path;
}

/** Build a WebSocket URL from an API path. */
export function wsUrl(path: string): string {
  if (CP_URL) {
    return CP_URL.replace(/^http/, "ws") + path;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/api" + path;
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
