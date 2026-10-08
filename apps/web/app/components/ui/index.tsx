import { Check, Copy, LoaderCircle, User } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode, useState } from "react";
import { Link, type LinkProps, NavLink, useLocation, useNavigation } from "react-router";

import { isWaitingMessage, linkPaths } from "../../lib/compute";
import { type Submission, isPending } from "../../lib/pending";
import { Mark } from "../logo";

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
      className={`${CONTROL} font-mono placeholder:font-sans`}
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
        `-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${
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

/** Soon, beside something that is coming: the same small pill in the sidebar and in tabs. */
export function SoonPill() {
  return (
    <span className="shrink-0 rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
      Soon
    </span>
  );
}

type Variant = "primary" | "accent" | "quiet" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50";

const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-white",
  accent: "bg-accent text-bg hover:bg-accent-hover",
  quiet:
    "border border-line text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg",
  // For what cannot be undone: transferring, deleting.
  danger: "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
};

export function Button({
  variant = "primary",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return (
    <button {...props} className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`} />
  );
}

/**
 * Whether the submission `fields` names is still working (lib/pending.ts):
 * the page's own navigation, or `fetcher`'s when the form is a fetcher's.
 */
export function usePending(fields?: Record<string, string | null | undefined>, fetcher?: Submission): boolean {
  const navigation = useNavigation();
  return isPending(fetcher ?? navigation, fields);
}

/**
 * A form's submit button that says it is working: turned off, with a
 * spinner and `pending` ("Saving…") in place of its words, from the moment
 * it is pressed until the page has loaded what it changed. Its own
 * `name`/`value` say which submission is its; `match` names it otherwise,
 * such as the form's hidden `intent`. `fetcher` when the form is a
 * fetcher's. `className` replaces the button look, for icon buttons, and
 * `icon` says the spinner takes the place of everything inside it. Words
 * with a leading icon should pass `pending`, so the spinner replaces both.
 */
export function SubmitButton({
  variant = "primary",
  pending,
  match,
  fetcher,
  busy,
  icon,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<"button">, "type"> & {
  variant?: Variant;
  /** The words while it works, such as "Saving…"; its own words when absent. */
  pending?: ReactNode;
  match?: Record<string, string | null | undefined>;
  fetcher?: Submission;
  /** Working for a reason this button cannot see by itself. */
  busy?: boolean;
  /** An icon button: while it works, the spinner is all it shows. */
  icon?: boolean;
}) {
  const own =
    typeof props.name === "string" && props.value != null ? { [props.name]: String(props.value) } : undefined;
  const working = usePending({ ...own, ...match }, fetcher) || Boolean(busy);
  return (
    <button
      {...props}
      type="submit"
      disabled={disabled || working}
      aria-busy={working || undefined}
      className={className ?? `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`}
    >
      {working ? (
        <>
          <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" />
          {icon ? null : (pending ?? children)}
        </>
      ) : (
        children
      )}
    </button>
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

/**
 * A message with the g1t pages it names as links, such as the billing page
 * a refusal to start compute points to.
 */
export function Linked({ text }: { text: string }) {
  return (
    <>
      {linkPaths(text).map((piece, at) =>
        piece.href ? (
          <Link key={at} to={piece.href} className="underline underline-offset-2">
            {piece.text}
          </Link>
        ) : (
          piece.text
        ),
      )}
    </>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  if (typeof children !== "string") return <p className="text-sm text-danger">{children}</p>;
  // Waiting for a free agent slot is not an error: it starts by itself.
  return (
    <p className={`text-sm ${isWaitingMessage(children) ? "text-muted" : "text-danger"}`}>
      <Linked text={children} />
    </p>
  );
}

/**
 * What a workspace's plan says before someone tries to start compute it
 * would refuse ("Agents need a paid workspace or the free trial"), with
 * where to fix it.
 */
export function ComputeNote({ note }: { note: string | null | undefined }) {
  return note ? (
    <p className="text-sm text-muted">
      <Linked text={note} />
    </p>
  ) : null;
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

/**
 * g1t itself: its agent, as reviewer, assignee and commit author, and the
 * system, as the author of security updates, the issues it opens and merges
 * from the queue. One name, `g1t`.
 */
export function isSystemName(name: string | null | undefined): boolean {
  return name === "g1t";
}

/** Where an uploaded avatar is served, from the hash it is stored by. */
export function avatarUrl(avatar: string): string {
  return `/avatars/${avatar}`;
}

/**
 * An uploaded avatar if there is one, else a letter avatar whose colour is
 * stable for a given name. People are round; a workspace is `square`. An
 * image that fails to load falls back to the letter.
 */
export function Avatar({
  name,
  size = 20,
  square,
  image,
  system,
}: {
  name: string;
  size?: number;
  square?: boolean;
  /** The uploaded avatar's hash, as identity returns it. */
  image?: string | null;
  /** g1t itself (a user of kind `system`), whatever the name. */
  system?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  // g1t itself wears its own mark: the pixel 1 on a dark square.
  if (system || isSystemName(name)) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center bg-[#0b0b0d] text-fg ring-1 ring-line-strong ring-inset"
        style={{ width: size, height: size, borderRadius: size * 0.24 }}
      >
        <Mark className="size-full" />
      </span>
    );
  }
  // ghost stands in for deleted accounts: a plain silhouette, as for
  // anyone on a commit who has no account.
  if (name === "ghost" && !image) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-line text-faint"
        style={{ width: size, height: size }}
      >
        <User size={Math.round(size * 0.62)} strokeWidth={2.25} />
      </span>
    );
  }
  if (image && failed !== image) {
    return (
      <img
        src={avatarUrl(image)}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(image)}
        className="inline-block shrink-0 bg-raised object-cover"
        style={{ width: size, height: size, borderRadius: square ? size * 0.24 : size }}
      />
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
  disabled,
  breakAtSlashes,
}: {
  text: string;
  prompt?: boolean;
  /** Shown, so it is clear what will be there, but not yet usable: dimmed, with no copy. */
  disabled?: boolean;
  /**
   * For a narrow box: an address longer than the line may wrap after a
   * `/`, so all of it shows, rather than scroll.
   */
  breakAtSlashes?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      aria-disabled={disabled || undefined}
      className={`group flex items-center gap-3 rounded-lg border border-line bg-surface py-2 pr-2 pl-3.5 font-mono text-[0.8125rem] ${disabled ? "cursor-not-allowed text-faint select-none" : ""}`}
    >
      {/* Wraps between words rather than hides: a command is no use half
          seen. A word itself, an address or a flag, is never broken in
          two, which would change what is copied by eye; one longer than
          the line scrolls sideways instead. */}
      <code className="min-w-0 grow overflow-x-auto whitespace-pre-wrap [scrollbar-width:thin]">
        {prompt && <span className="mr-2 text-faint select-none">$</span>}
        {text.split(/(\s+)/).map((part, index) =>
          /\S/.test(part) ? (
            breakAtSlashes ? (
              // Each piece whole, with a chance to wrap after each `/`.
              <span key={index}>
                {part.split(/(?<=\/)(?!\/)/).map((piece, at) => (
                  <Fragment key={at}>
                    {at > 0 && <wbr />}
                    <span className="whitespace-nowrap">{piece}</span>
                  </Fragment>
                ))}
              </span>
            ) : (
              <span key={index} className="whitespace-nowrap">
                {part}
              </span>
            )
          ) : (
            part
          ),
        )}
      </code>
      <button
        type="button"
        aria-label="Copy"
        disabled={disabled}
        className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-faint"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
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
