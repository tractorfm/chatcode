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
  editable?: boolean;
  editMode?: "single" | "double";
}

export function InlineEdit({
  value,
  onSave,
  className,
  inputClassName,
  maxLength = 80,
  placeholder,
  allowEmpty = false,
  editable = true,
  editMode = "double",
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
          "box-border h-6 w-full min-w-0 rounded border border-border bg-transparent px-1 py-0 text-inherit outline-none focus:border-primary",
          inputClassName,
        )}
      />
    );
  }

  return (
    <span
      className={cn(
        "group/edit box-border inline-flex h-6 min-w-0 items-center gap-1 rounded border border-transparent px-1",
        className,
      )}
      onClick={(e) => {
        if (!editable || editMode !== "single") return;
        e.stopPropagation();
        e.preventDefault();
        setEditing(true);
      }}
      onDoubleClick={(e) => {
        if (!editable || editMode !== "double") return;
        e.stopPropagation();
        e.preventDefault();
        setEditing(true);
      }}
    >
      <span className="truncate">{value}</span>
      {editable ? (
        <Pencil className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover/edit:opacity-40 transition-opacity" />
      ) : null}
    </span>
  );
}
