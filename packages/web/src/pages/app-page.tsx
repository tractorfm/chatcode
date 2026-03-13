import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { TerminalView } from "@/components/terminal-view";
import { SessionCreatePicker } from "@/components/session-create-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { X, Plus, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createSession,
  getMissingAgentFromError,
  installAgent,
  waitForAgentInstalled,
  type Session,
} from "@/lib/api";
import { defaultSessionTitle, type AgentType } from "@/lib/constants";
import { buildSessionTabTitle, normalizeSessionWorkdir } from "@chatcode/protocol";

interface AppPageProps {
  userEmail?: string;
  onLogout: () => void;
  onNavigate: (page: "settings" | "status" | "onboarding", opts?: { manualVpsId?: string | null }) => void;
  overlayOpen?: boolean;
  externalRefreshSignal?: number;
  selectedVpsIdHint?: string | null;
}

interface OpenTab {
  vpsId: string;
  sessionId: string;
  title: string;
}

interface TabState {
  tabs: OpenTab[];
  activeIndex: number;
}

interface PersistedAppState {
  activeVpsId: string | null;
  tabState: TabState;
}

const APP_PAGE_STATE_KEY = "chatcode.app-page.state.v1";
const APP_PAGE_STATE_PERSIST_DEBOUNCE_MS = 150;

type TabAction =
  | { type: "open"; tab: OpenTab }
  | { type: "close"; index: number }
  | { type: "setActive"; index: number }
  | { type: "reorderVisible"; vpsId: string | null; fromIndex: number; toIndex: number }
  | { type: "markEnded"; sessionId: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "removeVps"; vpsId: string };

function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "open": {
      const existingIndex = state.tabs.findIndex(
        (t) => t.vpsId === action.tab.vpsId && t.sessionId === action.tab.sessionId,
      );
      if (existingIndex >= 0) {
        return {
          tabs: state.tabs.map((tab, index) =>
            index === existingIndex ? { ...tab, title: action.tab.title } : tab,
          ),
          activeIndex: existingIndex,
        };
      }
      return {
        tabs: [...state.tabs, action.tab],
        activeIndex: state.tabs.length,
      };
    }
    case "close": {
      if (action.index < 0 || action.index >= state.tabs.length) return state;
      const nextTabs = state.tabs.filter((_, i) => i !== action.index);
      if (nextTabs.length === 0) {
        return { tabs: [], activeIndex: 0 };
      }
      let nextActive = state.activeIndex;
      if (state.activeIndex === action.index) {
        nextActive = Math.min(action.index, nextTabs.length - 1);
      } else if (state.activeIndex > action.index) {
        nextActive = state.activeIndex - 1;
      }
      return { tabs: nextTabs, activeIndex: nextActive };
    }
    case "setActive":
      if (action.index < 0 || action.index >= state.tabs.length) return state;
      return { ...state, activeIndex: action.index };
    case "reorderVisible": {
      if (action.fromIndex === action.toIndex) return state;
      const visiblePositions = state.tabs
        .map((tab, index) => ({ tab, index }))
        .filter(({ tab }) => !action.vpsId || tab.vpsId === action.vpsId);
      if (
        action.fromIndex < 0 ||
        action.toIndex < 0 ||
        action.fromIndex >= visiblePositions.length ||
        action.toIndex >= visiblePositions.length
      ) {
        return state;
      }
      const reorderedVisible = visiblePositions.map(({ tab }) => tab);
      const [moved] = reorderedVisible.splice(action.fromIndex, 1);
      reorderedVisible.splice(action.toIndex, 0, moved);
      const nextTabs = state.tabs.slice();
      visiblePositions.forEach(({ index }, visibleIndex) => {
        nextTabs[index] = reorderedVisible[visibleIndex];
      });
      const activeSessionId = state.tabs[state.activeIndex]?.sessionId;
      const nextActiveIndex = activeSessionId
        ? nextTabs.findIndex((tab) => tab.sessionId === activeSessionId)
        : state.activeIndex;
      return {
        tabs: nextTabs,
        activeIndex: nextActiveIndex >= 0 ? nextActiveIndex : state.activeIndex,
      };
    }
    case "markEnded":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.sessionId === action.sessionId && !t.title.endsWith(" (ended)")
            ? { ...t, title: `${t.title} (ended)` }
            : t,
        ),
      };
    case "rename":
      if (!state.tabs.some((t) => t.sessionId === action.sessionId && t.title !== action.title)) {
        return state;
      }
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.sessionId === action.sessionId ? { ...t, title: action.title } : t,
        ),
      };
    case "removeVps": {
      const nextTabs = state.tabs.filter((t) => t.vpsId !== action.vpsId);
      if (nextTabs.length === 0) {
        return { tabs: [], activeIndex: 0 };
      }
      let nextActive = state.activeIndex;
      if (state.tabs[state.activeIndex]?.vpsId === action.vpsId) {
        nextActive = Math.min(nextActive, nextTabs.length - 1);
      } else {
        const removedBeforeActive = state.tabs
          .slice(0, state.activeIndex)
          .filter((t) => t.vpsId === action.vpsId).length;
        nextActive = Math.max(0, state.activeIndex - removedBeforeActive);
      }
      return { tabs: nextTabs, activeIndex: nextActive };
    }
    default:
      return state;
  }
}

export function AppPage({
  userEmail,
  onLogout,
  onNavigate,
  overlayOpen = false,
  externalRefreshSignal = 0,
  selectedVpsIdHint = null,
}: AppPageProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeVpsId, setActiveVpsId] = useState<string | null>(() => loadPersistedAppState().activeVpsId);
  const [sidebarErrorMessage, setSidebarErrorMessage] = useState("");
  const [sessionRefreshSignal, setSessionRefreshSignal] = useState(0);
  const [tabState, dispatchTab] = useReducer(
    tabReducer,
    undefined,
    () => loadPersistedAppState().tabState,
  );
  const [emptyActionBusy, setEmptyActionBusy] = useState(false);
  const [draggingVisibleIndex, setDraggingVisibleIndex] = useState<number | null>(null);
  const [showEmptyCreateMenu, setShowEmptyCreateMenu] = useState(false);
  const [emptyCreateWorkdir, setEmptyCreateWorkdir] = useState("new");
  const [emptyInstallPrompt, setEmptyInstallPrompt] = useState<{
    agentType: "claude-code" | "codex" | "gemini" | "opencode";
    title: string;
    workdir: string;
  } | null>(null);

  const handleSelectVps = useCallback((vpsId: string) => {
    setActiveVpsId(vpsId);
    setSidebarErrorMessage("");
  }, []);

  const handleSelectSession = useCallback(
    (vpsId: string, sessionId: string, title: string) => {
      dispatchTab({
        type: "open",
        tab: {
          vpsId,
          sessionId,
          title,
        },
      });
      setSidebarErrorMessage("");
    },
    [],
  );

  const handleNewSession = useCallback(
    (vpsId: string, sessionId: string, title: string) => {
      dispatchTab({
        type: "open",
        tab: {
          vpsId,
          sessionId,
          title,
        },
      });
      setActiveVpsId(vpsId);
      setSidebarErrorMessage("");
    },
    [],
  );

  const handleCloseTab = useCallback((index: number) => {
    dispatchTab({ type: "close", index });
  }, []);

  const handleSessionEnded = useCallback((sessionId: string) => {
    dispatchTab({ type: "markEnded", sessionId });
  }, []);

  const handleSessionStateRefreshNeeded = useCallback(() => {
    setSessionRefreshSignal((value) => value + 1);
  }, []);

  const handleSessionRenamed = useCallback((sessionId: string, title: string) => {
    dispatchTab({ type: "rename", sessionId, title });
  }, []);

  const handleSessionTitleSync = useCallback((session: Session) => {
    dispatchTab({
      type: "rename",
      sessionId: session.id,
      title: buildSessionTabTitle(session.title, session.workdir),
    });
  }, []);

  const handleVpsDeleted = useCallback((deletedVpsId: string, nextVpsId: string | null) => {
    dispatchTab({ type: "removeVps", vpsId: deletedVpsId });
    setActiveVpsId(nextVpsId);
    setSidebarErrorMessage("");
    setSessionRefreshSignal((value) => value + 1);
  }, []);

  const handleCreateSessionFromEmpty = useCallback(async (agentType: AgentType) => {
    if (!activeVpsId || emptyActionBusy) return;
    setEmptyActionBusy(true);
    const title = defaultSessionTitle(agentType, 1);
    const workdir = normalizeSessionWorkdir(emptyCreateWorkdir);
    try {
      const res = await createSession(activeVpsId, {
        title,
        agent_type: agentType,
        workdir,
      });
      dispatchTab({
        type: "open",
        tab: {
          vpsId: activeVpsId,
          sessionId: res.session_id,
          title: buildSessionTabTitle(title, workdir),
        },
      });
      setSidebarErrorMessage("");
      setShowEmptyCreateMenu(false);
      setEmptyCreateWorkdir("new");
    } catch (err) {
      const missingAgent = getMissingAgentFromError(err);
      if (missingAgent) {
        setEmptyInstallPrompt({
          agentType: missingAgent,
          title,
          workdir,
        });
        setSidebarErrorMessage("");
      } else {
        const detail = err instanceof Error ? err.message : "unexpected error";
        setSidebarErrorMessage(`Failed to create session: ${detail}`);
      }
    } finally {
      setEmptyActionBusy(false);
    }
  }, [activeVpsId, emptyActionBusy, emptyCreateWorkdir]);

  const visibleTabs = useMemo(
    () =>
      tabState.tabs
        .map((tab, index) => ({ tab, index }))
        .filter(({ tab }) => !activeVpsId || tab.vpsId === activeVpsId),
    [activeVpsId, tabState.tabs],
  );

  const effectiveActiveIndex = useMemo(() => {
    if (visibleTabs.length === 0) return -1;
    const activeVisible = visibleTabs.find(({ index }) => index === tabState.activeIndex);
    return activeVisible ? activeVisible.index : visibleTabs[0].index;
  }, [tabState.activeIndex, visibleTabs]);

  const activeTab = useMemo(
    () => (effectiveActiveIndex >= 0 ? tabState.tabs[effectiveActiveIndex] ?? null : null),
    [effectiveActiveIndex, tabState.tabs],
  );

  const combinedRefreshSignal = sessionRefreshSignal + externalRefreshSignal;

  useEffect(() => {
    if (!selectedVpsIdHint) return;
    setActiveVpsId(selectedVpsIdHint);
    setSidebarErrorMessage("");
  }, [selectedVpsIdHint]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      persistAppState({
        activeVpsId,
        tabState,
      });
    }, APP_PAGE_STATE_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeVpsId, tabState]);

  const handleSessionsLoaded = useCallback((vpsId: string, sessions: Session[]) => {
    const openIds = new Set(sessions.map((session) => session.id));
    const staleIndices = tabState.tabs
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => tab.vpsId === vpsId && !openIds.has(tab.sessionId))
      .map(({ index }) => index)
      .sort((a, b) => b - a);
    if (staleIndices.length === 0) return;
    for (const index of staleIndices) {
      dispatchTab({ type: "close", index });
    }
  }, [tabState.tabs]);

  const handleReorderVisibleTabs = useCallback((fromIndex: number, toIndex: number) => {
    dispatchTab({
      type: "reorderVisible",
      vpsId: activeVpsId,
      fromIndex,
      toIndex,
    });
  }, [activeVpsId]);

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        activeVpsId={activeVpsId}
        activeSessionId={activeTab?.sessionId ?? null}
        onSelectVps={handleSelectVps}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onSessionRenamed={handleSessionRenamed}
        onSessionTitleSync={handleSessionTitleSync}
        onSessionsLoaded={handleSessionsLoaded}
        onVpsDeleted={handleVpsDeleted}
        onNavigate={onNavigate}
        onLogout={onLogout}
        userEmail={userEmail}
        externalErrorMessage={sidebarErrorMessage}
        refreshSignal={combinedRefreshSignal}
        selectedVpsIdHint={selectedVpsIdHint}
      />
      {emptyInstallPrompt && activeVpsId ? (
        <ConfirmDialog
          title={`${emptyInstallPrompt.agentType} is not installed`}
          description={`Install ${emptyInstallPrompt.agentType} on the selected server and continue creating this session?`}
          details={(
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>chatcode will install the missing agent, wait for it to become available, and then retry session creation automatically.</p>
              <p>This is usually quick, but small hosts can take a minute or two.</p>
            </div>
          )}
          confirmLabel="Install and continue"
          onConfirm={async () => {
            setEmptyActionBusy(true);
            try {
              await installAgent(activeVpsId, emptyInstallPrompt.agentType);
              await waitForAgentInstalled(activeVpsId, emptyInstallPrompt.agentType);
              const res = await createSession(activeVpsId, {
                title: emptyInstallPrompt.title,
                agent_type: emptyInstallPrompt.agentType,
                workdir: emptyInstallPrompt.workdir,
              });
              dispatchTab({
                type: "open",
                tab: {
                  vpsId: activeVpsId,
                  sessionId: res.session_id,
                  title: buildSessionTabTitle(emptyInstallPrompt.title, emptyInstallPrompt.workdir),
                },
              });
              setSidebarErrorMessage("");
              setShowEmptyCreateMenu(false);
              setEmptyCreateWorkdir("new");
              setEmptyInstallPrompt(null);
            } finally {
              setEmptyActionBusy(false);
            }
          }}
          onCancel={() => setEmptyInstallPrompt(null)}
        />
      ) : null}

      {/* Main content */}
      <main id="app-terminal-shell" className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Tab bar */}
        {visibleTabs.length > 0 && (
          <div className="flex items-center border-b border-border bg-card">
            <div className="flex-1 flex items-center overflow-x-auto">
              {visibleTabs.map(({ tab, index }, visibleIndex) => (
                <div
                  key={`${tab.vpsId}-${tab.sessionId}`}
                  draggable
                  className={cn(
                    "group flex items-center gap-1.5 px-3 py-2 text-sm border-r border-border cursor-pointer transition-colors min-w-0 max-w-[200px]",
                    draggingVisibleIndex === visibleIndex && "opacity-60",
                    index === effectiveActiveIndex
                      ? "bg-background text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50 font-normal",
                  )}
                  onClick={() => dispatchTab({ type: "setActive", index })}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(visibleIndex));
                    setDraggingVisibleIndex(visibleIndex);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const raw = event.dataTransfer.getData("text/plain");
                    const fromIndex = Number.parseInt(raw, 10);
                    if (!Number.isNaN(fromIndex)) {
                      handleReorderVisibleTabs(fromIndex, visibleIndex);
                    }
                    setDraggingVisibleIndex(null);
                  }}
                  onDragEnd={() => setDraggingVisibleIndex(null)}
                >
                  <Terminal className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-xs">{tab.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(index);
                    }}
                    className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Terminal area */}
        <div className="flex-1 relative bg-[#111111] dark:bg-[#111111]">
          {tabState.tabs.map((tab, i) => (
            <TerminalView
              key={`${tab.vpsId}-${tab.sessionId}`}
              vpsId={tab.vpsId}
              sessionId={tab.sessionId}
              active={i === effectiveActiveIndex}
              suspended={overlayOpen}
              onSessionEnded={handleSessionEnded}
              onSessionStateRefreshNeeded={handleSessionStateRefreshNeeded}
            />
          ))}

          {visibleTabs.length === 0 && (
            <div className="absolute inset-0 z-10 bg-[#111111] dark:bg-[#111111]">
              <EmptyState
                onNavigate={onNavigate}
                selectedVpsId={activeVpsId}
                onCreateSession={() => setShowEmptyCreateMenu((value) => !value)}
                onCreateAgentSession={handleCreateSessionFromEmpty}
                creatingSession={emptyActionBusy}
                showCreateMenu={showEmptyCreateMenu}
                createWorkdir={emptyCreateWorkdir}
                onChangeWorkdir={setEmptyCreateWorkdir}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function loadPersistedAppState(): PersistedAppState {
  if (typeof window === "undefined") {
    return {
      activeVpsId: null,
      tabState: { tabs: [], activeIndex: 0 },
    };
  }
  try {
    const raw = window.sessionStorage.getItem(APP_PAGE_STATE_KEY);
    if (!raw) {
      return {
        activeVpsId: null,
        tabState: { tabs: [], activeIndex: 0 },
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedAppState>;
    const tabs = Array.isArray(parsed.tabState?.tabs)
      ? parsed.tabState.tabs.filter(isOpenTab)
      : [];
    const activeIndex =
      typeof parsed.tabState?.activeIndex === "number" &&
      parsed.tabState.activeIndex >= 0 &&
      parsed.tabState.activeIndex < tabs.length
        ? parsed.tabState.activeIndex
        : 0;
    return {
      activeVpsId: typeof parsed.activeVpsId === "string" ? parsed.activeVpsId : null,
      tabState: {
        tabs,
        activeIndex,
      },
    };
  } catch {
    return {
      activeVpsId: null,
      tabState: { tabs: [], activeIndex: 0 },
    };
  }
}

function persistAppState(state: PersistedAppState) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(APP_PAGE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures; restore is best-effort.
  }
}

function isOpenTab(value: unknown): value is OpenTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.vpsId === "string" &&
    typeof tab.sessionId === "string" &&
    typeof tab.title === "string"
  );
}

function EmptyState({
  onNavigate,
  selectedVpsId,
  onCreateSession,
  onCreateAgentSession,
  creatingSession,
  showCreateMenu,
  createWorkdir,
  onChangeWorkdir,
}: {
  onNavigate: (page: "onboarding") => void;
  selectedVpsId: string | null;
  onCreateSession: () => void;
  onCreateAgentSession: (agent: AgentType) => void;
  creatingSession: boolean;
  showCreateMenu: boolean;
  createWorkdir: string;
  onChangeWorkdir: (value: string) => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="text-center space-y-4 max-w-sm">
        <Terminal className="h-12 w-12 mx-auto text-muted-foreground/30" />
        {selectedVpsId ? (
          <>
            <h2 className="text-lg font-medium text-muted-foreground">
              No active sessions
            </h2>
            <p className="text-sm text-muted-foreground/70">
              Selected server: <code>{selectedVpsId}</code>. Create a session to start coding.
            </p>
            <button
              data-testid="empty-create-session-button"
              onClick={onCreateSession}
              disabled={creatingSession}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              {creatingSession ? "Creating..." : "New Session"}
            </button>
            {showCreateMenu && (
              <div className="mx-auto w-64 text-left">
                <SessionCreatePicker
                  workdir={createWorkdir}
                  onWorkdirChange={onChangeWorkdir}
                  onCreate={onCreateAgentSession}
                  creating={creatingSession}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <h2 className="text-lg font-medium text-muted-foreground">
              Welcome to chatcode.dev
            </h2>
            <p className="text-sm text-muted-foreground/70">
              Set up a VPS to get started with AI-powered terminal sessions.
            </p>
            <button
              onClick={() => onNavigate("onboarding")}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Set up your server
            </button>
          </>
        )}
      </div>
    </div>
  );
}
