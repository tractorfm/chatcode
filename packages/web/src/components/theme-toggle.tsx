import { useEffect, useState } from "react";
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

function labelForTheme(theme: Theme) {
  switch (theme) {
    case "system":
      return "System";
    case "dark":
      return "Dark";
    case "light":
      return "Light";
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

  const themeOptions: Array<{ value: Theme; label: string; icon: typeof Monitor }> = [
    { value: "system", label: "System", icon: Monitor },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "light", label: "Light", icon: Sun },
  ];

  return (
    <div
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-1"
      aria-label={`Color Scheme: ${labelForTheme(theme)}`}
    >
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            onClick={() => setTheme(option.value)}
            className={
              active
                ? "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium bg-accent text-accent-foreground"
                : "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }
            title={option.label}
          >
            <Icon className="h-4 w-4" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
