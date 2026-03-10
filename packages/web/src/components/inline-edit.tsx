import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

interface InlineEditProps {
  value: string;
  onSave: (value: string) => Promise<void> | void;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  placeholder?: string;
  allowEmpty?: boolean;
}

export function InlineEdit({
  value,
  onSave,
  className,
  inputClassName,
  maxLength = 80,
  placeholder,
  allowEmpty = false,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Wait for next frame so input is mounted
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, value]);

  const commit = useCallback(async () => {
    const trimmed = draft.trim();
    if ((!allowEmpty && !trimmed) || trimmed === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } finally {
      setSaving(false);
    }
  }, [allowEmpty, draft, value, onSave]);

  const cancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            cancel();
          }
          e.stopPropagation();
        }}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cn(
          "bg-transparent border border-border rounded px-1 py-0 text-inherit outline-none focus:border-primary w-full min-w-0",
          inputClassName,
        )}
      />
    );
  }

  return (
    <span
      className={cn("group/edit inline-flex items-center gap-1 min-w-0", className)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setEditing(true);
      }}
    >
      <span className="truncate">{value}</span>
      <Pencil className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover/edit:opacity-40 transition-opacity" />
    </span>
  );
}
