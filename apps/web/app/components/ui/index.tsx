import { Check, Copy, LoaderCircle } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode, useState } from "react";
import { Link, type LinkProps, NavLink, useLocation, useNavigation } from "react-router";

import { cn } from "../../lib/cn";
import { isWaitingMessage, linkPaths } from "../../lib/compute";
import { type Submission, isPending } from "../../lib/pending";
import { Button, type ButtonSize, type ButtonVariant, buttonVariants } from "./button";

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
 * fetcher's. It is drawn as the Button in ./button, with its `variant` and
 * `size`; `icon` says the spinner takes the place of everything inside
 * it. Words with a leading icon should pass `pending`, so the spinner
 * replaces both.
 */
export function SubmitButton({
  variant,
  size,
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
  variant?: ButtonVariant;
  size?: ButtonSize;
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
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
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

/** A link that looks like the Button in ./button, with its `variant` and `size`. */
export function ButtonLink({ variant, size, className, ...props }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link data-slot="button" {...props} className={cn(buttonVariants({ variant, size }), className)} />;
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
      <Button
        type="button"
        aria-label="Copy"
        disabled={disabled}
        variant="ghost"
        size="inline"
        className="p-1.5 text-faint"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      </Button>
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
