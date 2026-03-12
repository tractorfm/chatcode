import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  Copy,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_TYPES, defaultSessionTitle, type AgentType } from "@/lib/constants";
import {
  buildSessionTabTitle,
  DEFAULT_SESSION_WORKDIR,
  normalizeSessionWorkdir,
  sessionFolderKey,
  sessionTabPathSuffix,
} from "@chatcode/protocol";
import {
  listVPS,
  listSessions,
  listWorkspaceFolders,
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
import { SessionCreatePicker } from "@/components/session-create-picker";
const DEFAULT_SESSION_WORKDIR_INPUT = ".";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  activeVpsId: string | null;
  activeSessionId: string | null;
  onSelectVps: (vpsId: string) => void;
  onSelectSession: (vpsId: string, sessionId: string, title: string) => void;
  onNewSession: (vpsId: string, sessionId: string, title: string) => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
  onSessionTitleSync: (session: Session) => void;
  onSessionsLoaded?: (vpsId: string, sessions: Session[]) => void;
  onVpsDeleted: (deletedVpsId: string, nextVpsId: string | null) => void;
  onNavigate: (page: "settings" | "status" | "onboarding", opts?: { manualVpsId?: string | null }) => void;
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
  onSessionTitleSync,
  onSessionsLoaded,
  onVpsDeleted,
  onNavigate,
  onLogout,
  userEmail,
  externalErrorMessage,
  refreshSignal = 0,
  selectedVpsIdHint = null,
}: SidebarProps) {
  const [vpsList, setVpsList] = useState<VPS[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [dismissedError, setDismissedError] = useState("");
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [sessionWorkdir, setSessionWorkdir] = useState(DEFAULT_SESSION_WORKDIR_INPUT);
  const [groupPickerKey, setGroupPickerKey] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    kind?: "remove-server";
    watchVpsId?: string;
    title: string;
    description: string;
    details?: ReactNode;
    destructive?: boolean;
    confirmLabel?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeVps = vpsList.find((v) => v.id === activeVpsId);
  const activeVpsName = activeVps?.label || activeVps?.id || "this server";
  const isManagedVps = activeVps?.provider === "digitalocean";
  const sessionHeading = sessions.length > 0 ? `Sessions (${sessions.length})` : "Sessions";
  const canCreateSessions = activeVps?.status === "active" && activeVps?.gateway_connected === true;
  const transientPollCountRef = useRef(0);

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

  const applyVPSList = useCallback((vps: VPS[]) => {
    setVpsList(vps);
    setErrorMessage("");
    if (activeVpsId && !vps.some((row) => row.id === activeVpsId)) {
      const nextVpsId = vps[0]?.id ?? null;
      onVpsDeleted(activeVpsId, nextVpsId);
      if (confirmAction?.kind === "remove-server" && confirmAction.watchVpsId === activeVpsId) {
        setConfirmAction(null);
      }
      return;
    }
    if (selectedVpsIdHint && vps.some((row) => row.id === selectedVpsIdHint)) {
      onSelectVps(selectedVpsIdHint);
    } else if (vps.length > 0 && !activeVpsId) {
      onSelectVps(vps[0].id);
    }
  }, [activeVpsId, confirmAction, onSelectVps, onVpsDeleted, selectedVpsIdHint]);

  const refreshVPS = useCallback(async () => {
    try {
      const { vps } = await listVPS();
      applyVPSList(vps);
    } catch (err) {
      setOperationError("Failed to load servers", err);
    }
  }, [applyVPSList, setOperationError]);

  const refreshSessions = useCallback(async () => {
    if (!activeVpsId) return;
    setLoading(true);
    try {
      const { sessions: s } = await listSessions(activeVpsId);
      const openSessions = s.filter((s) => !isClosedStatus(s.status));
      setSessions(openSessions);
      setErrorMessage("");
      onSessionsLoaded?.(activeVpsId, openSessions);
      openSessions.forEach((session) => onSessionTitleSync(session));
      if (
        openSessions.length > 0 &&
        !openSessions.some((session) => session.id === activeSessionIdRef.current)
      ) {
        const first = openSessions[0];
        onSelectSession(activeVpsId, first.id, buildSessionTabTitle(first.title, first.workdir));
      }
    } catch (err) {
      setOperationError("Failed to load sessions", err);
    } finally {
      setLoading(false);
    }
  }, [activeVpsId, onSelectSession, onSessionTitleSync, onSessionsLoaded, setOperationError]);

  const refreshWorkspaceFolders = useCallback(async () => {
    if (!activeVpsId || !canCreateSessions) {
      setWorkspaceFolders([]);
      return;
    }
    try {
      const { folders } = await listWorkspaceFolders(activeVpsId);
      setWorkspaceFolders(
        folders.filter((value) => value && !value.includes("/") && !value.startsWith(".")),
      );
    } catch {
      setWorkspaceFolders([]);
    }
  }, [activeVpsId, canCreateSessions]);

  useEffect(() => {
    void refreshVPS();
  }, [refreshVPS]);

  useEffect(() => {
    void refreshSessions();
  }, [activeVpsId, refreshSessions, refreshSignal]);

  useEffect(() => {
    void refreshWorkspaceFolders();
  }, [activeVpsId, refreshSignal, refreshWorkspaceFolders]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void refreshVPS();
  }, [refreshSignal, refreshVPS]);

  useEffect(() => {
    if (vpsList.length === 0) return;
    const hasTransientVpsState =
      vpsList.some(
        (vps) =>
          vps.status === "provisioning" ||
          (vps.status === "active" && vps.gateway_connected === false),
      ) ||
      confirmAction?.kind === "remove-server";
    const hasManualVps = vpsList.some((vps) => vps.provider === "manual");
    if (!hasTransientVpsState && !hasManualVps) {
      transientPollCountRef.current = 0;
      return;
    }
    transientPollCountRef.current = hasTransientVpsState ? transientPollCountRef.current + 1 : 0;
    const intervalMs = hasTransientVpsState
      ? transientPollCountRef.current <= 12 ? 5000 : 30000
      : 60000;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      void refreshVPS();
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [confirmAction, refreshVPS, vpsList]);

  const handleCreateSession = useCallback(
    async (agentType: AgentType = "claude-code") => {
      if (!activeVpsId || creating) return;
      setCreating(true);
      try {
        const title = defaultSessionTitle(
          agentType,
          sessions.filter((session) => session.agent_type === agentType).length + 1,
        );
        const workdir = normalizeSessionWorkdir(sessionWorkdir);
        const res = await createSession(activeVpsId, {
          title,
          agent_type: agentType,
          workdir,
        });
        await refreshSessions();
        await refreshWorkspaceFolders();
        onNewSession(activeVpsId, res.session_id, buildSessionTabTitle(title, workdir));
        setErrorMessage("");
        setShowAgentPicker(false);
        setGroupPickerKey(null);
        setSessionWorkdir(DEFAULT_SESSION_WORKDIR_INPUT);
      } catch (err) {
        setOperationError("Failed to create session", err);
      } finally {
        setCreating(false);
      }
    },
    [activeVpsId, creating, sessions, sessionWorkdir, refreshSessions, onNewSession, setOperationError],
  );

  const handleRefreshActiveVps = useCallback(async () => {
    if (!activeVpsId) return;
    await refreshVPS();
    await Promise.all([refreshSessions(), refreshWorkspaceFolders()]);
  }, [activeVpsId, refreshSessions, refreshVPS, refreshWorkspaceFolders]);

  const doEndSession = useCallback(
    async (sessionId: string) => {
      if (!activeVpsId) return;
      try {
        await deleteSession(activeVpsId, sessionId);
        await refreshSessions();
        await refreshWorkspaceFolders();
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
      if (action === "on") {
        doPowerAction("on");
        return;
      }
      setConfirmAction({
        title: "Power off server",
        description: `This will shut down "${activeVpsName}" and disconnect all sessions.`,
        destructive: true,
        confirmLabel: "Power off",
        onConfirm: () => doPowerAction("off"),
      });
    },
    [activeVpsName, doPowerAction],
  );

  const doDeleteVPS = useCallback(async () => {
    if (!activeVpsId) return;
    try {
      await deleteVPS(activeVpsId);
      const { vps } = await listVPS();
      applyVPSList(vps);
      setErrorMessage("");
    } catch (err) {
      setOperationError(
        isManagedVps ? "Failed to destroy server" : "Failed to remove server",
        err,
      );
    }
  }, [activeVpsId, applyVPSList, isManagedVps, setOperationError]);

  const handleDeleteVPS = useCallback(() => {
    if (!activeVpsId) return;
    const cleanupDetails = !isManagedVps ? (
      <CleanupCommandDetails os={activeVps?.gateway_os} />
    ) : undefined;
    setConfirmAction({
      kind: "remove-server",
      watchVpsId: activeVpsId,
      title: isManagedVps ? "Destroy server" : "Remove server",
      description: isManagedVps
        ? `This will permanently destroy "${activeVpsName}" and all its data. This cannot be undone.`
        : `This will remove "${activeVpsName}" from chatcode and stop reconnect attempts. This does not power off the host.`,
      details: cleanupDetails,
      destructive: true,
      confirmLabel: isManagedVps ? "Destroy server" : "Remove without cleanup",
      onConfirm: doDeleteVPS,
    });
  }, [activeVpsId, activeVpsName, doDeleteVPS, isManagedVps]);

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
        const session = sessions.find((entry) => entry.id === sessionId);
        await updateSession(activeVpsId, sessionId, { title });
        onSessionRenamed(sessionId, buildSessionTabTitle(title, session?.workdir || DEFAULT_SESSION_WORKDIR));
        await refreshSessions();
      } catch (err) {
        setOperationError("Failed to rename session", err);
        throw err;
      }
    },
    [activeVpsId, refreshSessions, onSessionRenamed, sessions, setOperationError],
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
        <div className="flex h-full flex-1 flex-col overflow-y-auto">
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
                <ProviderServerIcon provider={vps.provider} gatewayOS={vps.gateway_os} />
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
                    vps.status === "provisioning"
                        ? "text-yellow-500"
                      : vps.status === "active" && vps.gateway_connected
                        ? "text-green-500"
                        : vps.status === "active"
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
              {activeVps.provider === "manual" && !activeVps.gateway_connected ? (
                <button
                  onClick={() => onNavigate("onboarding", { manualVpsId: activeVps.id })}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                  title="Show install command"
                >
                  <Terminal className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                onClick={() => {
                  if (!isManagedVps) return;
                  handlePowerAction(activeVps.status === "active" ? "off" : "on");
                }}
                disabled={!isManagedVps}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  isManagedVps
                    ? activeVps.status === "active"
                      ? "Power off"
                      : "Power on"
                    : "Power control is not available for manual servers yet"
                }
              >
                <Power className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={handleDeleteVPS}
                className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                title={isManagedVps ? "Destroy server" : "Remove server"}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Sessions Section */}
          {activeVpsId && (
            <div className="p-3 space-y-2 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {sessionHeading}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleRefreshActiveVps()}
                    disabled={!activeVpsId || loading}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
                    title="Refresh sessions and folders"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                  </button>
                <div className="relative">
                  <button
                    data-testid="create-session-button"
                    onClick={() => {
                      setGroupPickerKey(null);
                      setSessionWorkdir(DEFAULT_SESSION_WORKDIR_INPUT);
                      setShowAgentPicker((p) => !p);
                    }}
                    disabled={creating || !canCreateSessions}
                    className="p-0.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                    title={canCreateSessions ? "New session" : "Server must be connected to create sessions"}
                    >
                      {creating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                    </button>
                  {showAgentPicker && !creating && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-56">
                      <SessionCreatePicker
                        workdir={sessionWorkdir}
                        onWorkdirChange={setSessionWorkdir}
                        onCreate={handleCreateSession}
                        creating={creating}
                        disabled={!canCreateSessions}
                      />
                    </div>
                  )}
                </div>
                </div>
              </div>

              {loading && sessions.length === 0 && (
                <p className="text-xs text-muted-foreground">Loading...</p>
              )}

              {groupSessionsByFolder(sessions, workspaceFolders).map((group) => (
                <div key={group.key} className="space-y-1">
                  <div className="flex items-center justify-between px-2 pt-1">
                    <div className="text-sm font-normal text-muted-foreground">
                      {group.label}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentPicker(false);
                        setGroupPickerKey((current) => current === group.key ? null : group.key);
                        setSessionWorkdir(group.inputValue);
                      }}
                      disabled={creating || !canCreateSessions}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
                      title={canCreateSessions ? `New session in ${group.label}` : "Server must be connected to create sessions"}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                  {groupPickerKey === group.key && (
                    <div className="px-2">
                      <SessionCreatePicker
                        workdir={sessionWorkdir}
                        onWorkdirChange={setSessionWorkdir}
                        onCreate={handleCreateSession}
                        creating={creating}
                        disabled={!canCreateSessions}
                      />
                    </div>
                  )}
                  {group.sessions.length === 0 ? (
                    <div className="px-2 py-1 text-xs text-muted-foreground/70">
                      No sessions yet
                    </div>
                  ) : null}
                  {group.sessions.map((session) => (
                    <div
                      key={session.id}
                      data-testid={`session-item-${session.id}`}
                      onClick={() => onSelectSession(activeVpsId, session.id, buildSessionTabTitle(session.title, session.workdir))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectSession(activeVpsId, session.id, buildSessionTabTitle(session.title, session.workdir));
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
                      <div className="flex items-start gap-2 flex-1 min-w-0 text-left">
                        <Terminal className="mt-1 h-3.5 w-3.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <InlineEdit
                            value={session.title}
                            onSave={(title) => handleRenameSession(session.id, title)}
                            maxLength={80}
                            editable={session.id === activeSessionId}
                            editMode="single"
                            className="min-w-0"
                          />
                          <div
                            className={cn(
                              "truncate text-xs text-muted-foreground",
                              session.id === activeSessionId ? "font-medium" : "font-normal",
                            )}
                          >
                            {formatSessionSubtitle(session)}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEndSession(session.id);
                        }}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus:opacity-100"
                        title="End session"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ))}

              {sessions.length === 0 && !loading && (
                <NewSessionQuickStart
                  onCreate={handleCreateSession}
                  creating={creating}
                  disabled={!canCreateSessions}
                />
              )}

            </div>
          )}
          {visibleError && (
            <div className="mt-auto px-3 pb-2">
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
          details={confirmAction.details}
          destructive={confirmAction.destructive}
          confirmLabel={confirmAction.confirmLabel}
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

function ProviderServerIcon({
  provider,
  gatewayOS,
}: {
  provider?: "digitalocean" | "manual";
  gatewayOS?: string | null;
}) {
  if (provider === "digitalocean") {
    return (
      <svg
        viewBox="67 175.2 176.4 176.5"
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 fill-current"
      >
        <path d="M155.2,351.7v-34.2c36.2,0,64.3-35.9,50.4-74c-5.1-14.1-16.4-25.4-30.5-30.5c-38.1-13.8-74,14.2-74,50.4l0,0H67c0-57.7,55.8-102.7,116.3-83.8c26.4,8.3,47.5,29.3,55.7,55.7C257.9,295.9,213,351.7,155.2,351.7z" />
        <path d="M155.3,317.6h-34v-34h34V317.6z" />
        <path d="M121.3,343.8H95.1v-26.2h26.2V343.8z" />
        <path d="M95.1,317.6H73.2v-21.9h21.9V317.6z" />
      </svg>
    );
  }
  if (gatewayOS === "darwin") {
    return (
      <svg
        viewBox="0 0 41.5 51"
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 fill-current"
      >
        <path d="M40.2,17.4c-3.4,2.1-5.5,5.7-5.5,9.7c0,4.5,2.7,8.6,6.8,10.3c-0.8,2.6-2,5-3.5,7.2c-2.2,3.1-4.5,6.3-7.9,6.3s-4.4-2-8.4-2c-3.9,0-5.3,2.1-8.5,2.1s-5.4-2.9-7.9-6.5C2,39.5,0.1,33.7,0,27.6c0-9.9,6.4-15.2,12.8-15.2c3.4,0,6.2,2.2,8.3,2.2c2,0,5.2-2.3,9-2.3C34.1,12.2,37.9,14.1,40.2,17.4z M28.3,8.1C30,6.1,30.9,3.6,31,1c0-0.3,0-0.7-0.1-1c-2.9,0.3-5.6,1.7-7.5,3.9c-1.7,1.9-2.7,4.3-2.8,6.9c0,0.3,0,0.6,0.1,0.9c0.2,0,0.5,0.1,0.7,0.1C24.1,11.6,26.6,10.2,28.3,8.1z" />
      </svg>
    );
  }
  return <Server className="h-3.5 w-3.5 shrink-0" />;
}

function formatSessionSubtitle(session: Session): string {
  const label = sessionCommandLabel(session.agent_type);
  const subpath = sessionTabPathSuffix(session.workdir);
  return subpath ? `${label} · ${subpath}` : label;
}

function groupSessionsByFolder(sessions: Session[], folders: string[]) {
  const groups = new Map<string, Session[]>();
  for (const folder of folders) {
    const key = folder.trim();
    if (!key) continue;
    groups.set(key, []);
  }
  for (const session of sessions) {
    const key = sessionFolderKey(session.workdir);
    const bucket = groups.get(key);
    if (bucket) bucket.push(session);
    else groups.set(key, [session]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === "") return -1;
      if (b === "") return 1;
      return a.localeCompare(b);
    })
    .map(([key, grouped]) => ({
      key,
      label: key === "" ? "~/workspace" : `~/workspace/${key}`,
      inputValue: key === "" ? "." : key,
      sessions: grouped,
    }));
}


function sessionCommandLabel(agentType: string): string {
  switch (agentType) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode";
    case "none":
      return "bash";
    default:
      return agentType || "shell";
  }
}

function cleanupCommandForOS(os: string | null | undefined): string | null {
  if (os === "linux") {
    return "curl -fsSL https://chatcode.dev/cleanup.sh | sudo bash -s -- --yes";
  }
  if (os === "darwin") {
    return "curl -fsSL https://chatcode.dev/cleanup.sh | bash -s -- --yes";
  }
  return null;
}

function CleanupCommandDetails({ os }: { os?: string | null }) {
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<"linux" | "darwin">(
    os === "darwin" ? "darwin" : "linux",
  );
  const knownOS = os === "darwin" || os === "linux";
  const selectedPlatform = knownOS ? os : platform;
  const command = cleanupCommandForOS(selectedPlatform);

  const copyCommand = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, []);

  if (command) {
    const label = selectedPlatform === "darwin" ? "macOS" : "Linux";
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          If the host still exists, cleanly remove the gateway first:
        </p>
        {!knownOS ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPlatform("linux")}
              className={`px-2 py-1 rounded-md text-xs border ${
                platform === "linux"
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border text-muted-foreground"
              }`}
            >
              Linux
            </button>
            <button
              type="button"
              onClick={() => setPlatform("darwin")}
              className={`px-2 py-1 rounded-md text-xs border ${
                platform === "darwin"
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border text-muted-foreground"
              }`}
            >
              macOS
            </button>
          </div>
        ) : null}
        <div className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <div className="bg-background rounded-md border border-border p-3">
            <code className="text-xs font-mono text-foreground break-all">
              {command}
            </code>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void copyCommand(command)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-foreground hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
    );
  }
  return null;
}

function NewSessionQuickStart({
  onCreate,
  creating,
  disabled,
}: {
  onCreate: (agent: AgentType) => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      {AGENT_TYPES.filter(({ value }) => value === "claude-code" || value === "codex" || value === "none").map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onCreate(value)}
          disabled={creating || disabled}
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
