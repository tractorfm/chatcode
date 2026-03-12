export type ColorScheme = "system" | "dark" | "light";

export interface UserPreferences {
  color_scheme: ColorScheme;
  terminal_theme: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  color_scheme: "system",
  terminal_theme: "default",
};

const COLOR_SCHEME_STORAGE_KEY = "chatcode.theme";

export function getStoredColorScheme(): ColorScheme {
  try {
    const raw = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === "system" || raw === "dark" || raw === "light") return raw;
  } catch {
    // ignore
  }
  return "system";
}

export function applyColorScheme(theme: ColorScheme) {
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  try {
    if (theme === "system") {
      localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    } else {
      localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, theme);
    }
  } catch {
    // ignore
  }
}

export function cachePreferences(preferences: UserPreferences) {
  applyColorScheme(preferences.color_scheme);
  try {
    localStorage.setItem("chatcode.terminal.theme", preferences.terminal_theme);
  } catch {
    // ignore
  }
}
