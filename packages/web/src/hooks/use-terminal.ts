import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { decodeTerminalFrame } from "@chatcode/protocol";
import { wsUrl, requestId, utf8ToBase64 } from "@/lib/constants";
import { terminalThemes, getStoredTerminalTheme } from "@/lib/themes";
import type { ITheme } from "@xterm/xterm";

export interface UseTerminalOptions {
  vpsId: string;
  sessionId: string;
  interactive?: boolean;
  onSessionEnded?: (sessionId: string) => void;
  onSessionError?: (sessionId: string, error: string) => void;
  onSessionStateRefreshNeeded?: (sessionId: string) => void;
}

export interface TerminalHandle {
  /** Attach terminal to a DOM element. Call once. */
  mount: (el: HTMLDivElement) => void;
  /** Fit terminal to container. */
  fit: () => void;
  /** Change terminal theme. */
  setTheme: (theme: ITheme) => void;
  /** Disconnect and clean up. */
  dispose: () => void;
  /** Focus terminal. */
  focus: () => void;
  /** Enable or suppress terminal focus/input affordances. */
  setInteractive: (interactive: boolean) => void;
}

export function createTerminalHandle(opts: UseTerminalOptions): TerminalHandle {
  const {
    vpsId,
    sessionId,
    onSessionEnded,
    onSessionError,
    onSessionStateRefreshNeeded,
  } = opts;

  const themeName = getStoredTerminalTheme();
  const term = new Terminal({
    cursorBlink: false,
    convertEol: true,
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    scrollback: 50000,
    theme: terminalThemes[themeName] ?? terminalThemes.default,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  let socket: WebSocket | null = null;
  let inputDisposable: { dispose: () => void } | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let awaitingInitialSnapshot = false;
  let initialSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCols = 0;
  let lastRows = 0;
  let reconnectAttempts = 0;
  let sessionEnded = false;
  let disposed = false;
  let interactive = opts.interactive !== false;

  function sendJSON(msg: Record<string, unknown>) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  function sendResize(cols: number, rows: number) {
    if (cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    sendJSON({
      type: "session.resize",
      schema_version: "1",
      request_id: requestId("resize"),
      session_id: sessionId,
      cols,
      rows,
    });
  }

  function sendInput(data: string) {
    if (!data) return;
    sendJSON({
      type: "session.input",
      schema_version: "1",
      request_id: requestId("input"),
      session_id: sessionId,
      data: utf8ToBase64(data),
    });
  }

  function requestSnapshot() {
    sendJSON({
      type: "session.snapshot",
      schema_version: "1",
      request_id: requestId("snapshot"),
      session_id: sessionId,
    });
  }

  function scheduleFit() {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
      sendResize(term.cols || 80, term.rows || 24);
    }, 16);
  }

  function scheduleInitialFits() {
    scheduleFit();
    window.setTimeout(scheduleFit, 80);
    window.setTimeout(scheduleFit, 220);
    window.setTimeout(scheduleFit, 500);
  }

  // Arrow key handler: force application cursor sequences for curses apps
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    if (event.altKey || event.ctrlKey || event.metaKey) return true;
    if (!socket || socket.readyState !== WebSocket.OPEN) return true;
    const appArrowMap: Record<string, string> = {
      ArrowUp: "\x1bOA",
      ArrowDown: "\x1bOB",
      ArrowRight: "\x1bOC",
      ArrowLeft: "\x1bOD",
    };
    const seq = appArrowMap[event.key];
    if (!seq) return true;
    sendInput(seq);
    return false;
  });

  function connect() {
    if (disposed) return;
    const path = `/vps/${encodeURIComponent(vpsId)}/terminal?session_id=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl(path));
    socket = ws;
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      if (ws !== socket) return;
      reconnectAttempts = 0;
      scheduleInitialFits();
      if (interactive) {
        term.focus();
      }

      inputDisposable?.dispose();
      inputDisposable = term.onData((data) => sendInput(data));

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => sendJSON({ type: "ping" }), 20000);

      // Request initial snapshot
      awaitingInitialSnapshot = true;
      if (initialSnapshotTimer) clearTimeout(initialSnapshotTimer);
      initialSnapshotTimer = setTimeout(() => {
        initialSnapshotTimer = null;
        awaitingInitialSnapshot = false;
      }, 1500);

      sendResize(term.cols || 80, term.rows || 24);
      window.setTimeout(() => {
        if (!disposed && ws === socket) requestSnapshot();
      }, 80);
      window.setTimeout(() => {
        if (!disposed && ws === socket && awaitingInitialSnapshot) {
          scheduleFit();
          requestSnapshot();
        }
      }, 320);
      // Late reconciliation pass: if tmux resized after the first snapshot,
      // force one more snapshot so first paint matches the fitted viewport.
      window.setTimeout(() => {
        if (!disposed && ws === socket) {
          scheduleFit();
          requestSnapshot();
        }
      }, 900);
    });

    ws.addEventListener("message", (event) => {
      if (ws !== socket) return;

      if (typeof event.data === "string") {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "ack" && msg.ok === false) {
          term.writeln(`\r\n[error] ${msg.error ?? "command failed"}`);
          return;
        }

        if (
          msg.type === "session.snapshot" &&
          msg.session_id === sessionId &&
          typeof msg.content === "string"
        ) {
          const rowsHint =
            typeof msg.rows === "number" && msg.rows > 0 ? msg.rows : 80;
          const targetRows = Math.max(rowsHint, term.rows || rowsHint);
          const normalized = msg.content
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          const lines = normalized.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const tail = lines.slice(-targetRows).join("\r\n");
          term.reset();
          term.write(tail);

          if (
            typeof msg.cursor_x === "number" &&
            typeof msg.cursor_y === "number"
          ) {
            const col = Math.max(0, Math.floor(msg.cursor_x as number)) + 1;
            const rowShift = Math.max(0, targetRows - rowsHint);
            const rowRaw = Math.max(0, Math.floor(msg.cursor_y as number)) + 1 + rowShift;
            const row = Math.min(Math.max(1, rowRaw), Math.max(1, targetRows));
            term.write(`\x1b[${row};${col}H`);
          }
          if (msg.cursor_visible === false) term.write("\x1b[?25l");
          else if (msg.cursor_visible === true) term.write("\x1b[?25h");

          awaitingInitialSnapshot = false;
          scheduleFit();
          if (initialSnapshotTimer) {
            clearTimeout(initialSnapshotTimer);
            initialSnapshotTimer = null;
          }
          return;
        }

        if (msg.type === "session.error" && msg.session_id === sessionId) {
          term.writeln(`\r\n[session error] ${msg.error ?? "unknown"}`);
          onSessionError?.(sessionId, String(msg.error ?? "unknown"));
          return;
        }

        if (msg.type === "session.ended" && msg.session_id === sessionId) {
          sessionEnded = true;
          term.writeln("\r\n[session ended]");
          onSessionEnded?.(sessionId);
          onSessionStateRefreshNeeded?.(sessionId);
          return;
        }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(event.data);
        const frame = decodeTerminalFrame(buf);
        if (!frame || frame.kind !== 0x01) return;
        if (frame.sessionId !== sessionId) return;

        const sendAck = () => {
          sendJSON({
            type: "session.ack",
            schema_version: "1",
            request_id: requestId("ack"),
            session_id: frame.sessionId,
            seq: Number(frame.seq),
          });
        };

        if (awaitingInitialSnapshot) {
          sendAck();
          return;
        }
        const text = new TextDecoder().decode(frame.payload);
        term.write(text);
        sendAck();
      }
    });

    ws.addEventListener("close", (ev) => {
      if (ws !== socket) return;
      inputDisposable?.dispose();
      inputDisposable = null;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      const reason = ev.reason ? ` reason=${ev.reason}` : "";
      term.writeln(`\r\n[disconnected code=${ev.code}${reason}]`);
      socket = null;
      onSessionStateRefreshNeeded?.(sessionId);

      if (disposed || sessionEnded || ev.code === 1000) return;
      if (reconnectTimer) return;

      const backoffSec = Math.min(2 ** reconnectAttempts, 10);
      reconnectAttempts += 1;
      term.writeln(`\r\n[reconnecting in ${backoffSec}s]`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, backoffSec * 1000);
    });

    ws.addEventListener("error", () => {
      if (ws !== socket) return;
      term.writeln("\r\n[connection error]");
    });
  }

  term.onResize(({ cols, rows }) => sendResize(cols, rows));

  const handle: TerminalHandle = {
    mount(el: HTMLDivElement) {
      term.open(el);
      scheduleInitialFits();
      if (document.fonts?.ready) {
        document.fonts.ready.then(() => scheduleInitialFits()).catch(() => {});
      }
      window.addEventListener("resize", scheduleFit);
      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(el);
      connect();
    },
    fit: scheduleFit,
    setTheme(theme: ITheme) {
      term.options.theme = theme;
    },
    setInteractive(nextInteractive: boolean) {
      interactive = nextInteractive;
      if (!interactive) {
        term.blur();
      }
    },
    dispose() {
      disposed = true;
      inputDisposable?.dispose();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (fitTimer) clearTimeout(fitTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (initialSnapshotTimer) clearTimeout(initialSnapshotTimer);
      if (socket) {
        try {
          socket.close(1000, "disposed");
        } catch {
          /* ignore */
        }
      }
      window.removeEventListener("resize", scheduleFit);
      resizeObserver?.disconnect();
      term.dispose();
    },
    focus() {
      if (interactive) {
        term.focus();
      }
    },
  };

  return handle;
}

/** React hook that manages a terminal handle's lifecycle. */
export function useTerminalRef(opts: UseTerminalOptions | null) {
  const handleRef = useRef<TerminalHandle | null>(null);

  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      // Clean up previous
      if (handleRef.current) {
        handleRef.current.dispose();
        handleRef.current = null;
      }
      if (!el || !opts) return;
      const handle = createTerminalHandle(opts);
      handle.mount(el);
      handleRef.current = handle;
    },
    // Re-create when session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts?.vpsId, opts?.sessionId],
  );

  useEffect(() => {
    handleRef.current?.setInteractive(opts?.interactive !== false);
  }, [opts?.interactive]);

  useEffect(() => {
    return () => {
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  return { containerRef, handleRef };
}
