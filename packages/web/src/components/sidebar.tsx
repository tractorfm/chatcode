import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Server,
  Terminal,
  ChevronLeft,
  ChevronRight,
  Power,
  Trash2,
  Settings,
  Activity,
  Circle,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_TYPES, type AgentType } from "@/lib/constants";
import {
  listVPS,
  listSessions,
  createSession,
  deleteSession,
  deleteVPS,
  powerOffVPS,
  powerOnVPS,
  type VPS,
  type Session,
} from "@/lib/api";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  activeVpsId: string | null;
  activeSessionId: string | null;
  onSelectVps: (vpsId: string) => void;
  onSelectSession: (vpsId: string, sessionId: string) => void;
  onNewSession: (vpsId: string, sessionId: string) => void;
  onNavigate: (page: "settings" | "status" | "onboarding") => void;
  onLogout: () => void;
  userEmail?: string;
}

export function Sidebar({
  collapsed,
  onToggle,
  activeVpsId,
  activeSessionId,
  onSelectVps,
  onSelectSession,
  onNewSession,
  onNavigate,
  onLogout,
  userEmail,
}: SidebarProps) {
  const [vpsList, setVpsList] = useState<VPS[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const refreshVPS = useCallback(async () => {
    try {
      const { vps } = await listVPS();
      setVpsList(vps);
      if (vps.length > 0 && !activeVpsId) {
        onSelectVps(vps[0].id);
      }
    } catch {
      /* ignore */
    }
  }, [activeVpsId, onSelectVps]);

  const refreshSessions = useCallback(async () => {
    if (!activeVpsId) return;
    setLoading(true);
    try {
      const { sessions: s } = await listSessions(activeVpsId);
      const openSessions = s.filter((s) => !isClosedStatus(s.status));
      setSessions(openSessions);
      if (
        openSessions.length > 0 &&
        !openSessions.some((session) => session.id === activeSessionId)
      ) {
        onSelectSession(activeVpsId, openSessions[0].id);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, activeVpsId, onSelectSession]);

  useEffect(() => {
    refreshVPS();
  }, [refreshVPS]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const handleCreateSession = useCallback(
    async (agentType: AgentType = "claude-code") => {
      if (!activeVpsId || creating) return;
      setCreating(true);
      try {
        const res = await createSession(activeVpsId, {
          title: `Session ${sessions.length + 1}`,
          agent_type: agentType,
        });
        await refreshSessions();
        onNewSession(activeVpsId, res.session_id);
      } catch (err) {
        console.error("create session:", err);
      } finally {
        setCreating(false);
      }
    },
    [activeVpsId, creating, sessions.length, refreshSessions, onNewSession],
  );

  const handleEndSession = useCallback(
    async (sessionId: string) => {
      if (!activeVpsId) return;
      try {
        await deleteSession(activeVpsId, sessionId);
        await refreshSessions();
      } catch {
        /* ignore */
      }
    },
    [activeVpsId, refreshSessions],
  );

  const handlePowerAction = useCallback(
    async (action: "off" | "on") => {
      if (!activeVpsId) return;
      try {
        if (action === "off") await powerOffVPS(activeVpsId);
        else await powerOnVPS(activeVpsId);
        await refreshVPS();
      } catch {
        /* ignore */
      }
    },
    [activeVpsId, refreshVPS],
  );

  const handleDeleteVPS = useCallback(async () => {
    if (!activeVpsId) return;
    if (!confirm("Destroy this VPS? This cannot be undone.")) return;
    try {
      await deleteVPS(activeVpsId);
      await refreshVPS();
    } catch {
      /* ignore */
    }
  }, [activeVpsId, refreshVPS]);

  const activeVps = vpsList.find((v) => v.id === activeVpsId);

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border bg-card transition-all duration-200 relative",
        collapsed ? "w-12" : "w-60",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        {!collapsed && (
          <span className="text-sm font-semibold text-foreground tracking-tight">
            Chatcode
          </span>
        )}
        <button
          onClick={onToggle}
          className="p-1 rounded hover:bg-accent text-muted-foreground"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          {/* VPS Section */}
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Servers
              </span>
              <button
                onClick={() => onNavigate("onboarding")}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                title="Add server"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {vpsList.length === 0 && (
              <button
                onClick={() => onNavigate("onboarding")}
                className="w-full text-left p-2 rounded-md border border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                + Add your first server
              </button>
            )}

            {vpsList.map((vps) => (
              <button
                key={vps.id}
                onClick={() => onSelectVps(vps.id)}
                className={cn(
                  "w-full text-left p-2 rounded-md text-sm transition-colors flex items-center gap-2",
                  vps.id === activeVpsId
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50 text-foreground",
                )}
              >
                <Server className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {vps.label || vps.region || vps.id}
                </span>
                <Circle
                  className={cn(
                    "h-2 w-2 ml-auto shrink-0 fill-current",
                    vps.status === "active"
                      ? "text-green-500"
                      : vps.status === "provisioning"
                        ? "text-yellow-500"
                        : "text-muted-foreground",
                  )}
                />
              </button>
            ))}
          </div>

          {/* VPS Actions */}
          {activeVps && (
            <div className="px-3 pb-2 flex gap-1">
              {activeVps.provider === "digitalocean" && (
                <>
                  <button
                    onClick={() =>
                      handlePowerAction(
                        activeVps.status === "active" ? "off" : "on",
                      )
                    }
                    className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                    title={
                      activeVps.status === "active" ? "Power off" : "Power on"
                    }
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={handleDeleteVPS}
                    className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                    title="Destroy VPS"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Sessions Section */}
          {activeVpsId && (
            <div className="p-3 space-y-2 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Sessions
                </span>
                <button
                  onClick={() => handleCreateSession("claude-code")}
                  disabled={creating}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                  title="New session"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {loading && sessions.length === 0 && (
                <p className="text-xs text-muted-foreground">Loading...</p>
              )}

              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "group flex items-center gap-2 p-2 rounded-md text-sm cursor-pointer transition-colors",
                    session.id === activeSessionId
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-accent/50 text-foreground",
                  )}
                >
                  <button
                    onClick={() => onSelectSession(activeVpsId, session.id)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    <Terminal className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{session.title}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEndSession(session.id);
                    }}
                    className="hidden group-hover:block p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                    title="End session"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {sessions.length === 0 && !loading && (
                <NewSessionQuickStart
                  onCreate={handleCreateSession}
                  creating={creating}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {!collapsed && (
        <div className="border-t border-border p-2 space-y-1">
          <button
            onClick={() => onNavigate("status")}
            className="w-full flex items-center gap-2 p-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Activity className="h-3.5 w-3.5" />
            Status
          </button>
          <button
            onClick={() => onNavigate("settings")}
            className="w-full flex items-center gap-2 p-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
          <div className="flex items-center justify-between p-2">
            <span className="text-xs text-muted-foreground truncate max-w-[140px]">
              {userEmail ?? ""}
            </span>
            <button
              onClick={onLogout}
              className="p-1 rounded hover:bg-accent text-muted-foreground"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function NewSessionQuickStart({
  onCreate,
  creating,
}: {
  onCreate: (agent: AgentType) => void;
  creating: boolean;
}) {
  return (
    <div className="space-y-1">
      {AGENT_TYPES.slice(0, 3).map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onCreate(value)}
          disabled={creating}
          className="w-full text-left p-2 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
        >
          + {label}
        </button>
      ))}
    </div>
  );
}

function isClosedStatus(status: string): boolean {
  return ["ended", "error", "killed"].includes(status);
}
