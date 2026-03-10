import { memo, useEffect, useMemo } from "react";
import { useTerminalRef } from "@/hooks/use-terminal";
import { getStoredTerminalTheme, terminalThemes } from "@/lib/themes";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  vpsId: string;
  sessionId: string;
  active: boolean;
  suspended?: boolean;
  onSessionEnded?: (sessionId: string) => void;
  onSessionError?: (sessionId: string, error: string) => void;
  onSessionStateRefreshNeeded?: (sessionId: string) => void;
}

export const TerminalView = memo(function TerminalView({
  vpsId,
  sessionId,
  active,
  suspended = false,
  onSessionEnded,
  onSessionError,
  onSessionStateRefreshNeeded,
}: TerminalViewProps) {
  const themeName = getStoredTerminalTheme();
  const terminalBackground =
    terminalThemes[themeName]?.background ?? terminalThemes.default.background ?? "#111111";
  const opts = useMemo(
    () => ({
      vpsId,
      sessionId,
      interactive: active && !suspended,
      onSessionEnded,
      onSessionError,
      onSessionStateRefreshNeeded,
    }),
    [vpsId, sessionId, active, suspended, onSessionEnded, onSessionError, onSessionStateRefreshNeeded],
  );

  const { containerRef, handleRef } = useTerminalRef(opts);

  useEffect(() => {
    if (!active || suspended || !handleRef.current) return;
    const timer = setTimeout(() => {
      handleRef.current?.fit();
      handleRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [active, suspended, sessionId, vpsId, handleRef]);

  return (
    <div
      data-testid={`terminal-${sessionId}`}
      className="terminal-shell absolute inset-0 p-2"
      style={{
        backgroundColor: terminalBackground,
        visibility: active ? "visible" : "hidden",
        opacity: active ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
      }}
      aria-hidden={!active}
    >
      <div
        ref={containerRef}
        className="terminal-container h-full w-full"
      />
    </div>
  );
});
