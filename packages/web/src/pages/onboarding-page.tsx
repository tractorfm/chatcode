import { useCallback, useState } from "react";
import { ArrowLeft, Cloud, Server, Check, Loader2 } from "lucide-react";
import { createVPS } from "@/lib/api";

interface OnboardingPageProps {
  onBack: () => void;
  onComplete: (vpsId: string) => void;
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

export function OnboardingPage({ onBack, onComplete }: OnboardingPageProps) {
  const [step, setStep] = useState<Step>("choose");
  const [region, setRegion] = useState("nyc1");
  const [size, setSize] = useState("s-1vcpu-512mb-10gb");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");

  const handleCreateDO = useCallback(async () => {
    setStep("creating");
    setError("");
    try {
      const vps = await createVPS({
        region,
        size,
        label: label || `chatcode-${region}`,
      });
      onComplete(vps.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create VPS";
      setError(msg);
      setStep("do-setup");
    }
  }, [region, size, label, onComplete]);

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
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="my-dev-server"
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
            <p className="text-sm text-muted-foreground">
              Run this command on your Linux or macOS machine:
            </p>
            <div className="bg-background rounded-md border border-border p-3">
              <code className="text-xs font-mono text-foreground break-all">
                curl -fsSL https://chatcode.dev/install | sh
              </code>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>The install script will:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Install tmux and the gateway daemon</li>
                <li>Set up a systemd service (Linux) or launchd plist (macOS)</li>
                <li>Connect your server to Chatcode</li>
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
