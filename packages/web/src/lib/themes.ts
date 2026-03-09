import type { ITheme } from "@xterm/xterm";

export const terminalThemes: Record<string, ITheme> = {
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

const THEME_STORAGE_KEY = "chatcode.terminal.theme";

export function getStoredTerminalTheme(): string {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && terminalThemes[raw]) return raw;
  } catch {
    /* ignore */
  }
  return "default";
}

export function storeTerminalTheme(name: string) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch {
    /* ignore */
  }
}
