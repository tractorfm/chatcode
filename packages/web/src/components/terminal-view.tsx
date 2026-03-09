import { memo, useEffect, useMemo } from "react";
import { useTerminalRef } from "@/hooks/use-terminal";
import "@xterm/xterm/css/xterm.css";

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

  useEffect(() => {
    if (!active || !handleRef.current) return;
    const timer = setTimeout(() => {
      handleRef.current?.fit();
      handleRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [active, sessionId, vpsId, handleRef]);

  return (
    <div
      ref={containerRef}
      className="terminal-container absolute inset-0"
      style={{ display: active ? "block" : "none" }}
    />
  );
});
