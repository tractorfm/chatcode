import { apiUrl } from "./constants";
import type { UserPreferences } from "./preferences";

async function parseResponseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) {
    return undefined;
  }
  const text = await res.text();
  if (!text) {
    return undefined;
  }
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as unknown;
  }
  return text;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await parseResponseBody(res).catch(() => undefined);
  if (!res.ok) {
    const errorBody =
      body && typeof body === "object" ? body : { error: res.statusText };
    throw Object.assign(new Error((errorBody as { error?: string }).error ?? res.statusText), {
      status: res.status,
      body: errorBody,
    });
  }
  return body as T;
}

// -- Auth --

export interface User {
  user_id: string;
  email?: string;
  providers?: string[];
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

export function unlinkProvider(provider: "google" | "github") {
  return request<{ ok: boolean; providers: string[] }>(`/auth/${provider}/disconnect`, {
    method: "POST",
  });
}

export function getUserSettings() {
  return request<{ preferences: UserPreferences }>("/me/settings");
}

export function updateUserSettings(opts: Partial<UserPreferences>) {
  return request<{ preferences: UserPreferences }>("/me/settings", {
    method: "PATCH",
    body: JSON.stringify(opts),
  });
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
  gateway_os?: string | null;
}

export function listVPS() {
  return request<{ vps: VPS[] }>("/vps");
}

export function getVPS(id: string) {
  return request<VPS>(`/vps/${encodeURIComponent(id)}`);
}

export function listWorkspaceFolders(vpsId: string) {
  return request<{ folders: string[] }>(`/vps/${encodeURIComponent(vpsId)}/workspace-folders`);
}

export function updateVPS(id: string, opts: { label: string }) {
  return request<VPS>(`/vps/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(opts),
  });
}

export interface CreateVPSResponse {
  status: "provisioning";
  vps: VPS;
}

export interface DODropletRegionOption {
  slug: string;
  city: string;
  label: string;
  available: boolean;
}

export interface DODropletRegionColumn {
  id: "americas" | "europe" | "asia_pacific";
  label: string;
  options: DODropletRegionOption[];
}

export interface DODropletSizeOption {
  slug: string;
  label: string;
  specs: string;
  price_monthly: number;
  regions: string[];
}

export interface DODropletImageOption {
  slug: string;
  family: "ubuntu" | "debian";
  label: string;
}

export interface DODropletOptions {
  live: boolean;
  regions: DODropletRegionColumn[];
  plans: {
    regular: DODropletSizeOption[];
    premium_intel: DODropletSizeOption[];
  };
  images: DODropletImageOption[];
  defaults: {
    region: string;
    plan_family: "regular" | "premium_intel";
    size: string;
    image: string;
  };
}

export function getDODropletOptions() {
  return request<DODropletOptions>("/vps/options");
}

export function createVPS(opts: {
  region?: string;
  size?: string;
  image?: string;
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

export function regenerateManualVPSCommand(id: string) {
  return request<ManualVPSResponse>(`/vps/${encodeURIComponent(id)}/manual-command`, {
    method: "POST",
  });
}

export function deleteVPS(id: string) {
  return request<void>(`/vps/${encodeURIComponent(id)}`, {
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

export interface CreateSessionOptions {
  title?: string;
  agent_type?: string;
  workdir?: string;
}

export function listSessions(vpsId: string) {
  return request<{ sessions: Session[] }>(
    `/vps/${encodeURIComponent(vpsId)}/sessions`,
  );
}

export function createSession(
  vpsId: string,
  opts: CreateSessionOptions,
) {
  return request<{ session_id: string; status: string }>(
    `/vps/${encodeURIComponent(vpsId)}/sessions`,
    { method: "POST", body: JSON.stringify(opts) },
  );
}

export function deleteSession(vpsId: string, sessionId: string) {
  return request<void>(
    `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function updateSession(vpsId: string, sessionId: string, opts: { title: string }) {
  return request<Session>(
    `/vps/${encodeURIComponent(vpsId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify(opts) },
  );
}

// -- Agents --

export interface AgentStatusEntry {
  agent: string;
  binary: string;
  installed: boolean;
  version?: string;
}

export type ManagedAgentType = "claude-code" | "codex" | "gemini" | "opencode";

export function listAgents(vpsId: string) {
  return request<{ agents: AgentStatusEntry[] }>(
    `/vps/${encodeURIComponent(vpsId)}/agents`,
  );
}

export function installAgent(vpsId: string, agent: ManagedAgentType) {
  return request<{ ok: boolean; status: string; request_id: string; agent: ManagedAgentType }>(
    `/vps/${encodeURIComponent(vpsId)}/agents/install`,
    {
      method: "POST",
      body: JSON.stringify({ agent }),
    },
  );
}

export function isManagedAgentType(value: string): value is ManagedAgentType {
  return value === "claude-code" || value === "codex" || value === "gemini" || value === "opencode";
}

export function getMissingAgentFromError(err: unknown): ManagedAgentType | null {
  if (!(err instanceof Error)) return null;
  const body = (err as Error & { body?: unknown }).body;
  if (body && typeof body === "object") {
    const code = (body as { code?: unknown }).code;
    const agent = (body as { agent?: unknown }).agent;
    if (code === "agent_not_installed" && typeof agent === "string" && isManagedAgentType(agent)) {
      return agent;
    }
  }

  const match = err.message.match(/^([a-z-]+) is not installed\. Run agents\.install first\.$/);
  if (!match) return null;
  return isManagedAgentType(match[1]) ? match[1] : null;
}

export async function waitForAgentInstalled(
  vpsId: string,
  agent: ManagedAgentType,
  opts?: { timeoutMs?: number; intervalMs?: number },
) {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { agents } = await listAgents(vpsId);
    const target = agents.find((entry) => entry.agent === agent);
    if (target?.installed) return target;
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }

  throw new Error(`${agent} installation timed out. Try again in a moment.`);
}

export async function installAgentAndCreateSession(
  vpsId: string,
  agent: ManagedAgentType,
  opts: CreateSessionOptions,
) {
  await installAgent(vpsId, agent);
  await waitForAgentInstalled(vpsId, agent);
  return createSession(vpsId, opts);
}

// -- DO Connection --

export function getOAuthURL(provider: "google" | "github" | "do") {
  return apiUrl(`/auth/${provider === "do" ? "do" : provider}/start`);
}

export function disconnectDO() {
  return request<{ ok: boolean }>("/auth/do/disconnect", { method: "POST" });
}
