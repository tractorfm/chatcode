import { useEffect, useState } from "react";
import { ArrowLeft, Circle, Server, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { listVPS, listSessions, type VPS, type Session } from "@/lib/api";

interface StatusPageProps {
  onBack: () => void;
}

export function StatusPage({ onBack }: StatusPageProps) {
  const [vpsList, setVpsList] = useState<VPS[]>([]);
  const [sessionsByVps, setSessionsByVps] = useState<
    Record<string, Session[]>
  >({});

  useEffect(() => {
    listVPS()
      .then(async ({ vps }) => {
        setVpsList(vps);
        const sessionsMap: Record<string, Session[]> = {};
        for (const v of vps) {
          try {
            const { sessions } = await listSessions(v.id);
            sessionsMap[v.id] = sessions;
          } catch {
            sessionsMap[v.id] = [];
          }
        }
        setSessionsByVps(sessionsMap);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-md hover:bg-accent text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-xl font-semibold text-foreground">Status</h1>
        </div>

        {vpsList.length === 0 && (
          <div className="bg-card rounded-lg border border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No servers to display.
            </p>
          </div>
        )}

        {vpsList.map((vps) => (
          <div
            key={vps.id}
            className="bg-card rounded-lg border border-border p-4 space-y-4"
          >
            {/* VPS Header */}
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1">
                <h2 className="text-sm font-medium text-foreground">
                  {vps.label || vps.id}
                </h2>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{vps.region}</span>
                  <span>&middot;</span>
                  <span>{vps.size}</span>
                  {vps.ipv4 && (
                    <>
                      <span>&middot;</span>
                      <span className="font-mono">{vps.ipv4}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Circle
                  className={`h-2 w-2 fill-current ${
                    vps.status === "active"
                      ? "text-green-500"
                      : vps.status === "provisioning"
                        ? "text-yellow-500"
                        : "text-muted-foreground"
                  }`}
                />
                <span className="text-xs text-muted-foreground capitalize">
                  {vps.status}
                </span>
              </div>
            </div>

            {/* Gateway info */}
            <div className="grid grid-cols-3 gap-3">
              <InfoCard
                icon={<Cpu className="h-4 w-4" />}
                label="Gateway"
                value={
                  vps.gateway_connected
                    ? `Connected (${vps.gateway_version ?? "?"})`
                    : "Offline"
                }
                status={vps.gateway_connected ? "ok" : "warn"}
              />
              <InfoCard
                icon={<MemoryStick className="h-4 w-4" />}
                label="Provider"
                value={vps.provider === "digitalocean" ? "DigitalOcean" : "Manual"}
              />
              <InfoCard
                icon={<HardDrive className="h-4 w-4" />}
                label="Sessions"
                value={`${(sessionsByVps[vps.id] ?? []).filter((s) => s.status === "running" || s.status === "starting").length} active`}
              />
            </div>

            {/* Session list */}
            {(sessionsByVps[vps.id] ?? []).length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Sessions
                </h3>
                {(sessionsByVps[vps.id] ?? []).map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between text-sm py-1"
                  >
                    <div className="flex items-center gap-2">
                      <Circle
                        className={`h-1.5 w-1.5 fill-current ${
                          s.status === "running"
                            ? "text-green-500"
                            : s.status === "starting"
                              ? "text-yellow-500"
                              : "text-muted-foreground"
                        }`}
                      />
                      <span className="text-foreground">{s.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.agent_type}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground capitalize">
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Cost estimate for DO */}
            {vps.provider === "digitalocean" && vps.size && (
              <div className="text-xs text-muted-foreground border-t border-border pt-3">
                Estimated cost: {estimateCost(vps.size)}/mo (compute only, billed
                by DigitalOcean)
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoCard({
  icon,
  label,
  value,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  status?: "ok" | "warn";
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p
        className={`text-sm font-medium ${
          status === "ok"
            ? "text-green-600 dark:text-green-400"
            : status === "warn"
              ? "text-yellow-600 dark:text-yellow-400"
              : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function estimateCost(size: string): string {
  const costs: Record<string, string> = {
    "s-1vcpu-512mb-10gb": "~$4",
    "s-1vcpu-1gb": "~$6",
    "s-2vcpu-2gb": "~$12",
    "s-2vcpu-4gb": "~$24",
    "s-4vcpu-8gb": "~$48",
  };
  return costs[size] ?? "varies";
}
