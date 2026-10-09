import { ArrowUpRight, CircleAlert, CircleCheck, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { CardAction, CardActionResult, FeedNotification, Result } from "@g1t/contracts";

import { Hint } from "../ui/hint";
import { InputAddon, InputGroup } from "../ui/input";
import { cn } from "../../lib/cn";
import { actionMode, inputValue, moneyInitial } from "../../lib/card-actions";
import { currentSink, dismiss, settle, useWaitingCards } from "../../lib/notify-client";
import { cardActionRequest, notificationActions } from "../../lib/notify-store";

// A chat card's actions on a notification about it (docs/WORKSPACE.md,
// "Cards"): a session at its cap (Approve more with the amount inline,
// Stop, Open), a draft issue (File issue, Discard). Pressing one sends the
// same `card_action` as the card in the conversation; the card there
// changes for everyone, and this notification is put away.

const BASE =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 max-sm:h-9 max-sm:px-3";

const STYLES: Record<NonNullable<CardAction["style"]>, string> = {
  primary: "bg-accent text-bg hover:bg-accent-hover",
  danger: "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
  default: "border border-line text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg",
};

const buttonClass = (style: CardAction["style"], active = false) => cn(BASE, STYLES[style ?? "default"], active && "border-accent/60 bg-raised text-fg");

type Said = { ok: boolean; message: string };

export function NotificationCardActions({
  notification,
  onNavigate,
  className,
}: {
  notification: FeedNotification;
  /** After a link is followed: closes the panel it is in. */
  onNavigate?: () => void;
  className?: string;
}) {
  const actions = notificationActions(notification);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (!actions.length) return null;
  const opened = actions.find((a) => a.id === open) ?? null;

  const run = async (action: CardAction, input: string | null) => {
    const request = cardActionRequest(notification, action, input);
    if (!request || busy) return;
    setBusy(action.id);
    setSaid(null);
    let answer: Said;
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const result = (await response.json()) as Result<CardActionResult>;
      answer = result.ok
        ? { ok: result.value.ok, message: result.value.message ?? (result.value.ok ? `${action.label}: done.` : `${action.label} didn't work.`) }
        : { ok: false, message: result.error.message };
    } catch {
      answer = { ok: false, message: `${action.label} didn't go through. Try again in a moment.` };
    }
    setBusy(null);
    setSaid(answer);
    if (answer.ok) {
      setOpen(null);
      // Long enough to read what happened, then it is put away.
      timer.current = setTimeout(() => settle(notification.id), 1_400);
    }
  };

  const press = (action: CardAction) => {
    const mode = actionMode(action);
    if (mode === "link") {
      dismiss(notification.id);
      onNavigate?.();
      currentSink().open(action.href!);
      return;
    }
    if (mode === "input" || mode === "confirm") {
      setOpen((now) => (now === action.id ? null : action.id));
      return;
    }
    void run(action, null);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div role="group" aria-label={`${notification.title}: actions`} className="flex flex-wrap items-center gap-1.5" aria-busy={busy ? true : undefined}>
        {actions.map((action) => {
          const mode = actionMode(action);
          const asks = mode === "input" || mode === "confirm";
          return (
            <button
              key={action.id}
              type="button"
              disabled={!!busy || !!said?.ok}
              aria-expanded={asks ? open === action.id : undefined}
              onClick={() => press(action)}
              className={buttonClass(action.style, asks && open === action.id)}
            >
              {busy === action.id && <LoaderCircle size={12} aria-hidden="true" className="-ml-0.5 animate-spin" />}
              {action.label}
              {mode === "link" && <ArrowUpRight size={12} aria-hidden="true" className="-mr-0.5 text-faint" />}
            </button>
          );
        })}
      </div>
      {opened && !said?.ok && (
        <Ask
          key={opened.id}
          action={opened}
          busy={busy === opened.id}
          onCancel={() => setOpen(null)}
          onSubmit={(value) => void run(opened, value)}
        />
      )}
      {said && (
        <p role={said.ok ? "status" : "alert"} className={cn("flex items-start gap-1.5 text-xs leading-snug", said.ok ? "text-success" : "text-danger")}>
          <span className="mt-px shrink-0" aria-hidden="true">
            {said.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
          </span>
          {said.message}
        </p>
      )}
    </div>
  );
}

/** What an action needs first, right there: an amount, a line of text, or a yes. */
function Ask({ action, busy, onSubmit, onCancel }: { action: CardAction; busy: boolean; onSubmit: (value: string | null) => void; onCancel: () => void }) {
  const input = action.input ?? null;
  const money = input?.kind === "money";
  const [value, setValue] = useState(() => (money ? moneyInitial(input?.initial) : (input?.initial ?? "")));
  const [tried, setTried] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const ready = input ? inputValue(action, value) : null;
  const invalid = !!input && tried && !ready;

  useEffect(() => {
    field.current?.focus();
    if (money) field.current?.select();
  }, [money]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (input && !ready) {
      setTried(true);
      field.current?.focus();
      return;
    }
    onSubmit(input ? ready : null);
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="rounded-lg bg-bg/70 p-2 ring-1 ring-line"
    >
      {input ? (
        <label htmlFor={id} className="mb-1.5 block text-[0.6875rem] font-medium text-muted">
          {input.label || action.label}
        </label>
      ) : (
        <p className="mb-2 text-xs leading-snug text-fg-soft">{action.confirm}</p>
      )}
      <div className="flex items-center gap-1.5">
        {input &&
          (money ? (
            <InputGroup className={cn("h-7 grow max-sm:h-9", invalid && "border-danger/70")}>
              <InputAddon className="pr-0 font-mono text-muted">$</InputAddon>
              <input
                ref={field}
                id={id}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setTried(false);
                }}
                inputMode="decimal"
                autoComplete="off"
                data-1p-ignore
                placeholder={input.placeholder ?? "0.00"}
                aria-invalid={invalid || undefined}
                className="w-full min-w-0 bg-transparent pr-2 pl-1 font-mono text-xs text-fg tabular-nums outline-none placeholder:text-faint max-sm:text-base"
              />
            </InputGroup>
          ) : (
            <input
              ref={field}
              id={id}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setTried(false);
              }}
              autoComplete="off"
              data-1p-ignore
              placeholder={input.placeholder ?? undefined}
              aria-invalid={invalid || undefined}
              className="h-7 min-w-0 grow rounded-md border border-line bg-bg px-2 text-xs text-fg outline-none placeholder:text-faint focus-visible:border-accent-dim aria-invalid:border-danger/70 max-sm:h-9 max-sm:text-base"
            />
          ))}
        <div className={cn("flex shrink-0 gap-1.5", !input && "w-full justify-end")}>
          <button type="button" onClick={onCancel} className={buttonClass("default")}>
            Cancel
          </button>
          <button type="submit" disabled={busy} aria-busy={busy || undefined} className={buttonClass(action.style === "danger" ? "danger" : "primary")}>
            {busy && <LoaderCircle size={12} aria-hidden="true" className="-ml-0.5 animate-spin" />}
            {action.label}
          </button>
        </div>
      </div>
      {invalid && <p className="mt-1.5 text-[0.6875rem] text-danger">{money ? "Enter an amount in dollars, like 5.00." : "Write something first."}</p>}
    </form>
  );
}

/**
 * The chat cards waiting on the person, at the top of the notifications
 * panel: each one's title and preview, a link to where it is, and its
 * actions. Gone once acted on here, or after a day.
 */
export function WaitingCards({ onNavigate }: { onNavigate?: () => void }) {
  const waiting = useWaitingCards();
  if (!waiting.length) return null;
  return (
    <section aria-labelledby="waiting-cards" className="mb-4">
      <h3 id="waiting-cards" className="mb-2 text-xs font-medium text-muted">
        Waiting on you in chat
      </h3>
      <ul className="space-y-2">
        {waiting.map((notification) => (
          <li key={notification.id} className="relative rounded-lg border border-line bg-surface p-3">
            <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-accent" />
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  currentSink().open(notification.href);
                }}
                className="min-w-0 grow rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <span className="block truncate text-sm font-medium text-fg hover:underline">{notification.title}</span>
                {notification.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{notification.body}</span>}
              </button>
              <Hint label="Put away">
                <button
                  type="button"
                  aria-label="Put away"
                  onClick={() => settle(notification.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
                >
                  <X size={14} />
                </button>
              </Hint>
            </div>
            <NotificationCardActions notification={notification} onNavigate={onNavigate} className="mt-2.5" />
          </li>
        ))}
      </ul>
    </section>
  );
}
