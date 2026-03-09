import { useCallback, useEffect, useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";

type Theme = "light" | "dark" | "system";

function getTheme(): Theme {
  return (localStorage.getItem("chatcode.theme") as Theme) ?? "system";
}

function applyTheme(theme: Theme) {
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  if (theme === "system") {
    localStorage.removeItem("chatcode.theme");
  } else {
    localStorage.setItem("chatcode.theme", theme);
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for system preference changes
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getTheme() === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const order: Theme[] = ["system", "light", "dark"];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      return next;
    });
  }, []);

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <button
      onClick={cycle}
      className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      title={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
