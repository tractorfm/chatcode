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
  let mountEl: HTMLDivElement | null = null;
  let inputDisposable: { dispose: () => void } | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let fitFrameA: number | null = null;
  let fitFrameB: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let windowResizeHandler: (() => void) | null = null;
  let awaitingInitialSnapshot = false;
  let initialResizeRequestId: string | null = null;
  let initialSnapshotRequested = false;
  let initialSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let initialSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let correctiveSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let ackFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCols = 0;
  let lastRows = 0;
  let pendingAckSessionId: string | null = null;
  let pendingAckSeq: number | null = null;
  let suppressResizeEvent = false;
  let reconnectAttempts = 0;
  let sessionEnded = false;
  let disposed = false;
  let interactive = opts.interactive !== false;
  const debugTerminal =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.search.includes("debugTerm=1"));

  function debugLog(event: string, detail: Record<string, unknown> = {}) {
    if (!debugTerminal) return;
    const rect = mountEl?.getBoundingClientRect();
    console.info("[terminal-debug]", {
      event,
      vpsId,
      sessionId,
      termCols: term.cols,
      termRows: term.rows,
      mountRect: rect
        ? {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
      ...detail,
    });
  }

  function sendJSON(msg: Record<string, unknown>) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  function sendResize(cols: number, rows: number, reason = "unknown"): string | null {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      debugLog("defer-resize-no-socket", { reason, cols, rows });
      return null;
    }
    if (cols === lastCols && rows === lastRows) {
      debugLog("skip-resize", { reason, cols, rows });
      return null;
    }
    lastCols = cols;
    lastRows = rows;
    const reqId = requestId("resize");
    debugLog("send-resize", { reason, cols, rows });
    sendJSON({
      type: "session.resize",
      schema_version: "1",
      request_id: reqId,
      session_id: sessionId,
      cols,
      rows,
    });
    return reqId;
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

  function requestSnapshot(reason: string) {
    initialSnapshotRequested = true;
    debugLog("send-snapshot", { reason });
    sendJSON({
      type: "session.snapshot",
      schema_version: "1",
      request_id: requestId("snapshot"),
      session_id: sessionId,
    });
  }

  function flushPendingAck(reason = "timer") {
    if (ackFlushTimer) {
      clearTimeout(ackFlushTimer);
      ackFlushTimer = null;
    }
    if (!pendingAckSessionId || pendingAckSeq === null) return;
    debugLog("flush-ack", { reason, ackSessionId: pendingAckSessionId, ackSeq: pendingAckSeq });
    sendJSON({
      type: "session.ack",
      schema_version: "1",
      request_id: requestId("ack"),
      session_id: pendingAckSessionId,
      seq: pendingAckSeq,
    });
    pendingAckSessionId = null;
    pendingAckSeq = null;
  }

  function queueAck(ackSessionId: string, seq: number) {
    pendingAckSessionId = ackSessionId;
    pendingAckSeq = pendingAckSeq === null ? seq : Math.max(pendingAckSeq, seq);
    if (ackFlushTimer) return;
    ackFlushTimer = setTimeout(() => flushPendingAck("batched"), 75);
  }

  function getViewportMetrics() {
    const termElement = term.element;
    const parentElement = termElement?.parentElement;
    if (!termElement || !parentElement) return null;

    const elementStyle = window.getComputedStyle(termElement);
    const paddingLeft = Number.parseFloat(elementStyle.getPropertyValue("padding-left")) || 0;
    const paddingRight = Number.parseFloat(elementStyle.getPropertyValue("padding-right")) || 0;
    const scrollbarWidth =
      term.options.scrollback === 0
        ? 0
        : (term.options.overviewRuler?.width ?? 14);
    const host = mountEl?.querySelector(".xterm-viewport");
    const hostWidth =
      host instanceof HTMLElement
        ? host.clientWidth
        : mountEl?.clientWidth ?? parentElement.clientWidth;
    const availableWidth = Math.max(
      0,
      Math.min(parentElement.clientWidth - paddingLeft - paddingRight - scrollbarWidth, hostWidth),
    );

    const core = (term as Terminal & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              canvas?: { width?: number };
              cell?: { width?: number };
            };
          };
        };
      };
    })._core;
    const renderDimensions = core?._renderService?.dimensions?.css;
    const canvasWidth = renderDimensions?.canvas?.width ?? 0;
    const cellWidth = renderDimensions?.cell?.width ?? 0;

    return {
      availableWidth,
      canvasWidth,
      cellWidth,
    };
  }

  function clampColsToViewport(reason: string) {
    const metrics = getViewportMetrics();
    if (!metrics || metrics.availableWidth <= 0 || metrics.cellWidth <= 0) return;

    let cols = term.cols || 80;
    const rows = term.rows || 24;
    let adjusted = false;
    let canvasWidth = Math.ceil(metrics.canvasWidth);
    const maxCols = Math.max(2, Math.floor(metrics.availableWidth / metrics.cellWidth));

    if (maxCols < cols) {
      adjusted = true;
      cols = maxCols;
      suppressResizeEvent = true;
      try {
        term.resize(cols, rows);
      } finally {
        suppressResizeEvent = false;
      }
    }

    let latestMetrics = getViewportMetrics();
    if (!latestMetrics) return;
    canvasWidth = Math.ceil(latestMetrics.canvasWidth);

    while (cols > 2 && canvasWidth > latestMetrics.availableWidth + 1) {
      adjusted = true;
      cols -= 1;
      suppressResizeEvent = true;
      try {
        term.resize(cols, rows);
      } finally {
        suppressResizeEvent = false;
      }
      latestMetrics = getViewportMetrics();
      if (!latestMetrics) break;
      canvasWidth = Math.ceil(latestMetrics.canvasWidth);
    }

    if (adjusted && latestMetrics) {
      debugLog("fit-clamp-cols", {
        reason,
        cols,
        rows,
        availableWidth: Math.round(latestMetrics.availableWidth),
        canvasWidth,
        cellWidth: Number(latestMetrics.cellWidth.toFixed(2)),
      });
    }
  }

  function scheduleFit(
    reason = "unknown",
    afterFit?: (cols: number, rows: number, resizeReqId: string | null) => void,
  ) {
    if (fitTimer) clearTimeout(fitTimer);
    if (fitFrameA !== null) cancelAnimationFrame(fitFrameA);
    if (fitFrameB !== null) cancelAnimationFrame(fitFrameB);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (disposed) return;
      fitFrameA = requestAnimationFrame(() => {
        fitFrameA = null;
        fitFrameB = requestAnimationFrame(() => {
          fitFrameB = null;
          if (disposed) return;
          try {
            fitAddon.fit();
          } catch {
            /* ignore */
          }
          clampColsToViewport(reason);
          const cols = term.cols || 80;
          const rows = term.rows || 24;
          debugLog("fit", { reason, cols, rows });
          const resizeReqId = sendResize(cols, rows, reason);
          afterFit?.(cols, rows, resizeReqId);
        });
      });
    }, 0);
  }

  function scheduleCorrectiveSnapshot(reason: string, delayMs = 75) {
    if (correctiveSnapshotTimer) clearTimeout(correctiveSnapshotTimer);
    correctiveSnapshotTimer = setTimeout(() => {
      correctiveSnapshotTimer = null;
      if (disposed || !socket || socket.readyState !== WebSocket.OPEN) return;
      initialSnapshotRequested = false;
      requestSnapshot(reason);
    }, delayMs);
  }

  function schedulePostResizeSnapshot(reason: string, delayMs = 500) {
    if (awaitingInitialSnapshot) return;
    if (resizeSnapshotTimer) clearTimeout(resizeSnapshotTimer);
    resizeSnapshotTimer = setTimeout(() => {
      resizeSnapshotTimer = null;
      if (disposed || !socket || socket.readyState !== WebSocket.OPEN) return;
      requestSnapshot(reason);
    }, delayMs);
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
      lastCols = 0;
      lastRows = 0;
      debugLog("ws-open");
      if (interactive) {
        term.focus();
      }

      inputDisposable?.dispose();
      inputDisposable = term.onData((data) => sendInput(data));

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => sendJSON({ type: "ping" }), 20000);

      // Initial attach state machine:
      // 1. fit terminal and send resize
      // 2. wait for resize ack when possible
      // 3. request first snapshot
      // 4. allow one corrective snapshot only during this initial window
      awaitingInitialSnapshot = true;
      initialResizeRequestId = null;
      initialSnapshotRequested = false;
      if (initialSnapshotTimer) clearTimeout(initialSnapshotTimer);
      initialSnapshotTimer = setTimeout(() => {
        initialSnapshotTimer = null;
        awaitingInitialSnapshot = false;
        initialResizeRequestId = null;
      }, 1500);

      if (initialSnapshotRetryTimer) {
        clearTimeout(initialSnapshotRetryTimer);
        initialSnapshotRetryTimer = null;
      }

      scheduleFit("ws-open", (_cols, _rows, resizeReqId) => {
        if (disposed || ws !== socket) return;
        if (resizeReqId) {
          initialResizeRequestId = resizeReqId;
          return;
        }
        requestSnapshot("initial-post-fit");
      });

      initialSnapshotRetryTimer = setTimeout(() => {
        if (disposed || ws !== socket || !awaitingInitialSnapshot) return;
        scheduleFit("initial-retry", (_cols, _rows, resizeReqId) => {
          if (disposed || ws !== socket || !awaitingInitialSnapshot) return;
          if (resizeReqId) {
            initialResizeRequestId = resizeReqId;
            return;
          }
          if (!initialSnapshotRequested) {
            requestSnapshot("initial-retry");
          }
        });
      }, 250);
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
          msg.type === "ack" &&
          msg.ok !== false &&
          awaitingInitialSnapshot &&
          typeof msg.request_id === "string" &&
          msg.request_id === initialResizeRequestId
        ) {
          initialResizeRequestId = null;
          if (!initialSnapshotRequested) {
            requestSnapshot("after-initial-resize-ack");
          }
          return;
        }

        if (
          msg.type === "session.snapshot" &&
          msg.session_id === sessionId &&
          typeof msg.content === "string"
        ) {
          const snapshotCols = typeof msg.cols === "number" ? msg.cols : null;
          const snapshotRows =
            typeof msg.rows === "number" && msg.rows > 0 ? msg.rows : null;
          const rowsHint =
            snapshotRows ?? 80;
          const normalized = msg.content
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          const lines = normalized.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const tail = lines.slice(-rowsHint).join("\r\n");
          debugLog("recv-snapshot", {
            cols: typeof msg.cols === "number" ? msg.cols : null,
            rows: rowsHint,
            cursorX: typeof msg.cursor_x === "number" ? msg.cursor_x : null,
            cursorY: typeof msg.cursor_y === "number" ? msg.cursor_y : null,
          });
          term.reset();
          term.write(tail);

          if (
            typeof msg.cursor_x === "number" &&
            typeof msg.cursor_y === "number"
          ) {
            const col = Math.max(0, Math.floor(msg.cursor_x as number)) + 1;
            const row = Math.max(0, Math.floor(msg.cursor_y as number)) + 1;
            term.write(`\x1b[${row};${col}H`);
          }
          if (msg.cursor_visible === false) term.write("\x1b[?25l");
          else if (msg.cursor_visible === true) term.write("\x1b[?25h");

          const inInitialSnapshotFlow = awaitingInitialSnapshot;
          const bootstrapMismatch =
            inInitialSnapshotFlow &&
            snapshotCols === 80 &&
            snapshotRows === 24 &&
            lastCols > 0 &&
            lastRows > 0 &&
            (lastCols !== 80 || lastRows !== 24);
          if (bootstrapMismatch) {
            debugLog("render-bootstrap-snapshot-then-correct", {
              snapshotCols,
              snapshotRows,
              expectedCols: lastCols,
              expectedRows: lastRows,
            });
            scheduleCorrectiveSnapshot("correct-bootstrap-mismatch");
          }

          const looksBlank =
            inInitialSnapshotFlow &&
            lines.length > 0 &&
            lines.every((line) => line.trim().length === 0) &&
            typeof msg.cursor_y === "number" &&
            Math.floor(msg.cursor_y as number) === 0;
          if (looksBlank) {
            debugLog("render-blank-snapshot-then-correct", {
              snapshotCols,
              snapshotRows,
            });
            scheduleCorrectiveSnapshot("correct-blank-snapshot", 125);
          }

          awaitingInitialSnapshot = false;
          initialResizeRequestId = null;
          initialSnapshotRequested = false;
          if (initialSnapshotTimer) {
            clearTimeout(initialSnapshotTimer);
            initialSnapshotTimer = null;
          }
          if (initialSnapshotRetryTimer) {
            clearTimeout(initialSnapshotRetryTimer);
            initialSnapshotRetryTimer = null;
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

        if (awaitingInitialSnapshot) {
          queueAck(frame.sessionId, Number(frame.seq));
          return;
        }
        const text = new TextDecoder().decode(frame.payload);
        term.write(text);
        queueAck(frame.sessionId, Number(frame.seq));
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
      if (ackFlushTimer) {
        clearTimeout(ackFlushTimer);
        ackFlushTimer = null;
      }
      pendingAckSessionId = null;
      pendingAckSeq = null;
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

  term.onResize(({ cols, rows }) => {
    if (suppressResizeEvent) return;
    debugLog("term-onResize", { cols, rows });
    const resizeReqId = sendResize(cols, rows, "term.onResize");
    if (resizeReqId) {
      schedulePostResizeSnapshot("post-resize-reconcile");
    }
  });

  const handle: TerminalHandle = {
    mount(el: HTMLDivElement) {
      mountEl = el;
      windowResizeHandler = () => scheduleFit("window-resize");
      term.open(el);
      debugLog("mount");
      scheduleFit("mount");
      setTimeout(() => scheduleFit("mount-120"), 120);
      if (document.fonts?.ready) {
        document.fonts.ready.then(() => scheduleFit("fonts-ready")).catch(() => {});
      }
      window.addEventListener("resize", windowResizeHandler);
      resizeObserver = new ResizeObserver(() => scheduleFit("resize-observer"));
      resizeObserver.observe(el);
      connect();
    },
    fit: () => scheduleFit("handle.fit"),
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
      if (fitFrameA !== null) cancelAnimationFrame(fitFrameA);
      if (fitFrameB !== null) cancelAnimationFrame(fitFrameB);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (initialSnapshotTimer) clearTimeout(initialSnapshotTimer);
      if (initialSnapshotRetryTimer) clearTimeout(initialSnapshotRetryTimer);
      if (correctiveSnapshotTimer) clearTimeout(correctiveSnapshotTimer);
      if (resizeSnapshotTimer) clearTimeout(resizeSnapshotTimer);
      if (ackFlushTimer) clearTimeout(ackFlushTimer);
      if (socket) {
        try {
          socket.close(1000, "disposed");
        } catch {
          /* ignore */
        }
      }
      pendingAckSessionId = null;
      pendingAckSeq = null;
      if (windowResizeHandler) {
        window.removeEventListener("resize", windowResizeHandler);
        windowResizeHandler = null;
      }
      resizeObserver?.disconnect();
      mountEl = null;
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
