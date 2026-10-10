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
  LoaderCircle,
  Rocket,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "react-router";

import type { CardAction, CardActionResult, MessageCard, Result } from "@g1t/contracts";

import { Markdown } from "../markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge, type BadgeTone } from "../ui/badge";
import { InputAddon, InputGroup } from "../ui/input";
import { cn } from "../../lib/cn";
import { type CardChip, actionMode, cardChip, foldsBody, inputValue, moneyInitial, shownActions } from "../../lib/card-actions";
import { repoAt } from "../../lib/markdown-plugins";
import { sessionChip } from "../../lib/session-card";
import { codeAccessPath } from "../../lib/workspace-nav";

// A card g1t or an agent posts in chat: what
// it is about, its state, a preview, a few facts, and what people can do
// right here. Pressing an action goes to the site (routes/workspace/chat/
// api.ts, `card_action`), then to chat, then to the service that owns the
// card; the card changes in place when that service updates it
// (`message.updated`), so nothing here changes it ahead of time.

const CARD_ICONS: Record<string, ReactNode> = {
  pull: <GitPullRequest size={16} />,
  issue: <CircleDot size={16} />,
  draft_issue: <CircleDotDashed size={16} />,
  task: <ListChecks size={16} />,
  deploy: <Rocket size={16} />,
  approval: <ShieldCheck size={16} />,
  session: <Bot size={16} />,
  // Where an agent handed the work: the group message it went to.
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

/** Says something in the conversation's toasts: what a card's action did, or that a link was copied. */
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
 * The toasts that say what a card's action did. Put once in a conversation;
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
      aria-label="Card actions"
      aria-live="polite"
      className="pointer-events-none fixed z-[66] flex flex-col items-center gap-2 max-sm:inset-x-3 max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)] sm:bottom-28 sm:left-1/2 sm:w-[min(26rem,calc(100vw-2rem))] sm:-translate-x-1/2"
    >
      {list.map((toast) => (
        <div
          key={toast.id}
          role={toast.ok ? "status" : "alert"}
          className={cn(
            "pointer-events-auto flex w-full animate-pop-in items-start gap-2.5 rounded-xl bg-[#17171b] py-2.5 pr-2 pl-3 text-[0.8125rem] leading-snug text-fg shadow-[0_0_0_6px_var(--color-bg),0_20px_48px_-12px_rgba(0,0,0,0.9)] ring-1 motion-reduce:animate-none",
            toast.ok ? "ring-success/35" : "ring-danger/45",
          )}
        >
          <span className={cn("mt-px shrink-0", toast.ok ? "text-success" : "text-danger")} aria-hidden="true">
            {toast.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          </span>
          <p className="min-w-0 grow">{toast.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </section>
  );
}

// ── The card.

const ACTION_BASE =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 max-md:h-10 max-md:px-3.5";

const ACTION_STYLES: Record<NonNullable<CardAction["style"]>, string> = {
  primary: "bg-accent text-bg hover:bg-accent-hover",
  danger: "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
  default: "border border-line text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg",
};

function actionClass(action: CardAction, active = false) {
  return cn(ACTION_BASE, ACTION_STYLES[action.style ?? "default"], active && "border-accent/60 bg-raised text-fg");
}

/** Sends a card's action; says what happened in a toast; true when it was done. */
async function pressAction(slug: string, channelId: string, messageId: string, action: CardAction, input: string | null): Promise<boolean> {
  try {
    const response = await fetch(`/${slug}/-/chat/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "card_action", channel_id: channelId, message_id: messageId, action_id: action.id, input }),
    });
    const result = (await response.json()) as Result<CardActionResult>;
    if (!result.ok) {
      showToast(false, result.error.message);
      return false;
    }
    showToast(result.value.ok, result.value.message ?? (result.value.ok ? `${action.label}: done.` : `${action.label} didn't work.`));
    return result.value.ok;
  } catch {
    showToast(false, `${action.label} didn't go through. Try again in a moment.`);
    return false;
  }
}

/**
 * A card g1t or an agent posted: its title (a link when it goes somewhere),
 * its state, a line of detail, a preview, its facts, and its actions.
 */
export function CardBox({
  card,
  slug,
  code,
  channelId,
  messageId,
  inert = false,
}: {
  card: MessageCard;
  slug: string;
  /** Whether the viewer uses Code, for where links go. */
  code: boolean;
  channelId: string;
  messageId: string;
  /** Not yet sent, or gone: drawn, but nothing on it can be pressed. */
  inert?: boolean;
}) {
  const href = cardHref(card.href, slug, code);
  const chip = chipOf(card);
  const live = card.kind === "session" && !!chip?.live;
  const actions = shownActions(card);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CardAction | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const panelId = useId();
  const askingAction = actions.find((a) => a.id === asking && a.input) ?? null;

  // The card changed under an open field (the session finished, say): the
  // action it was for is gone, so the field goes too.
  useEffect(() => {
    if (asking && !askingAction) setAsking(null);
  }, [asking, askingAction]);

  const run = async (action: CardAction, input: string | null = null) => {
    if (busy || inert) return false;
    setBusy(action.id);
    const done = await pressAction(slug, channelId, messageId, action, input);
    setBusy(null);
    return done;
  };

  const press = (action: CardAction) => {
    switch (actionMode(action)) {
      case "input":
        setAsking((now) => (now === action.id ? null : action.id));
        return;
      case "confirm":
        setConfirming(action);
        return;
      case "run":
        void run(action);
        return;
    }
  };

  const closeField = (refocus: string | null) => {
    setAsking(null);
    if (refocus) requestAnimationFrame(() => triggers.current.get(refocus)?.focus());
  };

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
        <span className={cn("line-clamp-2 text-sm font-medium text-fg", href && "group-hover/head:underline group-hover/head:decoration-line-strong group-hover/head:underline-offset-2")}>
          {card.title}
        </span>
        {card.detail && <span className="mt-0.5 block truncate font-mono text-xs text-muted tabular-nums">{card.detail}</span>}
      </span>
      {card.state && chip && <StateChip state={card.state} chip={chip} />}
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
              <dd className="line-clamp-2 text-xs break-words text-fg-soft">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {actions.length > 0 && (
        <div
          role="group"
          aria-label={`${card.title}: actions`}
          className="mt-3 flex flex-wrap items-center gap-2 sm:pl-11"
          aria-busy={busy ? true : undefined}
          // A press here is for the button, not the message's long-press sheet.
          onTouchStart={(event) => event.stopPropagation()}
        >
          {actions.map((action) => {
            const target = actionMode(action) === "link" ? cardHref(action.href, slug, code) : null;
            if (target) {
              return (
                <Link key={action.id} to={target} className={actionClass(action)}>
                  {action.label}
                  <ArrowUpRight size={14} aria-hidden="true" className="-mr-0.5 text-faint" />
                </Link>
              );
            }
            const working = busy === action.id;
            const opens = !!action.input;
            return (
              <button
                key={action.id}
                ref={(element) => {
                  if (element) triggers.current.set(action.id, element);
                  else triggers.current.delete(action.id);
                }}
                type="button"
                disabled={inert || !!busy}
                aria-busy={working || undefined}
                aria-expanded={opens ? asking === action.id : undefined}
                aria-controls={opens && asking === action.id ? panelId : undefined}
                aria-haspopup={action.confirm && !opens ? "dialog" : undefined}
                onClick={() => press(action)}
                className={actionClass(action, opens && asking === action.id)}
              >
                {working && <LoaderCircle size={14} aria-hidden="true" className="-ml-0.5 animate-spin" />}
                {action.label}
              </button>
            );
          })}
        </div>
      )}

      {askingAction && (
        <ActionField
          key={askingAction.id}
          id={panelId}
          action={askingAction}
          busy={busy === askingAction.id}
          disabled={inert || !!busy}
          onCancel={() => closeField(askingAction.id)}
          onSubmit={async (value) => {
            if (await run(askingAction, value)) closeField(null);
          }}
        />
      )}

      <AlertDialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.label}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirming?.style === "danger" ? undefined : "bg-accent text-bg hover:bg-accent-hover"}
              onClick={() => {
                const action = confirming;
                setConfirming(null);
                if (action) void run(action);
              }}
            >
              {confirming?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      <div
        ref={box}
        id={id}
        className={cn("card-md relative rounded-lg border border-line/70 bg-bg/40 px-3 py-2", !open && "max-h-[11.5rem] overflow-hidden")}
      >
        <Markdown source={body} repo={repoAt(repo)} />
        {folded && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>
      {(folded || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((now) => !now)}
          className="mt-1 rounded px-1 py-0.5 text-xs font-medium text-accent transition-colors outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent/50 max-md:min-h-9"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * The value an action needs, asked right under the card: an amount with a
 * "$" before it and the suggestion filled in, or a line of text that grows
 * (Enter sends, Shift+Enter is a new line). Escape puts it away.
 */
function ActionField({
  id,
  action,
  busy,
  disabled,
  onSubmit,
  onCancel,
}: {
  id: string;
  action: CardAction;
  busy: boolean;
  disabled: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const input = action.input!;
  const money = input.kind === "money";
  const [value, setValue] = useState(() => (money ? moneyInitial(input.initial) : (input.initial ?? "")));
  const [tried, setTried] = useState(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const labelId = useId();
  const errorId = useId();
  const ready = inputValue(action, value);
  const invalid = tried && !ready;

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus();
    if (money) element.select();
  }, [money]);

  // A line of text grows with what is written, up to about six lines.
  useEffect(() => {
    const element = field.current;
    if (money || !element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value, money]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled) return;
    if (!ready) {
      setTried(true);
      field.current?.focus();
      return;
    }
    onSubmit(ready);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (!money && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      id={id}
      onSubmit={submit}
      onTouchStart={(event) => event.stopPropagation()}
      className="mt-3 animate-pop-in sm:pl-11 motion-reduce:animate-none"
      aria-labelledby={labelId}
    >
      <label id={labelId} htmlFor={`${id}-field`} className="mb-1.5 block text-xs font-medium text-muted">
        {input.label || action.label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {money ? (
          <InputGroup className={cn("sm:max-w-44 max-md:h-10", invalid && "border-danger/70")}>
            <InputAddon className="pr-0 font-mono text-muted">$</InputAddon>
            <input
              ref={field}
              id={`${id}-field`}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setTried(false);
              }}
              onKeyDown={onKeyDown}
              inputMode="decimal"
              autoComplete="off"
              data-1p-ignore
              placeholder={input.placeholder ?? "0.00"}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              className="w-full min-w-0 bg-transparent pr-3 pl-1 font-mono text-sm text-fg tabular-nums outline-none placeholder:text-faint"
            />
          </InputGroup>
        ) : (
          <textarea
            ref={field}
            id={`${id}-field`}
            rows={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setTried(false);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            data-1p-ignore
            placeholder={input.placeholder ?? undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            className="min-h-9 w-full min-w-0 grow resize-none rounded-md border border-line bg-bg px-3 py-[0.4375rem] text-sm leading-5 text-fg outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-line-strong focus-visible:border-accent-dim focus-visible:ring-2 focus-visible:ring-accent/25 aria-invalid:border-danger/70 max-md:min-h-10 max-md:text-base"
          />
        )}
        <div className="flex shrink-0 gap-2 max-sm:[&>*]:grow">
          <button type="button" onClick={onCancel} className={actionClass({ id: "cancel", label: "Cancel" })}>
            Cancel
          </button>
          <button type="submit" disabled={disabled} aria-busy={busy || undefined} className={actionClass({ ...action, style: action.style === "danger" ? "danger" : "primary" })}>
            {busy && <LoaderCircle size={14} aria-hidden="true" className="-ml-0.5 animate-spin" />}
            {action.label}
          </button>
        </div>
      </div>
      {invalid ? (
        <p id={errorId} className="mt-1.5 text-xs text-danger">
          {money ? "Enter an amount in dollars, like 5.00." : "Write something first."}
        </p>
      ) : (
        !money && <p className="mt-1.5 text-[0.6875rem] text-faint max-md:hidden">Enter to send, Shift+Enter for a new line, Esc to close</p>
      )}
    </form>
  );
}
