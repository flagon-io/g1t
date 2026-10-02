import type { ComponentProps, ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-muted";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={CONTROL} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={`${CONTROL} font-mono`} />;
}

export function Button({
  variant = "primary",
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "quiet" }) {
  const styles =
    variant === "primary"
      ? "bg-fg text-bg hover:bg-white"
      : "border border-line text-muted hover:text-fg";
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-2 text-sm font-medium ${styles}`}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="text-sm text-red-400">{children}</p> : null;
}

const STATUS_STYLES: Record<string, string> = {
  open: "border-accent/40 text-accent",
  working: "border-accent/40 text-accent",
  submitted: "border-sky-400/40 text-sky-300",
  shipped: "border-violet-400/40 text-violet-300",
};

/** A status pill; unknown statuses render muted. */
export function Status({ value }: { value: string }) {
  const style = STATUS_STYLES[value] ?? "border-line text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${style}`}
    >
      {value === "working" && (
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      )}
      {value}
    </span>
  );
}

const UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

/** Compact relative time such as "5m ago". */
export function TimeAgo({ at }: { at: number }) {
  const elapsed = Date.now() - at;
  const unit = UNITS.find(([, size]) => elapsed >= size);
  const label = unit ? `${Math.floor(elapsed / unit[1])}${unit[0]} ago` : "just now";
  return (
    // The server and the browser render at slightly different times.
    <time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
      {label}
    </time>
  );
}
