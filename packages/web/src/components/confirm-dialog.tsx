import { type ReactNode, useState } from "react";
import { Loader2 } from "lucide-react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  details?: ReactNode;
  destructive?: boolean;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  details,
  destructive,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    setErrorMessage("");
    try {
      await onConfirm();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!pending) onCancel();
        }}
      />
      <div className="relative bg-card rounded-lg border border-border shadow-lg p-5 w-full max-w-md mx-4 space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
          {details ? <div className="pt-2">{details}</div> : null}
          {pending ? (
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Working. This can take a minute or two.</span>
            </div>
          ) : null}
          {errorMessage ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={pending}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {confirmLabel ?? "Confirm"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
