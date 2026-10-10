import { FileText, Upload, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { cn } from "../../lib/cn";

// A file field as a dropzone. The real <input type="file"> is inside it,
// visually hidden, so its name, accept, multiple and required work as they
// always do and the form posts the files exactly as a bare input would. A
// click or Enter on the zone opens the picker; files dropped on it are put
// on the input and a change event is sent, as if they had been picked.

type Chosen = { name: string; size: number };

/** Bytes as a person reads them: 812 B, 14.2 KB, 1.3 MB. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDrop({
  id,
  name,
  accept,
  multiple = false,
  required,
  hint,
  label,
  compact = false,
  className,
  onChange,
  "aria-describedby": describedBy,
}: {
  id?: string;
  name?: string;
  accept?: string;
  multiple?: boolean;
  required?: boolean;
  /** A line under the prompt, such as the types and the size allowed. */
  hint?: ReactNode;
  /** The field's name for a screen reader, when nothing else labels it. */
  label?: string;
  /** One row, for a tight spot beside other controls. */
  compact?: boolean;
  className?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  "aria-describedby"?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Chosen[]>([]);
  const [dragging, setDragging] = useState(false);

  // A form reset empties the input; the list follows it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const onReset = () => setFiles([]);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const changed = (event: ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(event.currentTarget.files ?? [], (file) => ({ name: file.name, size: file.size })));
    onChange?.(event);
  };

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const field = input.current;
    const dropped = event.dataTransfer.files;
    if (!field || dropped.length === 0) return;
    if (multiple || dropped.length === 1) {
      field.files = dropped;
    } else {
      const one = new DataTransfer();
      one.items.add(dropped[0]);
      field.files = one.files;
    }
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const clear = () => {
    const field = input.current;
    if (!field) return;
    field.value = "";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.focus();
  };

  const describedByIds = [describedBy, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const plural = multiple;

  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={drop}
        className={cn(
          "relative flex cursor-pointer rounded-lg border border-dashed border-line-strong bg-bg text-sm text-muted transition-colors",
          "hover:border-accent/50 hover:bg-surface has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-bg",
          compact ? "min-h-11 items-center gap-2 px-3 py-1.5 sm:min-h-9" : "flex-col items-center justify-center gap-1.5 px-4 py-6 text-center",
          dragging && "border-accent bg-accent/5 hover:border-accent hover:bg-accent/5",
        )}
      >
        <input
          ref={input}
          id={inputId}
          type="file"
          name={name}
          accept={accept}
          multiple={multiple}
          required={required}
          aria-describedby={describedByIds}
          onChange={changed}
          className="sr-only"
        />
        {label && <span className="sr-only">{label}</span>}
        <Upload size={compact ? 14 : 18} aria-hidden className={cn("shrink-0", dragging ? "text-accent" : "text-faint")} />
        <span className="min-w-0">
          <span className="font-medium text-accent">{plural ? "Choose files" : "Choose a file"}</span> or drop {plural ? "them" : "it"} here
        </span>
        {hint && (
          <span id={hintId} className={cn("text-xs text-faint", compact && "sr-only")}>
            {hint}
          </span>
        )}
      </label>
      {files.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface py-1 pr-1 pl-3">
          <ul aria-label="Chosen files" className="min-w-0 grow">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex min-h-8 items-center gap-2 text-sm">
                <FileText size={14} aria-hidden className="shrink-0 text-faint" />
                <span className="min-w-0 grow truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-faint tabular-nums">{fileSize(file.size)}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={clear}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={13} aria-hidden />
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
