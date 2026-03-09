import { memo, useMemo } from "react";
import { useTerminalRef } from "@/hooks/use-terminal";
import "../../node_modules/@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  vpsId: string;
  sessionId: string;
  active: boolean;
  onSessionEnded?: (sessionId: string) => void;
  onSessionError?: (sessionId: string, error: string) => void;
}

export const TerminalView = memo(function TerminalView({
  vpsId,
  sessionId,
  active,
  onSessionEnded,
  onSessionError,
}: TerminalViewProps) {
  const opts = useMemo(
    () => ({ vpsId, sessionId, onSessionEnded, onSessionError }),
    [vpsId, sessionId, onSessionEnded, onSessionError],
  );

  const { containerRef, handleRef } = useTerminalRef(opts);

  // When tab becomes active, trigger fit + focus
  if (active && handleRef.current) {
    // Use microtask to avoid calling during render
    queueMicrotask(() => {
      handleRef.current?.fit();
      handleRef.current?.focus();
    });
  }

  return (
    <div
      ref={containerRef}
      className="terminal-container absolute inset-0"
      style={{ display: active ? "block" : "none" }}
    />
  );
});
