import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { listVPS, type VPS } from "@/lib/api";
import {
  getStoredTerminalTheme,
  storeTerminalTheme,
  terminalThemes,
} from "@/lib/themes";

interface SettingsPageProps {
  userEmail?: string;
  onBack: () => void;
  onLogout: () => void;
}

export function SettingsPage({
  userEmail,
  onBack,
  onLogout,
}: SettingsPageProps) {
  const [termTheme, setTermTheme] = useState(getStoredTerminalTheme);
  const [vpsList, setVpsList] = useState<VPS[]>([]);

  useEffect(() => {
    listVPS()
      .then(({ vps }) => setVpsList(vps))
      .catch(() => {});
  }, []);

  const handleTermThemeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const name = e.target.value;
      setTermTheme(name);
      storeTerminalTheme(name);
    },
    [],
  );

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-md hover:bg-accent text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        </div>

        {/* Account */}
        <section className="bg-card rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-medium text-foreground">Account</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Email</span>
            <span className="text-sm text-foreground">{userEmail ?? "-"}</span>
          </div>
        </section>

        {/* Appearance */}
        <section className="bg-card rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-medium text-foreground">Appearance</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">App theme</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Terminal theme
            </span>
            <select
              value={termTheme}
              onChange={handleTermThemeChange}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
            >
              {Object.keys(terminalThemes).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* Servers overview */}
        <section className="bg-card rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-medium text-foreground">Servers</h2>
          {vpsList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No servers configured.
            </p>
          ) : (
            <div className="space-y-2">
              {vpsList.map((vps) => (
                <div
                  key={vps.id}
                  className="flex items-center justify-between text-sm"
                >
                  <div>
                    <span className="text-foreground">
                      {vps.label || vps.id}
                    </span>
                    <span className="text-muted-foreground ml-2">
                      {vps.region} &middot; {vps.status}
                    </span>
                  </div>
                  {vps.ipv4 && (
                    <span className="text-xs font-mono text-muted-foreground">
                      {vps.ipv4}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {vpsList.some((v) => v.provider === "digitalocean") && (
            <a
              href="https://cloud.digitalocean.com/droplets"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              DigitalOcean Dashboard
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </section>

        {/* Sign out */}
        <section className="bg-card rounded-lg border border-border p-4">
          <button
            onClick={onLogout}
            className="w-full rounded-md border border-destructive/30 px-4 py-2 text-sm text-destructive hover:bg-destructive/5 transition-colors"
          >
            Sign out
          </button>
        </section>
      </div>
    </div>
  );
}
