/**
 * sudo's building blocks, after apps/web/app/components/ui. None of them
 * sets a `style` attribute: the content security policy allows no inline
 * styles, so sizes and colours that vary are drawn as SVG attributes.
 */
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

import type { Limit, Terms, Trust } from "@g1t/contracts";

import { usd } from "~/lib/money";

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-merged/60";

/** Tells password managers that a field is not a login. */
const NOT_A_CREDENTIAL = {
  autoComplete: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
};

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...NOT_A_CREDENTIAL} {...props} className={`${CONTROL} ${className}`} />;
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...NOT_A_CREDENTIAL} {...props} className={`${CONTROL} ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select {...props} className={`${CONTROL} ${className}`} />;
}

type Variant = "primary" | "quiet" | "danger" | "lavender";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50";

const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-white",
  lavender: "bg-merged text-bg hover:bg-[#c8bdff]",
  quiet: "border border-line text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg",
  danger: "border border-danger/40 text-danger hover:border-danger/70 hover:bg-danger/10",
};

export function Button({ variant = "primary", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button {...props} className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`} />;
}

export function ButtonLink({ variant = "primary", className = "", ...props }: LinkProps & { variant?: Variant }) {
  return <Link {...props} className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`} />;
}

/** A bordered panel with a heading. */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  className = "",
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 rounded-lg border border-line bg-surface ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1.5 text-sm text-muted">{children}</div>}
    </div>
  );
}

const NOTICE = {
  ok: { icon: CheckCircle2, className: "border-accent/30 bg-accent/8 text-accent" },
  error: { icon: AlertTriangle, className: "border-danger/30 bg-danger/8 text-danger" },
  warn: { icon: AlertTriangle, className: "border-warn/30 bg-warn/8 text-warn" },
  info: { icon: Info, className: "border-merged/30 bg-merged/8 text-merged" },
} as const;

export function Notice({ tone, children }: { tone: keyof typeof NOTICE; children: ReactNode }) {
  const { icon: Icon, className } = NOTICE[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex gap-2.5 rounded-md border px-3.5 py-2.5 text-sm ${className}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 text-fg-soft">{children}</div>
    </div>
  );
}

/** A small label; `tone` colours it. */
export function Badge({ tone = "plain", children }: { tone?: "plain" | "lavender" | "mint" | "warn" | "danger" | "info"; children: ReactNode }) {
  const tones = {
    plain: "border-line text-muted",
    lavender: "border-merged/35 bg-merged/10 text-merged",
    mint: "border-accent/30 bg-accent/8 text-accent",
    warn: "border-warn/35 bg-warn/10 text-warn",
    danger: "border-danger/35 bg-danger/10 text-danger",
    info: "border-info/35 bg-info/10 text-info",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-px text-xs font-medium whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function TermsBadge({ terms }: { terms: Terms }) {
  if (terms.kind === "comped") return <Badge tone="mint">Comped</Badge>;
  if (terms.kind === "custom") {
    return <Badge tone="info">Custom{terms.discountPercent > 0 ? ` −${terms.discountPercent}%` : ""}</Badge>;
  }
  return <Badge>Standard</Badge>;
}

const TRUST: Record<Trust, { label: string; tone: "plain" | "lavender" | "mint" | "info" }> = {
  new: { label: "New", tone: "plain" },
  paid: { label: "Paid", tone: "info" },
  reviewed: { label: "Reviewed", tone: "mint" },
  // Comped accounts: g1t covers their usage, with no ceiling.
  internal: { label: "Comped", tone: "lavender" },
};

export function TrustBadge({ trust }: { trust: Trust }) {
  const { label, tone } = TRUST[trust] ?? { label: trust, tone: "plain" };
  return <Badge tone={tone}>{label}</Badge>;
}

const STATE = {
  ok: { label: "OK", fill: "var(--g1t-accent)", text: "text-accent" },
  warning: { label: "Warning", fill: "var(--g1t-warn)", text: "text-warn" },
  stopped: { label: "Stopped", fill: "var(--g1t-danger)", text: "text-danger" },
} as const;

export function StateBadge({ state }: { state: Limit["state"] }) {
  const tone = state === "stopped" ? "danger" : state === "warning" ? "warn" : "mint";
  return <Badge tone={tone}>{STATE[state].label}</Badge>;
}

/**
 * Usage this month that is not paid for yet, against the limit, as a bar
 * coloured by where it stands. With no limit (comped) it shows the figure.
 */
export function ExposureBar({ limit, wide = false }: { limit: Limit; wide?: boolean }) {
  const { exposureMicros, ceilingMicros, state } = limit;
  const share = ceilingMicros && ceilingMicros > 0 ? Math.min(1, Math.max(0, exposureMicros / ceilingMicros)) : 0;
  const percent = ceilingMicros && ceilingMicros > 0 ? Math.round((exposureMicros / ceilingMicros) * 100) : null;
  return (
    <div className={wide ? "w-full" : "w-40 max-w-full"}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular font-medium text-fg-soft">
          {usd(exposureMicros)}
          <span className="font-normal text-faint"> / {ceilingMicros == null ? "no limit" : usd(ceilingMicros)}</span>
        </span>
        {percent != null && <span className={`tabular ${STATE[state].text}`}>{percent}%</span>}
      </div>
      <svg viewBox="0 0 100 4" preserveAspectRatio="none" className="mt-1.5 block h-1.5 w-full" role="img" aria-label={`${STATE[state].label}: ${percent ?? 0}% of the limit`}>
        <rect x="0" y="0" width="100" height="4" rx="2" fill="var(--g1t-raised)" />
        {ceilingMicros != null && share > 0 && (
          <rect x="0" y="0" width={Math.max(2, share * 100)} height="4" rx="2" fill={STATE[state].fill} />
        )}
      </svg>
    </div>
  );
}

/** A label and a figure, for the strip of totals over a page. */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "warn" | "mint" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "mint" ? "text-accent" : "text-fg";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tabular mt-1 text-lg font-semibold tracking-tight ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** A timestamp, in UTC, as staff compare notes across time zones. */
export function When({ at, time = false }: { at: string | null | undefined; time?: boolean }) {
  if (!at) return <span className="text-faint">—</span>;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <span>{at}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {(time ? DATE_TIME : DATE).format(date)}
      {time && <span className="text-faint"> UTC</span>}
    </time>
  );
}

/** A letter avatar, drawn as SVG so its colour needs no inline style. */
export function Avatar({ name, size = 20, square = true }: { name: string; size?: number; square?: boolean }) {
  const hues = [82, 200, 262, 28, 330, 160];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = hues[Math.abs(hash) % hues.length];
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
      <rect width="20" height="20" rx={square ? 5 : 10} fill={`oklch(0.4 0.09 ${hue})`} />
      <text x="10" y="14.2" textAnchor="middle" fontSize="11" fontWeight="600" fontFamily="var(--g1t-font-mono)" fill={`oklch(0.93 0.08 ${hue})`}>
        {(name[0] ?? "?").toUpperCase()}
      </text>
    </svg>
  );
}
