export const STAGING_TERMINAL_STYLE = `
    #terminal {
      width: 100%;
      min-width: 360px;
      min-height: 720px;
      height: 840px;
      border: 1px solid #222;
      background: #111;
      line-height: 1;
      overflow: hidden;
      box-sizing: border-box;
    }
`;

export const STAGING_TERMINAL_SECTION = `
  <div id="terminal-wrap" class="section" style="display:none">
    <h2>Terminal Stream (xterm.js)</h2>
    <div class="row">
      <label for="terminal-session-id">Session:</label>
      <input id="terminal-session-id" placeholder="session id" style="min-width: 280px" />
      <label for="terminal-theme">Theme:</label>
      <select id="terminal-theme">
        <option value="default">default</option>
        <option value="iterm2">iterm2</option>
        <option value="solarized-dark">solarized-dark</option>
        <option value="tango-dark">tango-dark</option>
      </select>
      <button id="terminal-connect">Connect</button>
      <button id="terminal-disconnect">Disconnect</button>
      <button id="terminal-snapshot">Snapshot</button>
      <button id="terminal-end">End Session</button>
    </div>
    <div class="muted" id="terminal-status">disconnected</div>
    <div id="terminal"></div>
  </div>
`;

export const STAGING_TERMINAL_COMPONENT_SCRIPT = `
  function createStagingTerminalComponent(config) {
    const terminalWrap = document.getElementById("terminal-wrap");
    const terminalNode = document.getElementById("terminal");
    const terminalSessionInput = document.getElementById("terminal-session-id");
    const terminalThemeSelect = document.getElementById("terminal-theme");
    const terminalStatus = document.getElementById("terminal-status");

    let term = null;
    let fitAddon = null;
    let termResizeObserver = null;
    let fitTimer = null;
    let termSocket = null;
    let termInputDisposable = null;
    let termKeepaliveTimer = null;
    let awaitingInitialSnapshot = false;
    let initialSnapshotTimer = null;
    let lastResizeCols = 0;
    let lastResizeRows = 0;
    let activeSessionId = "";
    const terminalMinHeightPx = Number(config.terminalMinHeightPx || 720);
    const terminalThemeStorageKey = "chatcode.staging.terminal.theme";
    const terminalThemes = {
      default: {
        background: "#111111",
        foreground: "#dddddd",
        cursor: "#e6e6e6",
        selectionBackground: "#35506b",
      },
      iterm2: {
        background: "#000000",
        foreground: "#c7c7c7",
        cursor: "#c7c7c7",
        selectionBackground: "#3f638b",
        black: "#000000",
        red: "#c91b00",
        green: "#00c200",
        yellow: "#c7c400",
        blue: "#0225c7",
        magenta: "#c930c7",
        cyan: "#00c5c7",
        white: "#c7c7c7",
        brightBlack: "#676767",
        brightRed: "#ff6d67",
        brightGreen: "#5ff967",
        brightYellow: "#fefb67",
        brightBlue: "#6871ff",
        brightMagenta: "#ff76ff",
        brightCyan: "#5ffdff",
        brightWhite: "#feffff",
      },
      "solarized-dark": {
        background: "#002b36",
        foreground: "#839496",
        cursor: "#93a1a1",
        selectionBackground: "#073642",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#002b36",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
      },
      "tango-dark": {
        background: "#000000",
        foreground: "#d3d7cf",
        cursor: "#d3d7cf",
        selectionBackground: "#204a87",
        black: "#2e3436",
        red: "#cc0000",
        green: "#4e9a06",
        yellow: "#c4a000",
        blue: "#3465a4",
        magenta: "#75507b",
        cyan: "#06989a",
        white: "#d3d7cf",
        brightBlack: "#555753",
        brightRed: "#ef2929",
        brightGreen: "#8ae234",
        brightYellow: "#fce94f",
        brightBlue: "#729fcf",
        brightMagenta: "#ad7fa8",
        brightCyan: "#34e2e2",
        brightWhite: "#eeeeec",
      },
    };

    function decodeTerminalFrame(data) {
      const buf = new Uint8Array(data);
      if (buf.length < 2) return null;
      const kind = buf[0];
      const sidLen = buf[1];
      if (buf.length < 2 + sidLen + 8) return null;
      const sidBytes = buf.slice(2, 2 + sidLen);
      const sessionId = new TextDecoder().decode(sidBytes);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const seq = Number(view.getBigUint64(2 + sidLen, false));
      const payload = buf.slice(2 + sidLen + 8);
      return { kind, sessionId, seq, payload };
    }

    function setTerminalStatus(text) {
      if (terminalStatus) terminalStatus.textContent = text;
    }

    function getStoredThemeName() {
      try {
        const raw = window.localStorage.getItem(terminalThemeStorageKey);
        if (raw && terminalThemes[raw]) return raw;
      } catch {}
      return "default";
    }

    function getThemeName() {
      if (terminalThemeSelect && terminalThemes[terminalThemeSelect.value]) {
        return terminalThemeSelect.value;
      }
      return getStoredThemeName();
    }

    function getTheme(themeName) {
      if (terminalThemes[themeName]) return terminalThemes[themeName];
      return terminalThemes.default;
    }

    function applyTheme(themeName, persist) {
      const resolvedTheme = getTheme(themeName);
      const resolvedName = terminalThemes[themeName] ? themeName : "default";
      if (terminalThemeSelect && terminalThemeSelect.value !== resolvedName) {
        terminalThemeSelect.value = resolvedName;
      }
      if (persist) {
        try { window.localStorage.setItem(terminalThemeStorageKey, resolvedName); } catch {}
      }
      if (!term) return;
      term.options.theme = resolvedTheme;
    }

    function setSessionId(sessionId) {
      if (!sessionId) return;
      activeSessionId = sessionId;
      if (terminalSessionInput) terminalSessionInput.value = sessionId;
      if (typeof config.onSessionSelected === "function") {
        config.onSessionSelected(sessionId);
      }
    }

    function getSessionId() {
      if (terminalSessionInput) return terminalSessionInput.value || "";
      return activeSessionId;
    }

    function ensureTerminal() {
      if (!window.Terminal) {
        setTerminalStatus("xterm failed to load");
        return false;
      }
      if (!term) {
        const initialThemeName = getThemeName();
        term = new window.Terminal({
          cursorBlink: true,
          convertEol: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          scrollback: 50000,
          theme: getTheme(initialThemeName),
        });
        if (window.FitAddon && typeof window.FitAddon.FitAddon === "function") {
          fitAddon = new window.FitAddon.FitAddon();
          term.loadAddon(fitAddon);
        }

        term.open(terminalNode);
        scheduleFit();
        setTimeout(scheduleFit, 120);
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
          document.fonts.ready.then(() => scheduleFit()).catch(() => {});
        }

        term.onResize(({ cols, rows }) => {
          sendSessionResize(cols, rows);
        });

        window.addEventListener("resize", () => {
          if (!term) return;
          scheduleFit();
        });
        if (window.ResizeObserver) {
          termResizeObserver = new window.ResizeObserver(() => scheduleFit());
          termResizeObserver.observe(terminalNode);
        }
        applyTheme(initialThemeName, true);
      }
      return true;
    }

    function applyTerminalHostSize() {
      if (!terminalNode) return;
      if (terminalNode.offsetParent === null) return;

      const rect = terminalNode.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 0;
      if (viewportHeight <= 0) return;

      const availableHeight = Math.floor(viewportHeight - rect.top - 20);
      const targetHeight = Math.max(terminalMinHeightPx, availableHeight);

      const currentHeight = parseInt(terminalNode.style.height || "0", 10);
      if (!Number.isFinite(currentHeight) || Math.abs(currentHeight - targetHeight) >= 1) {
        terminalNode.style.height = targetHeight + "px";
      }
      terminalNode.style.width = "100%";
    }

    function sendSessionResize(cols, rows) {
      if (!termSocket || termSocket.readyState !== WebSocket.OPEN) return;
      if (!activeSessionId) return;
      if (cols === lastResizeCols && rows === lastResizeRows) return;
      lastResizeCols = cols;
      lastResizeRows = rows;
      const resizeMsg = {
        type: "session.resize",
        schema_version: "1",
        request_id: config.requestId("resize"),
        session_id: activeSessionId,
        cols: cols,
        rows: rows,
      };
      try {
        termSocket.send(JSON.stringify(resizeMsg));
      } catch {}
    }

    function scheduleFit() {
      if (!term) return;
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        if (!term) return;
        applyTerminalHostSize();
        if (fitAddon && typeof fitAddon.fit === "function") {
          try { fitAddon.fit(); } catch {}
        }
        sendSessionResize(term.cols || 80, term.rows || 24);
      }, 16);
    }

    function disconnect() {
      if (termInputDisposable) {
        termInputDisposable.dispose();
        termInputDisposable = null;
      }
      if (fitTimer) {
        clearTimeout(fitTimer);
        fitTimer = null;
      }
      if (termKeepaliveTimer) {
        clearInterval(termKeepaliveTimer);
        termKeepaliveTimer = null;
      }
      if (initialSnapshotTimer) {
        clearTimeout(initialSnapshotTimer);
        initialSnapshotTimer = null;
      }
      awaitingInitialSnapshot = false;
      if (termSocket) {
        try { termSocket.close(1000, "user disconnect"); } catch {}
      }
      termSocket = null;
      lastResizeCols = 0;
      lastResizeRows = 0;
      setTerminalStatus("disconnected");
    }

    if (terminalThemeSelect) {
      const storedTheme = getStoredThemeName();
      if (terminalThemes[storedTheme]) {
        terminalThemeSelect.value = storedTheme;
      }
      terminalThemeSelect.addEventListener("change", () => {
        applyTheme(getThemeName(), true);
      });
    }

    async function connect(vpsId, sessionId) {
      if (!vpsId || !sessionId) return;
      if (!ensureTerminal()) return;

      disconnect();
      setSessionId(sessionId);
      term.reset();
      setTerminalStatus("connecting: " + sessionId);
      scheduleFit();
      term.focus();

      const path = "/vps/" + encodeURIComponent(vpsId) + "/terminal?session_id=" + encodeURIComponent(sessionId);
      const socket = new WebSocket(config.wsUrl(path));
      termSocket = socket;
      socket.binaryType = "arraybuffer";

      const sendSocketJSON = (payload) => {
        if (socket !== termSocket) return;
        if (socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify(payload)); } catch {}
      };

      socket.addEventListener("open", () => {
        if (socket !== termSocket) return;
        setTerminalStatus("connected: " + sessionId);
        scheduleFit();
        term.focus();

        if (termInputDisposable) {
          termInputDisposable.dispose();
          termInputDisposable = null;
        }
        termInputDisposable = term.onData((data) => {
          const inputMsg = {
            type: "session.input",
            schema_version: "1",
            request_id: config.requestId("input"),
            session_id: sessionId,
            data: config.utf8ToBase64(data),
          };
          sendSocketJSON(inputMsg);
        });

        if (termKeepaliveTimer) {
          clearInterval(termKeepaliveTimer);
          termKeepaliveTimer = null;
        }
        termKeepaliveTimer = setInterval(() => {
          sendSocketJSON({ type: "ping" });
        }, 20000);

        awaitingInitialSnapshot = true;
        if (initialSnapshotTimer) {
          clearTimeout(initialSnapshotTimer);
          initialSnapshotTimer = null;
        }
        initialSnapshotTimer = setTimeout(() => {
          initialSnapshotTimer = null;
          awaitingInitialSnapshot = false;
        }, 1500);
        sendSocketJSON({
          type: "session.snapshot",
          schema_version: "1",
          request_id: config.requestId("snapshot"),
          session_id: sessionId,
        });
        sendSessionResize(term.cols || 80, term.rows || 24);
      });

      socket.addEventListener("message", (event) => {
        if (socket !== termSocket) return;
        if (typeof event.data === "string") {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }

          if (msg.type === "ack" && msg.ok === false) {
            const errText = msg.error || "gateway command failed";
            term.writeln("\\r\\n[ack error] " + errText);
            return;
          }

          if (msg.type === "session.snapshot" && msg.session_id === activeSessionId && typeof msg.content === "string") {
            const rowsHint = Number.isFinite(msg.rows) && msg.rows > 0 ? msg.rows : 80;
            const normalizedContent = String(msg.content).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
            const contentLines = normalizedContent.split("\\n");
            if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
              contentLines.pop();
            }
            const snapshotTail = contentLines.slice(-rowsHint).join("\\r\\n");
            term.reset();
            term.write(snapshotTail);
            if (Number.isFinite(msg.cursor_x) && Number.isFinite(msg.cursor_y)) {
              const col = Math.max(0, Math.floor(msg.cursor_x)) + 1;
              const row = Math.max(0, Math.floor(msg.cursor_y)) + 1;
              term.write("\\x1b[" + row + ";" + col + "H");
            }
            awaitingInitialSnapshot = false;
            if (initialSnapshotTimer) {
              clearTimeout(initialSnapshotTimer);
              initialSnapshotTimer = null;
            }
            return;
          }

          if (msg.type === "session.error" && msg.session_id === activeSessionId) {
            term.writeln("\\r\\n[session.error] " + (msg.error || "unknown"));
            return;
          }

          if (msg.type === "session.ended" && msg.session_id === activeSessionId) {
            term.writeln("\\r\\n[session ended]");
            return;
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const frame = decodeTerminalFrame(event.data);
          if (!frame || frame.kind !== 0x01) return;
          if (frame.sessionId !== activeSessionId) return;

          const sendAck = () => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const ackMsg = {
              type: "session.ack",
              schema_version: "1",
              request_id: config.requestId("ack"),
              session_id: frame.sessionId,
              seq: frame.seq,
            };
            try { socket.send(JSON.stringify(ackMsg)); } catch {}
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

      socket.addEventListener("close", (ev) => {
        if (socket !== termSocket) return;
        if (termInputDisposable) {
          termInputDisposable.dispose();
          termInputDisposable = null;
        }
        if (termKeepaliveTimer) {
          clearInterval(termKeepaliveTimer);
          termKeepaliveTimer = null;
        }
        if (term) {
          const reason = ev && ev.reason ? " reason=" + ev.reason : "";
          term.writeln("\\r\\n[terminal socket closed code=" + ev.code + reason + "]");
        }
        termSocket = null;
        setTerminalStatus("disconnected");
      });

      socket.addEventListener("error", () => {
        if (socket !== termSocket) return;
        if (term) term.writeln("\\r\\n[terminal socket error]");
      });
    }

    return {
      connect,
      disconnect,
      scheduleFit,
      setSessionId,
      getSessionId,
      setVisible(visible) {
        if (!terminalWrap) return;
        terminalWrap.style.display = visible ? "block" : "none";
      },
    };
  }
`;
