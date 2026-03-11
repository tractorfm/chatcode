import type { AgentType } from "@/lib/constants";
import { AGENT_TYPES } from "@/lib/constants";

interface SessionCreatePickerProps {
  workdir: string;
  onWorkdirChange: (value: string) => void;
  onCreate: (agent: AgentType) => void;
  creating?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SessionCreatePicker({
  workdir,
  onWorkdirChange,
  onCreate,
  creating = false,
  disabled = false,
  className = "",
}: SessionCreatePickerProps) {
  return (
    <div className={`rounded-md border border-border bg-card shadow-lg p-2 space-y-2 ${className}`.trim()}>
      <div className="space-y-1">
        <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Folder under ~/workspace
        </label>
        <input
          value={workdir}
          onChange={(e) => onWorkdirChange(e.target.value)}
          placeholder="new"
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
        />
      </div>
      <div className="space-y-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Agent
        </p>
        {AGENT_TYPES.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onCreate(value)}
            disabled={creating || disabled}
            className="w-full rounded-md text-left px-2 py-1.5 text-xs text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
