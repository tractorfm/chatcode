import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Cloud, Server, Check, Loader2, Copy } from "lucide-react";
import { createManualVPS, createVPS, listVPS, regenerateManualVPSCommand, type ManualVPSResponse } from "@/lib/api";

interface OnboardingPageProps {
  onBack: () => void;
  onComplete: (vpsId: string) => void;
  manualVpsId?: string | null;
}

type Step = "choose" | "do-setup" | "byo-setup" | "creating";

const REGIONS = [
  { value: "nyc1", label: "New York 1" },
  { value: "sfo3", label: "San Francisco 3" },
  { value: "ams3", label: "Amsterdam 3" },
  { value: "sgp1", label: "Singapore 1" },
  { value: "lon1", label: "London 1" },
  { value: "fra1", label: "Frankfurt 1" },
];

const SIZES = [
  { value: "s-1vcpu-512mb-10gb", label: "Micro", desc: "1 vCPU, 512MB, 10GB", cost: "~$4/mo" },
  { value: "s-1vcpu-1gb", label: "Small", desc: "1 vCPU, 1GB, 25GB", cost: "~$6/mo" },
  { value: "s-2vcpu-2gb", label: "Medium", desc: "2 vCPU, 2GB, 50GB", cost: "~$12/mo" },
  { value: "s-2vcpu-4gb", label: "Large", desc: "2 vCPU, 4GB, 80GB", cost: "~$24/mo" },
];

export function OnboardingPage({ onBack, onComplete, manualVpsId = null }: OnboardingPageProps) {
  const [step, setStep] = useState<Step>("choose");
  const [region, setRegion] = useState("nyc1");
  const [size, setSize] = useState("s-1vcpu-512mb-10gb");
  const [error, setError] = useState("");
  const [doLabel, setDoLabel] = useState("");
  const [byoLabel, setByoLabel] = useState("");
  const [manualSetup, setManualSetup] = useState<ManualVPSResponse | null>(null);
  const [manualPlatform, setManualPlatform] = useState<"linux" | "macos">("linux");
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState("");
  const [copiedCommand, setCopiedCommand] = useState(false);

  const handleCreateDO = useCallback(async () => {
    setStep("creating");
    setError("");
    try {
      const result = await createVPS({
        region,
        size,
        label: doLabel || `chatcode-${region}`,
      });
      if (result.vps.id) {
        onComplete(result.vps.id);
        return;
      }

      // Fallback safety if create contract regresses.
      const { vps: listed } = await listVPS();
      if (listed[0]?.id) {
        onComplete(listed[0].id);
        return;
      }
      throw new Error("VPS created but id could not be resolved");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create VPS";
      setError(msg);
      setStep("do-setup");
    }
  }, [region, size, doLabel, onComplete]);

  const handlePrepareManualSetup = useCallback(async () => {
    setManualLoading(true);
    setManualError("");
    setCopiedCommand(false);
    try {
      const setup = await createManualVPS({
        label: byoLabel.trim() || undefined,
      });
      setManualSetup(setup);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to generate manual install command";
      setManualError(msg);
    } finally {
      setManualLoading(false);
    }
  }, [byoLabel]);

  const loadExistingManualSetup = useCallback(async () => {
    if (!manualVpsId) return;
    setStep("byo-setup");
    setManualLoading(true);
    setManualError("");
    setCopiedCommand(false);
    try {
      const setup = await regenerateManualVPSCommand(manualVpsId);
      setByoLabel(setup.vps.label ?? "");
      setManualSetup(setup);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to load install command";
      setManualError(msg);
    } finally {
      setManualLoading(false);
    }
  }, [manualVpsId]);

  const handleCopyCommand = useCallback(async () => {
    if (!manualSetup) return;
    const cmd = manualSetup.install[manualPlatform];
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 1500);
    } catch {
      setCopiedCommand(false);
    }
  }, [manualPlatform, manualSetup]);

  const handleManualContinue = useCallback(() => {
    const vpsId = manualSetup?.vps?.id;
    if (vpsId) onComplete(vpsId);
  }, [manualSetup, onComplete]);

  useEffect(() => {
    if (!manualVpsId) return;
    void loadExistingManualSetup();
  }, [loadExistingManualSetup, manualVpsId]);

  useEffect(() => {
    const vpsId = manualSetup?.vps?.id;
    if (!vpsId) return;
    const timer = window.setInterval(async () => {
      try {
        const { vps } = await listVPS();
        const current = vps.find((entry) => entry.id === vpsId);
        if (current?.gateway_connected) {
          onComplete(vpsId);
        }
      } catch {
        // Best-effort polling only.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [manualSetup, onComplete]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-lg mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-md hover:bg-accent text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-xl font-semibold text-foreground">
            Set up your server
          </h1>
        </div>

        {step === "choose" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Choose how you want to run your coding environment.
            </p>

            <button
              onClick={() => setStep("do-setup")}
              className="w-full text-left p-4 rounded-lg border border-border bg-card hover:border-primary transition-colors space-y-2"
            >
              <div className="flex items-center gap-3">
                <Cloud className="h-5 w-5 text-primary" />
                <span className="font-medium text-foreground">
                  DigitalOcean Droplet
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  Recommended
                </span>
              </div>
              <p className="text-sm text-muted-foreground pl-8">
                One-click setup. We create and manage a droplet in your DO
                account. Starting at ~$4/mo.
              </p>
            </button>

            <button
              onClick={() => setStep("byo-setup")}
              className="w-full text-left p-4 rounded-lg border border-border bg-card hover:border-primary transition-colors space-y-2"
            >
              <div className="flex items-center gap-3">
                <Server className="h-5 w-5 text-muted-foreground" />
                <span className="font-medium text-foreground">
                  Bring Your Own Server
                </span>
              </div>
              <p className="text-sm text-muted-foreground pl-8">
                Connect any Linux or macOS machine you already own.
              </p>
            </button>
          </div>
        )}

        {step === "do-setup" && (
          <div className="space-y-4">
            <div className="bg-card rounded-lg border border-border p-4 space-y-4">
              {/* Label */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={doLabel}
                  onChange={(e) => setDoLabel(e.target.value)}
                  placeholder="my-dev-server"
                  maxLength={64}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Region */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  Region
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {REGIONS.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => setRegion(r.value)}
                      className={`p-2 rounded-md border text-sm text-left transition-colors ${
                        region === r.value
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border hover:border-primary/50 text-foreground"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Size */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  Size
                </label>
                <div className="space-y-2">
                  {SIZES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSize(s.value)}
                      className={`w-full p-3 rounded-md border text-left transition-colors ${
                        size === s.value
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground">
                          {s.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {s.cost}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {s.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <button
              onClick={handleCreateDO}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Check className="h-4 w-4" />
              Create Droplet
            </button>

            <p className="text-xs text-muted-foreground text-center">
              Requires a connected DigitalOcean account.
              Compute billing starts immediately.
            </p>
          </div>
        )}

        {step === "byo-setup" && (
          <div className="bg-card rounded-lg border border-border p-4 space-y-4">
            <h3 className="font-medium text-foreground">
              Connect your server
            </h3>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Label (optional)
              </label>
              <input
                type="text"
                value={byoLabel}
                onChange={(e) => setByoLabel(e.target.value)}
                placeholder="raspi-homelab"
                maxLength={64}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <button
              onClick={handlePrepareManualSetup}
              disabled={manualLoading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {manualLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating command...
                </>
              ) : (
                <>
                  <Server className="h-4 w-4" />
                  {manualVpsId ? "Regenerate install command" : "Generate install command"}
                </>
              )}
            </button>

            {manualError && (
              <p className="text-sm text-destructive">{manualError}</p>
            )}

            {manualSetup && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button
                    onClick={() => setManualPlatform("linux")}
                    className={`px-2 py-1 rounded-md text-xs border ${
                      manualPlatform === "linux"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    Linux
                  </button>
                  <button
                    onClick={() => setManualPlatform("macos")}
                    className={`px-2 py-1 rounded-md text-xs border ${
                      manualPlatform === "macos"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    macOS
                  </button>
                </div>

                <p className="text-sm text-muted-foreground">
                  Run this command on your server:
                </p>
                <div className="bg-background rounded-md border border-border p-3">
                  <code className="text-xs font-mono text-foreground break-all">
                    {manualSetup.install[manualPlatform]}
                  </code>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyCommand}
                    className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-foreground hover:bg-accent"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copiedCommand ? "Copied" : "Copy command"}
                  </button>
                  <button
                    onClick={handleManualContinue}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:bg-primary/90"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2 text-sm text-muted-foreground">
              <p>The install command will:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Install tmux and the gateway daemon</li>
                <li>Set up a service (systemd/launchd)</li>
                <li>Register the server to your account</li>
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Your server will appear in the sidebar once connected.
            </p>
          </div>
        )}

        {step === "creating" && (
          <div className="bg-card rounded-lg border border-border p-8 text-center space-y-4">
            <Loader2 className="h-8 w-8 mx-auto text-primary animate-spin" />
            <h3 className="font-medium text-foreground">
              Creating your droplet...
            </h3>
            <p className="text-sm text-muted-foreground">
              This usually takes 1-2 minutes. The gateway will connect
              automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
