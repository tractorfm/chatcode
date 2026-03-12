import { useEffect, useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { applyColorScheme, getStoredColorScheme, type ColorScheme } from "@/lib/preferences";

function labelForTheme(theme: ColorScheme) {
  switch (theme) {
    case "system":
      return "System";
    case "dark":
      return "Dark";
    case "light":
      return "Light";
  }
}

export function ThemeToggle({
  value,
  onChange,
}: {
  value?: ColorScheme;
  onChange?: (theme: ColorScheme) => void;
}) {
  const [theme, setTheme] = useState<ColorScheme>(value ?? getStoredColorScheme());

  useEffect(() => {
    if (value) setTheme(value);
  }, [value]);

  useEffect(() => {
    applyColorScheme(theme);
  }, [theme]);

  // Listen for system preference changes
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getStoredColorScheme() === "system") applyColorScheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const themeOptions: Array<{ value: ColorScheme; label: string; icon: typeof Monitor }> = [
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
            onClick={() => {
              setTheme(option.value);
              onChange?.(option.value);
            }}
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
