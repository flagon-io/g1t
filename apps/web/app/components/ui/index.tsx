import { Check, Copy, Sparkles } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Link, type LinkProps, NavLink, useLocation } from "react-router";

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
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

/**
 * Attributes for a field that is not part of signing in. Password managers
 * guess from names such as "name", "title" and "username" and offer to
 * fill a login into them; these tell 1Password, LastPass, Bitwarden and
 * Dashlane to leave the field alone. A field that states what it takes with
 * `autoComplete` is left to them.
 */
export function notACredential(autoComplete?: string) {
  if (autoComplete) return {};
  return {
    autoComplete: "off",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-bwignore": true,
    "data-form-type": "other",
  };
}

export function Input(props: ComponentProps<"input">) {
  return <input {...notACredential(props.autoComplete)} {...props} className={CONTROL} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return (
    <textarea
      {...notACredential(props.autoComplete)}
      {...props}
      className={`${CONTROL} font-mono`}
    />
  );
}

/** One tab in the row under a repository's or a workspace's header. */
export function TabLink({
  to,
  also,
  end,
  icon,
  count,
  children,
}: {
  to: string;
  /** Another path prefix under which this tab is the current one. */
  also?: string;
  end?: boolean;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm whitespace-nowrap transition-colors ${
          isActive || (also && pathname.startsWith(also + "/"))
            ? "border-accent font-medium text-fg"
            : "border-transparent text-muted hover:text-fg"
        }`
      }
    >
      {icon}
      {children}
      {count != null && count > 0 && (
        <span className="rounded-full bg-raised px-1.5 py-px text-xs text-muted">
          {count}
        </span>
      )}
    </NavLink>
  );
}

type Variant = "primary" | "accent" | "quiet";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50";

const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-white",
  accent: "bg-accent text-bg hover:bg-[#aaf5d6]",
  quiet:
    "border border-line text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg",
};

export function Button({
  variant = "primary",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return (
    <button {...props} className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`} />
  );
}

/** A link that looks like a button. */
export function ButtonLink({
  variant = "primary",
  large,
  ...props
}: LinkProps & { variant?: Variant; large?: boolean }) {
  return (
    <Link
      {...props}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${
        large ? "rounded-full px-5 py-2.5" : ""
      }`}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="text-sm text-danger">{children}</p> : null;
}

/** A small outlined label. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs text-muted">
      {children}
    </span>
  );
}

const AVATAR_HUES = [82, 200, 262, 28, 330, 160];

/** How g1t's agents are named: as reviewers and assignees, and as commit authors. */
const AGENT_NAMES = new Set(["g1t-agent", "g1t agent", "g1t"]);

/**
 * A letter avatar whose colour is stable for a given name. People are
 * round; a workspace is `square`.
 */
export function Avatar({
  name,
  size = 20,
  square,
}: {
  name: string;
  size?: number;
  square?: boolean;
}) {
  // g1t's own agents wear the agent colour and mark everywhere they appear.
  if (AGENT_NAMES.has(name)) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center bg-merged/20 text-merged ring-1 ring-merged/40 ring-inset"
        style={{ width: size, height: size, borderRadius: size * 0.3 }}
      >
        <Sparkles size={Math.round(size * 0.58)} />
      </span>
    );
  }
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-mono font-semibold uppercase"
      style={{
        width: size,
        height: size,
        borderRadius: square ? size * 0.24 : size,
        fontSize: size * 0.5,
        background: `oklch(0.4 0.09 ${hue})`,
        color: `oklch(0.93 0.08 ${hue})`,
      }}
    >
      {name[0]}
    </span>
  );
}

/** A line of text (usually a command) with a copy button. */
export function CopyLine({
  text,
  prompt,
}: {
  text: string;
  prompt?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-line bg-surface py-2 pr-2 pl-3.5 font-mono text-[0.8125rem]">
      {/* Wraps rather than hides: a command or an address is no use half seen. */}
      <code className="min-w-0 grow whitespace-pre-wrap [overflow-wrap:anywhere]">
        {prompt && <span className="mr-2 text-faint select-none">$</span>}
        {/* Short words with hyphens, such as `--transport`, stay whole when
            the line wraps; long ones, such as addresses, may still break. */}
        {text.split(/(\s+)/).map((part, index) =>
          part.includes("-") && part.length <= 24 ? (
            <span key={index} className="whitespace-nowrap">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </code>
      <button
        type="button"
        aria-label="Copy"
        className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

const UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

/** Compact relative time such as "5m ago". */
export function TimeAgo({ at }: { at: string | number }) {
  // Timestamps are RFC 3339 strings; a few older ones are still numbers.
  const elapsed = Date.now() - new Date(at).getTime();
  const unit = UNITS.find(([, size]) => elapsed >= size);
  const label = unit ? `${Math.floor(elapsed / unit[1])}${unit[0]} ago` : "just now";
  return (
    // The server and the browser render at slightly different times.
    <time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
      {label}
    </time>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1.5 text-sm text-muted">{children}</div>}
    </div>
  );
}
