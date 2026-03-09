import { useCallback, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { TerminalView } from "@/components/terminal-view";
import { X, Plus, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function AppPage({ userEmail, onLogout, onNavigate }: AppPageProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeVpsId, setActiveVpsId] = useState<string | null>(null);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [tabs, setTabs] = useState<OpenTab[]>([]);

  const handleSelectVps = useCallback((vpsId: string) => {
    setActiveVpsId(vpsId);
  }, []);

  const handleSelectSession = useCallback(
    (vpsId: string, sessionId: string) => {
      // Check if tab already open
      const existingIdx = tabs.findIndex(
        (t) => t.vpsId === vpsId && t.sessionId === sessionId,
      );
      if (existingIdx >= 0) {
        setActiveTabIndex(existingIdx);
        return;
      }
      // Open new tab
      const newTab: OpenTab = {
        vpsId,
        sessionId,
        title: `Session ${tabs.length + 1}`,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabIndex(tabs.length);
    },
    [tabs],
  );

  const handleNewSession = useCallback(
    (vpsId: string, sessionId: string) => {
      const newTab: OpenTab = {
        vpsId,
        sessionId,
        title: `Session ${tabs.length + 1}`,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabIndex(tabs.length);
      setActiveVpsId(vpsId);
    },
    [tabs.length],
  );

  const handleCloseTab = useCallback(
    (index: number) => {
      setTabs((prev) => prev.filter((_, i) => i !== index));
      if (activeTabIndex >= index && activeTabIndex > 0) {
        setActiveTabIndex((prev) => prev - 1);
      }
    },
    [activeTabIndex],
  );

  const handleSessionEnded = useCallback(
    (sessionId: string) => {
      // Mark the tab but don't auto-close it
      setTabs((prev) =>
        prev.map((t) =>
          t.sessionId === sessionId ? { ...t, title: t.title + " (ended)" } : t,
        ),
      );
    },
    [],
  );

  const activeTab = tabs[activeTabIndex] ?? null;

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
        onNavigate={onNavigate}
        onLogout={onLogout}
        userEmail={userEmail}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        {tabs.length > 0 && (
          <div className="flex items-center border-b border-border bg-card">
            <div className="flex-1 flex items-center overflow-x-auto">
              {tabs.map((tab, i) => (
                <div
                  key={`${tab.vpsId}-${tab.sessionId}`}
                  className={cn(
                    "group flex items-center gap-1.5 px-3 py-2 text-sm border-r border-border cursor-pointer transition-colors min-w-0 max-w-[200px]",
                    i === activeTabIndex
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  )}
                  onClick={() => setActiveTabIndex(i)}
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
          {tabs.length === 0 ? (
            <EmptyState onNavigate={onNavigate} hasVps={!!activeVpsId} />
          ) : (
            tabs.map((tab, i) => (
              <TerminalView
                key={`${tab.vpsId}-${tab.sessionId}`}
                vpsId={tab.vpsId}
                sessionId={tab.sessionId}
                active={i === activeTabIndex}
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
  hasVps,
}: {
  onNavigate: (page: "onboarding") => void;
  hasVps: boolean;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="text-center space-y-4 max-w-sm">
        <Terminal className="h-12 w-12 mx-auto text-muted-foreground/30" />
        {hasVps ? (
          <>
            <h2 className="text-lg font-medium text-muted-foreground">
              No active sessions
            </h2>
            <p className="text-sm text-muted-foreground/70">
              Create a new session from the sidebar to start coding.
            </p>
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
