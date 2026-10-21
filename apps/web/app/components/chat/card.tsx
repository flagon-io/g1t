import {
  ArrowUpRight,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleDotDashed,
  Forward,
  GitPullRequest,
  ListChecks,
  Rocket,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import type { CardAction, MessageCard } from "@g1t/contracts";

import { Markdown } from "../markdown";
import { Badge, type BadgeTone } from "../ui/badge";
import { ButtonLink } from "../ui";
import { Button, type ButtonVariant } from "../ui/button";
import { cn } from "../../lib/cn";
import { type CardChip, cardChip, foldsBody, shownActions } from "../../lib/card-actions";
import { repoAt } from "../../lib/markdown-plugins";
import { sessionChip } from "../../lib/session-card";
import { useHostedSessionState } from "../../lib/use-session-follow";
import { codeAccessPath } from "../../lib/workspace-nav";

// A card g1t posts in chat (or an agent did, on old messages): what it is
// about, its state, a preview, a few facts, and links to where it goes.
// The card changes in place when the service that posted it updates it
// (`message.updated`). Buttons that ran something on an old agent's card
// are not shown: nothing answers them any more.

const CARD_ICONS: Record<string, ReactNode> = {
  pull: <GitPullRequest size={16} />,
  work_item: <CircleDot size={16} />,
  draft_work_item: <CircleDotDashed size={16} />,
  task: <ListChecks size={16} />,
  deploy: <Rocket size={16} />,
  approval: <ShieldCheck size={16} />,
  session: <Bot size={16} />,
  // Where an agent handed the work, on old messages: the group message it went to.
  handoff: <Forward size={16} />,
};

/** Where a card's link goes for this viewer: a member without Code goes to the workspace's own view of it. */
export function cardHref(href: string | null | undefined, slug: string, code: boolean): string | null {
  if (!href) return null;
  if (code || !/^\/[^/]+\/(?!-\/)[^/]+/.test(href)) return href;
  return codeAccessPath(slug, href);
}

/** How loud a card's state reads, from what it says, for kinds without chips of their own. */
function stateTone(state: string): BadgeTone {
  const s = state.toLowerCase();
  if (/merged/.test(s)) return "merged";
  if (/fail|error|blocked|over budget|rejected/.test(s)) return "danger";
  if (/approval|waiting|review|queued|needs/.test(s)) return "warn";
  if (/pass|done|deployed|ready|approved|live|success/.test(s)) return "success";
  if (/working|running|in progress|open/.test(s)) return "info";
  return "neutral";
}

function chipOf(card: MessageCard): CardChip | null {
  if (!card.state) return null;
  if (card.kind === "session") return sessionChip(card.state);
  return cardChip(card) ?? { tone: stateTone(card.state), live: false };
}

/**
 * A card's state, as a chip: a session's Working pulses softly in lavender,
 * Needs approval is amber, Done green; a draft issue is outlined lavender
 * until it is filed (green) or discarded (quiet).
 */
function StateChip({ state, chip }: { state: string; chip: CardChip }) {
  return (
    <Badge tone={chip.tone} className={cn("mt-0.5", chip.outline && "bg-transparent")}>
      {chip.live && (
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {state}
    </Badge>
  );
}

// ── What pressing an action said, as a toast above the composer.

type CardToast = { id: number; ok: boolean; message: string };

const TOAST_MS = 4_500;
const NO_TOASTS: CardToast[] = [];
let toasts: CardToast[] = NO_TOASTS;
let toastSeq = 0;
const toastListeners = new Set<() => void>();

function setToasts(next: CardToast[]) {
  toasts = next;
  for (const listener of toastListeners) listener();
}

function dismissToast(id: number) {
  setToasts(toasts.filter((t) => t.id !== id));
}

/** Says something in the conversation's toasts: that a link was copied, say. */
export function showToast(ok: boolean, message: string) {
  const id = ++toastSeq;
  // Three at most; a fourth pushes the oldest out.
  setToasts([...toasts.slice(-2), { id, ok, message }]);
  setTimeout(() => dismissToast(id), ok ? TOAST_MS : TOAST_MS * 1.5);
}

function subscribeToasts(listener: () => void) {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

/**
 * The conversation's toasts (a link copied, or not). Put once in a conversation;
 * along the top on a phone, above the composer on a computer, clear of the
 * notification toasts in the corner.
 */
export function CardToasts() {
  const list = useSyncExternalStore(
    subscribeToasts,
    () => toasts,
    () => NO_TOASTS,
  );
  return (
    <section
      aria-label="Notices"
      aria-live="polite"
      className="pointer-events-none fixed z-66 flex flex-col items-center gap-2 max-sm:inset-x-3 max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)] sm:bottom-28 sm:left-1/2 sm:w-[min(26rem,calc(100vw-2rem))] sm:-translate-x-1/2"
    >
      {list.map((toast) => (
        <div
          key={toast.id}
          role={toast.ok ? "status" : "alert"}
          className={cn(
            "pointer-events-auto flex w-full animate-pop-in items-start gap-2.5 rounded-xl bg-surface py-2.5 pr-2 pl-3 text-[0.8125rem] leading-snug text-fg shadow-[0_0_0_6px_var(--color-bg),0_20px_48px_-12px_rgba(0,0,0,0.9)] ring-1 motion-reduce:animate-none",
            toast.ok ? "ring-success/35" : "ring-danger/45",
          )}
        >
          <span className={cn("mt-px shrink-0", toast.ok ? "text-success" : "text-danger")} aria-hidden="true">
            {toast.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          </span>
          <p className="min-w-0 grow">{toast.message}</p>
          <Button type="button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)} variant="ghost" size="icon" className="size-6 text-faint">
            <X size={14} />
          </Button>
        </div>
      ))}
    </section>
  );
}

// ── The card.

/** A card's links are small buttons, a finger tall on a phone; the action's style names the variant. */
const ACTION_VARIANT: Record<NonNullable<CardAction["style"]>, ButtonVariant> = { primary: "accent", danger: "destructive", default: "outline" };

function actionProps(action: Pick<CardAction, "style">) {
  return { variant: ACTION_VARIANT[action.style ?? "default"], size: "sm" as const, className: "max-md:h-10 max-md:px-3.5" };
}

/**
 * A card g1t (or, on old messages, an agent) posted: its title (a link
 * when it goes somewhere), its state, a line of detail, a preview, its
 * facts, and its links.
 */
export function CardBox({
  card,
  slug,
  code,
}: {
  card: MessageCard;
  slug: string;
  /** Whether the viewer uses Code, for where links go. */
  code: boolean;
}) {
  const href = cardHref(card.href, slug, code);
  // A hosted session g1t started from the conversation reads as it stands now: Working pulses until Done.
  const now = useHostedSessionState(slug, card);
  const state = now ?? card.state;
  const chip = now ? { ...sessionChip(now), live: now === "Working" } : chipOf(card);
  const live = card.kind === "session" && !!chip?.live;
  const actions = shownActions(card);
  const head = (
    <>
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
          live ? "bg-accent/10 text-accent" : "bg-raised text-muted group-hover/card:text-fg",
        )}
      >
        {CARD_ICONS[card.kind] ?? <Sparkles size={16} />}
      </span>
      <span className="min-w-0 grow">
        <span
          className={cn(
            "line-clamp-2 text-sm font-medium text-fg",
            href && "group-hover/head:underline group-hover/head:decoration-line-strong group-hover/head:underline-offset-2",
          )}
        >
          {card.title}
        </span>
        {card.detail && <span className="mt-0.5 block truncate font-mono text-xs text-muted tabular-nums">{card.detail}</span>}
      </span>
      {state && chip && <StateChip state={state} chip={chip} />}
    </>
  );

  const repository = card.fields?.find((f) => f.label.toLowerCase() === "repository")?.value;

  return (
    <div
      className={cn(
        "group/card mt-1.5 w-full max-w-xl rounded-xl border bg-surface px-3.5 py-3 transition-[transform,box-shadow,border-color] duration-150",
        "hover:-translate-y-px hover:border-line-strong hover:shadow-lg hover:shadow-black/25 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        live ? "border-accent/25" : "border-line",
      )}
    >
      {href ? (
        <Link to={href} className="group/head -m-1 flex items-start gap-3 rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          {head}
        </Link>
      ) : (
        <div className="flex items-start gap-3">{head}</div>
      )}

      {card.body && <CardBody body={card.body} repo={repository} />}

      {card.fields && card.fields.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:pl-11">
          {card.fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-[0.6875rem] font-medium text-faint">{field.label}</dt>
              <dd className="line-clamp-2 text-xs wrap-break-word text-fg-soft">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions.length > 0 && (
        <div
          role="group"
          aria-label={`${card.title}: links`}
          className="mt-3 flex flex-wrap items-center gap-2 sm:pl-11"
          // A press here is for the link, not the message's long-press sheet.
          onTouchStart={(event) => event.stopPropagation()}
        >
          {actions.map((action) => {
            const target = cardHref(action.href, slug, code);
            return target ? (
              <ButtonLink key={action.id} to={target} {...actionProps(action)}>
                {action.label}
                <ArrowUpRight size={14} aria-hidden="true" className="-mr-0.5 text-faint" />
              </ButtonLink>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

/** A card's Markdown preview: about eight lines, then "Show more". */
function CardBody({ body, repo }: { body: string; repo?: string }) {
  const [open, setOpen] = useState(false);
  // Folded by its length at first (the same on the server), then by whether it really overflows.
  const [folds, setFolds] = useState(() => foldsBody(body));
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const element = box.current;
    if (!element || open) return;
    const measure = () => setFolds(element.scrollHeight > element.clientHeight + 2);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [body, open]);
  const folded = folds && !open;
  return (
    <div className="mt-2.5 sm:pl-11">
      <div ref={box} id={id} className={cn("card-md relative rounded-lg border border-line/70 bg-bg/40 px-3 py-2", !open && "max-h-46 overflow-hidden")}>
        <Markdown source={body} repo={repoAt(repo)} />
        {folded && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg bg-linear-to-t from-surface to-transparent" />
        )}
      </div>
      {(folded || open) && (
        <Button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((now) => !now)}
          variant="ghost"
          size="inline"
          className="mt-1 rounded px-1 py-0.5 text-xs text-accent focus-visible:ring-accent/50 max-md:min-h-9"
        >
          {open ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}
