import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Cloud, Server, Check, Loader2, Copy } from "lucide-react";
import {
  createManualVPS,
  createVPS,
  getDODropletOptions,
  listVPS,
  regenerateManualVPSCommand,
  type DODropletOptions,
  type ManualVPSResponse,
} from "@/lib/api";

interface OnboardingPageProps {
  onBack: () => void;
  onComplete: (vpsId: string) => void;
  manualVpsId?: string | null;
}

type Step = "choose" | "do-setup" | "byo-setup" | "creating";

export function OnboardingPage({ onBack, onComplete, manualVpsId = null }: OnboardingPageProps) {
  const [step, setStep] = useState<Step>("choose");
  const [doOptions, setDoOptions] = useState<DODropletOptions | null>(null);
  const [doOptionsLoading, setDoOptionsLoading] = useState(false);
  const [planFamily, setPlanFamily] = useState<"regular" | "premium_intel">("regular");
  const [region, setRegion] = useState("ams3");
  const [size, setSize] = useState("s-2vcpu-2gb");
  const [image, setImage] = useState("ubuntu-24-04-x64");
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
        image,
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
  }, [region, size, image, doLabel, onComplete]);

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
    if (step !== "do-setup" || doOptionsLoading || doOptions) return;
    let cancelled = false;
    setDoOptionsLoading(true);
    void getDODropletOptions()
      .then((options) => {
        if (cancelled) return;
        setDoOptions(options);
        setPlanFamily(options.defaults.plan_family);
        setRegion(options.defaults.region);
        setSize(options.defaults.size);
        setImage(options.defaults.image);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load current DigitalOcean options";
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setDoOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, doOptions, doOptionsLoading]);

  useEffect(() => {
    if (!doOptions) return;
    const nextSizes = doOptions.plans[planFamily].filter((option) => option.regions.includes(region));
    if (nextSizes.length === 0) {
      const fallbackSize = doOptions.plans[planFamily][0]?.slug;
      if (fallbackSize && fallbackSize !== size) setSize(fallbackSize);
      return;
    }
    if (!nextSizes.some((option) => option.slug === size)) {
      setSize(nextSizes[0]?.slug ?? size);
    }
  }, [doOptions, planFamily, region, size]);

  const visibleSizes = doOptions
    ? (() => {
        const filtered = doOptions.plans[planFamily].filter((option) => option.regions.includes(region));
        return filtered.length > 0 ? filtered : doOptions.plans[planFamily];
      })()
    : [];

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

              {doOptionsLoading && !doOptions && (
                <div className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                  Loading current DigitalOcean regions, sizes, and Linux images...
                </div>
              )}

              {doOptions && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">
                      Region
                    </label>
                    <div className="grid gap-3 md:grid-cols-3">
                      {doOptions.regions.map((column) => (
                        <div key={column.id} className="space-y-2">
                          <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {column.label}
                          </div>
                          <div className="space-y-2">
                            {column.options.map((option) => (
                              <button
                                key={option.slug}
                                type="button"
                                disabled={!option.available}
                                onClick={() => setRegion(option.slug)}
                                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                                  region === option.slug
                                    ? "border-primary bg-primary/5 text-primary"
                                    : "border-border text-foreground hover:border-primary/50"
                                } disabled:cursor-not-allowed disabled:opacity-50`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">
                      Droplet Type
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setPlanFamily("regular")}
                        className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                          planFamily === "regular"
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border text-foreground hover:border-primary/50"
                        }`}
                      >
                        Regular
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanFamily("premium_intel")}
                        className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                          planFamily === "premium_intel"
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border text-foreground hover:border-primary/50"
                        }`}
                      >
                        Premium (Intel)
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">
                      Specs
                    </label>
                    <div className="grid gap-2 md:grid-cols-2">
                      {visibleSizes.map((option) => (
                        <button
                          key={option.slug}
                          type="button"
                          onClick={() => setSize(option.slug)}
                          className={`rounded-md border p-3 text-left transition-colors ${
                            size === option.slug
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-sm font-medium text-foreground">
                              {option.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              ${option.price_monthly}/mo
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {option.specs}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">
                      Linux
                    </label>
                    <div className="grid gap-2 md:grid-cols-2">
                      {doOptions.images.map((option) => (
                        <button
                          key={option.slug}
                          type="button"
                          onClick={() => setImage(option.slug)}
                          className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                            image === option.slug
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border text-foreground hover:border-primary/50"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

              <button
              onClick={handleCreateDO}
              disabled={(!doOptions && doOptionsLoading) || (Boolean(doOptions) && visibleSizes.length === 0)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              <Check className="h-4 w-4" />
              Create Droplet
            </button>

            <p className="text-xs text-muted-foreground text-center">
              Requires a connected DigitalOcean account.
              Compute billing starts immediately.
            </p>
            {doOptions && !doOptions.live && (
              <p className="text-xs text-muted-foreground text-center">
                Showing fallback DigitalOcean defaults. Live catalog data is loaded when your DO account is connected.
              </p>
            )}
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
