import { useCallback, useEffect, useRef, useState } from "react";
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
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_TYPES, defaultSessionTitle, type AgentType } from "@/lib/constants";
import {
  listVPS,
  listSessions,
  createSession,
  deleteSession,
  deleteVPS,
  powerOffVPS,
  powerOnVPS,
  updateVPS,
  updateSession,
  type VPS,
  type Session,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineEdit } from "@/components/inline-edit";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  activeVpsId: string | null;
  activeSessionId: string | null;
  onSelectVps: (vpsId: string) => void;
  onSelectSession: (vpsId: string, sessionId: string, title: string) => void;
  onNewSession: (vpsId: string, sessionId: string, title: string) => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
  onNavigate: (page: "settings" | "status" | "onboarding") => void;
  onLogout: () => void;
  userEmail?: string;
  externalErrorMessage?: string;
  refreshSignal?: number;
  selectedVpsIdHint?: string | null;
}

export function Sidebar({
  collapsed,
  onToggle,
  activeVpsId,
  activeSessionId,
  onSelectVps,
  onSelectSession,
  onNewSession,
  onSessionRenamed,
  onNavigate,
  onLogout,
  userEmail,
  externalErrorMessage,
  refreshSignal = 0,
  selectedVpsIdHint = null,
}: SidebarProps) {
  const [vpsList, setVpsList] = useState<VPS[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [dismissedError, setDismissedError] = useState("");
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    destructive?: boolean;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeVps = vpsList.find((v) => v.id === activeVpsId);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    setDismissedError("");
  }, [errorMessage, externalErrorMessage]);

  const setOperationError = useCallback((prefix: string, err: unknown) => {
    const detail = err instanceof Error ? err.message : "unexpected error";
    setErrorMessage(`${prefix}: ${detail}`);
  }, []);

  const refreshVPS = useCallback(async () => {
    try {
      const { vps } = await listVPS();
      setVpsList(vps);
      setErrorMessage("");
      if (selectedVpsIdHint && vps.some((row) => row.id === selectedVpsIdHint)) {
        onSelectVps(selectedVpsIdHint);
      } else if (vps.length > 0 && !activeVpsId) {
        onSelectVps(vps[0].id);
      }
    } catch (err) {
      setOperationError("Failed to load servers", err);
    }
  }, [activeVpsId, onSelectVps, selectedVpsIdHint, setOperationError]);

  const refreshSessions = useCallback(async () => {
    if (!activeVpsId) return;
    setLoading(true);
    try {
      const { sessions: s } = await listSessions(activeVpsId);
      const openSessions = s.filter((s) => !isClosedStatus(s.status));
      setSessions(openSessions);
      setErrorMessage("");
      if (
        openSessions.length > 0 &&
        !openSessions.some((session) => session.id === activeSessionIdRef.current)
      ) {
        onSelectSession(activeVpsId, openSessions[0].id, openSessions[0].title);
      }
    } catch (err) {
      setOperationError("Failed to load sessions", err);
    } finally {
      setLoading(false);
    }
  }, [activeVpsId, onSelectSession, setOperationError]);

  useEffect(() => {
    void refreshVPS();
  }, [refreshVPS]);

  useEffect(() => {
    void refreshSessions();
  }, [activeVpsId, refreshSessions, refreshSignal]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void refreshVPS();
  }, [refreshSignal, refreshVPS]);

  useEffect(() => {
    if (
      !vpsList.some(
        (vps) => vps.status === "provisioning" || (vps.status === "active" && vps.gateway_connected === false),
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshVPS();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshVPS, vpsList]);

  const handleCreateSession = useCallback(
    async (agentType: AgentType = "claude-code") => {
      if (!activeVpsId || creating) return;
      setCreating(true);
      try {
        const title = defaultSessionTitle(agentType, sessions.length + 1);
        const res = await createSession(activeVpsId, {
          title,
          agent_type: agentType,
        });
        await refreshSessions();
        onNewSession(activeVpsId, res.session_id, title);
        setErrorMessage("");
      } catch (err) {
        setOperationError("Failed to create session", err);
      } finally {
        setCreating(false);
      }
    },
    [activeVpsId, creating, sessions.length, refreshSessions, onNewSession, setOperationError],
  );

  const doEndSession = useCallback(
    async (sessionId: string) => {
      if (!activeVpsId) return;
      try {
        await deleteSession(activeVpsId, sessionId);
        await refreshSessions();
        setErrorMessage("");
      } catch (err) {
        setOperationError("Failed to end session", err);
      }
    },
    [activeVpsId, refreshSessions, setOperationError],
  );

  const handleEndSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((entry) => entry.id === sessionId);
      setConfirmAction({
        title: "End session",
        description: `This will terminate "${session?.title || sessionId}" and any running processes.`,
        destructive: true,
        onConfirm: () => doEndSession(sessionId),
      });
    },
    [doEndSession, sessions],
  );

  const doPowerAction = useCallback(
    async (action: "off" | "on") => {
      if (!activeVpsId) return;
      try {
        if (action === "off") await powerOffVPS(activeVpsId);
        else await powerOnVPS(activeVpsId);
        await refreshVPS();
        setErrorMessage("");
      } catch (err) {
        setOperationError("Power action failed", err);
      }
    },
    [activeVpsId, refreshVPS, setOperationError],
  );

  const handlePowerAction = useCallback(
    (action: "off" | "on") => {
      const serverName = activeVps?.label || activeVps?.id || "this server";
      if (action === "on") {
        doPowerAction("on");
        return;
      }
      setConfirmAction({
        title: "Power off server",
        description: `This will shut down "${serverName}" and disconnect all sessions.`,
        destructive: true,
        onConfirm: () => doPowerAction("off"),
      });
    },
    [activeVps, doPowerAction],
  );

  const doDeleteVPS = useCallback(async () => {
    if (!activeVpsId) return;
    try {
      await deleteVPS(activeVpsId);
      await refreshVPS();
      setErrorMessage("");
    } catch (err) {
      setOperationError("Failed to destroy VPS", err);
    }
  }, [activeVpsId, refreshVPS, setOperationError]);

  const handleDeleteVPS = useCallback(() => {
    if (!activeVpsId) return;
    setConfirmAction({
      title: "Destroy server",
      description: `This will permanently destroy "${activeVps?.label || activeVps?.id || activeVpsId}" and all its data. This cannot be undone.`,
      destructive: true,
      onConfirm: doDeleteVPS,
    });
  }, [activeVps, activeVpsId, doDeleteVPS]);

  const handleRenameVps = useCallback(
    async (vpsId: string, label: string) => {
      try {
        await updateVPS(vpsId, { label });
        await refreshVPS();
      } catch (err) {
        setOperationError("Failed to rename server", err);
        throw err;
      }
    },
    [refreshVPS, setOperationError],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!activeVpsId) return;
      try {
        await updateSession(activeVpsId, sessionId, { title });
        onSessionRenamed(sessionId, title);
        await refreshSessions();
      } catch (err) {
        setOperationError("Failed to rename session", err);
        throw err;
      }
    },
    [activeVpsId, refreshSessions, onSessionRenamed, setOperationError],
  );

  const displayedError = externalErrorMessage || errorMessage;
  const visibleError = displayedError && displayedError !== dismissedError ? displayedError : "";

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "flex flex-col border-r border-border bg-card transition-all duration-200 relative",
        collapsed ? "w-12" : "w-60",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        {!collapsed && (
          <span className="font-semibold text-foreground tracking-tight">
            chatcode.dev
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
              <div
                key={vps.id}
                data-testid={`vps-item-${vps.id}`}
                onClick={() => onSelectVps(vps.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectVps(vps.id);
                  }
                }}
                role="button"
                tabIndex={0}
                className={cn(
                  "w-full text-left p-2 rounded-md text-sm transition-colors flex items-center gap-2 cursor-pointer",
                  vps.id === activeVpsId
                    ? "bg-accent text-accent-foreground font-medium"
                    : "hover:bg-accent/50 text-foreground font-normal",
                )}
              >
                <Server className="h-3.5 w-3.5 shrink-0" />
                <InlineEdit
                  value={vps.label || vps.region || vps.id}
                  onSave={(label) => handleRenameVps(vps.id, label)}
                  maxLength={64}
                  allowEmpty
                  editable={vps.id === activeVpsId}
                  editMode="single"
                  className="flex-1 min-w-0"
                />
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
              </div>
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
                <div className="relative">
                  <button
                    data-testid="create-session-button"
                    onClick={() => setShowAgentPicker((p) => !p)}
                    disabled={creating}
                    className="p-0.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                    title="New session"
                  >
                    {creating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {showAgentPicker && !creating && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border border-border bg-card shadow-lg py-1">
                      {AGENT_TYPES.map(({ value, label }) => (
                        <button
                          key={value}
                          onClick={() => {
                            setShowAgentPicker(false);
                            handleCreateSession(value);
                          }}
                          className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {loading && sessions.length === 0 && (
                <p className="text-xs text-muted-foreground">Loading...</p>
              )}

              {sessions.map((session) => (
                <div
                  key={session.id}
                  data-testid={`session-item-${session.id}`}
                  onClick={() => onSelectSession(activeVpsId, session.id, session.title)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectSession(activeVpsId, session.id, session.title);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex items-center gap-2 p-2 rounded-md text-sm cursor-pointer transition-colors",
                    session.id === activeSessionId
                      ? "bg-primary/10 text-primary font-medium"
                      : "hover:bg-accent/50 text-foreground font-normal",
                  )}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    <Terminal className="h-3.5 w-3.5 shrink-0" />
                    <InlineEdit
                      value={session.title}
                      onSave={(title) => handleRenameSession(session.id, title)}
                      maxLength={80}
                      editable={session.id === activeSessionId}
                      editMode="single"
                      className="flex-1 min-w-0"
                    />
                  </div>
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
          {visibleError && (
            <div className="sticky bottom-0 border-t border-yellow-500/20 bg-card/95 px-3 py-2 backdrop-blur">
              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-900 dark:text-yellow-200">
                <div className="flex items-start justify-between gap-3">
                  <span>{visibleError}</span>
                  <button
                    type="button"
                    onClick={() => setDismissedError(visibleError)}
                    className="shrink-0 rounded px-1 text-yellow-800/80 hover:bg-yellow-500/10 hover:text-yellow-950 dark:text-yellow-100/80 dark:hover:text-yellow-50"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              </div>
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
          <div className="flex items-center justify-between px-2 pb-1">
            <a
              href="https://github.com/tractorfm/chatcode"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              GitHub
            </a>
            <span className="text-[10px] text-muted-foreground/40">
              {__BUILD_BRANCH__}@{__BUILD_SHA__}
            </span>
          </div>
        </div>
      )}
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.description}
          destructive={confirmAction.destructive}
          onConfirm={async () => {
            await confirmAction.onConfirm();
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Close agent picker when clicking outside */}
      {showAgentPicker && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowAgentPicker(false)}
        />
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
