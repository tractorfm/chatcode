import { apiUrl } from "./constants";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? res.statusText), {
      status: res.status,
      body,
    });
  }
  return res.json() as Promise<T>;
}

// -- Auth --

export interface User {
  user_id: string;
  email?: string;
}

export function getMe() {
  return request<User>("/auth/me");
}

export function startEmailLogin(email: string) {
  return request<{ ok: boolean }>("/auth/email/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

// -- VPS --

export interface VPS {
  id: string;
  user_id: string;
  provider?: "digitalocean" | "manual";
  label?: string;
  droplet_id?: number;
  region?: string;
  size?: string;
  ipv4?: string | null;
  status: string;
  created_at: number;
  updated_at?: number;
  gateway_id?: string;
  gateway_connected?: boolean;
  gateway_version?: string | null;
}

export function listVPS() {
  return request<{ vps: VPS[] }>("/vps");
}

export function getVPS(id: string) {
  return request<VPS>(`/vps/${encodeURIComponent(id)}`);
}

export interface CreateVPSResponse {
  status: "provisioning";
  vps: VPS;
}

export function createVPS(opts: {
  region?: string;
  size?: string;
  label?: string;
}) {
  return request<CreateVPSResponse>("/vps", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export interface ManualVPSResponse {
  gateway_id: string;
  gateway_auth_token: string;
  cp_url: string;
  install: {
    linux: string;
    macos: string;
  };
  vps: VPS;
}

export function createManualVPS(opts?: { label?: string }) {
  return request<ManualVPSResponse>("/vps/manual", {
    method: "POST",
    body: JSON.stringify(opts ?? {}),
  });
}

export function deleteVPS(id: string) {
  return request<{ ok: boolean }>(`/vps/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function powerOffVPS(id: string) {
  return request<{ ok: boolean }>(
    `/vps/${encodeURIComponent(id)}/power-off`,
    { method: "POST" },
  );
}

export function powerOnVPS(id: string) {
  return request<{ ok: boolean }>(
    `/vps/${encodeURIComponent(id)}/power-on`,
    { method: "POST" },
  );
}

// -- Sessions --

export interface Session {
  id: string;
  user_id: string;
  vps_id: string;
  title: string;
  agent_type: string;
  workdir: string;
  status: string;
  created_at: number;
  last_activity_at?: number;
}

export function listSessions(vpsId: string) {
  return request<{ sessions: Session[] }>(
    `/vps/${encodeURIComponent(vpsId)}/sessions`,
  );
}

export function createSession(
  vpsId: string,
  opts: { title?: string; agent_type?: string; workdir?: string },
) {
  return request<{ session_id: string; status: string }>(
    `/vps/${encodeURIComponent(vpsId)}/sessions`,
    { method: "POST", body: JSON.stringify(opts) },
  );
}

export function deleteSession(vpsId: string, sessionId: string) {
  return request<{ ok: boolean }>(
    `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

// -- Agents --

export interface AgentStatusEntry {
  agent: string;
  binary: string;
  installed: boolean;
  version?: string;
}

export function listAgents(vpsId: string) {
  return request<{ agents: AgentStatusEntry[] }>(
    `/vps/${encodeURIComponent(vpsId)}/agents`,
  );
}

// -- DO Connection --

export function getOAuthURL(provider: "google" | "github" | "do") {
  return apiUrl(`/auth/${provider === "do" ? "do" : provider}/start`);
}

export function disconnectDO() {
  return request<{ ok: boolean }>("/auth/do/disconnect", { method: "POST" });
}
