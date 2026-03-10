import { useCallback, useMemo, useReducer, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { TerminalView } from "@/components/terminal-view";
import { X, Plus, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { createSession } from "@/lib/api";

interface AppPageProps {
  userEmail?: string;
  onLogout: () => void;
  onNavigate: (page: "settings" | "status" | "onboarding") => void;
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

type TabAction =
  | { type: "open"; tab: OpenTab }
  | { type: "close"; index: number }
  | { type: "setActive"; index: number }
  | { type: "markEnded"; sessionId: string }
  | { type: "rename"; sessionId: string; title: string };

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
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.sessionId === action.sessionId ? { ...t, title: action.title } : t,
        ),
      };
    default:
      return state;
  }
}

export function AppPage({ userEmail, onLogout, onNavigate }: AppPageProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeVpsId, setActiveVpsId] = useState<string | null>(null);
  const [sidebarErrorMessage, setSidebarErrorMessage] = useState("");
  const [tabState, dispatchTab] = useReducer(tabReducer, {
    tabs: [],
    activeIndex: 0,
  });
  const [emptyActionBusy, setEmptyActionBusy] = useState(false);

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

  const handleSessionRenamed = useCallback((sessionId: string, title: string) => {
    dispatchTab({ type: "rename", sessionId, title });
  }, []);

  const handleCreateSessionFromEmpty = useCallback(async () => {
    if (!activeVpsId || emptyActionBusy) return;
    setEmptyActionBusy(true);
    try {
      const res = await createSession(activeVpsId, {
        title: `Session ${tabState.tabs.length + 1}`,
        agent_type: "claude-code",
      });
      const title = `Session ${tabState.tabs.length + 1}`;
      dispatchTab({
        type: "open",
        tab: {
          vpsId: activeVpsId,
          sessionId: res.session_id,
          title,
        },
      });
      setSidebarErrorMessage("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unexpected error";
      setSidebarErrorMessage(`Failed to create session: ${detail}`);
    } finally {
      setEmptyActionBusy(false);
    }
  }, [activeVpsId, emptyActionBusy, tabState.tabs.length]);

  const activeTab = useMemo(
    () => tabState.tabs[tabState.activeIndex] ?? null,
    [tabState.activeIndex, tabState.tabs],
  );

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
        onNavigate={onNavigate}
        onLogout={onLogout}
        userEmail={userEmail}
        externalErrorMessage={sidebarErrorMessage}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        {tabState.tabs.length > 0 && (
          <div className="flex items-center border-b border-border bg-card">
            <div className="flex-1 flex items-center overflow-x-auto">
              {tabState.tabs.map((tab, i) => (
                <div
                  key={`${tab.vpsId}-${tab.sessionId}`}
                  className={cn(
                    "group flex items-center gap-1.5 px-3 py-2 text-sm border-r border-border cursor-pointer transition-colors min-w-0 max-w-[200px]",
                    i === tabState.activeIndex
                      ? "bg-background text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50 font-normal",
                  )}
                  onClick={() => dispatchTab({ type: "setActive", index: i })}
                >
                  <Terminal className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-xs">{tab.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(i);
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
          {tabState.tabs.length === 0 ? (
            <EmptyState
              onNavigate={onNavigate}
              selectedVpsId={activeVpsId}
              onCreateSession={handleCreateSessionFromEmpty}
              creatingSession={emptyActionBusy}
            />
          ) : (
            tabState.tabs.map((tab, i) => (
              <TerminalView
                key={`${tab.vpsId}-${tab.sessionId}`}
                vpsId={tab.vpsId}
                sessionId={tab.sessionId}
                active={i === tabState.activeIndex}
                onSessionEnded={handleSessionEnded}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState({
  onNavigate,
  selectedVpsId,
  onCreateSession,
  creatingSession,
}: {
  onNavigate: (page: "onboarding") => void;
  selectedVpsId: string | null;
  onCreateSession: () => void;
  creatingSession: boolean;
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
              {creatingSession ? "Creating..." : "Create Session"}
            </button>
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
