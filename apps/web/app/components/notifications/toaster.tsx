import { AtSign, BellRing, CornerDownLeft, GitPullRequest, Hourglass, Inbox, MessageCircle, MessagesSquare, X } from "lucide-react";
import { type FormEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import type { FeedNotification, NotificationKind } from "@g1t/contracts";

import { NotificationCardActions } from "./card-actions";
import { MemberAvatar } from "../chat/marks";
import { Avatar } from "../ui";
import { closeOffer, currentSink, declinePush, dismiss, enablePush, useNotifyState } from "../../lib/notify-client";
import { TOAST_GUESS, TOAST_MS, canQuickReply, hiddenToFit, notificationActions, quickReplyRequest } from "../../lib/notify-store";

const KIND: Record<NotificationKind, { label: string; icon: ReactNode }> = {
  dm: { label: "Direct message", icon: <MessageCircle /> },
  mention: { label: "Mentioned you", icon: <AtSign /> },
  thread_reply: { label: "Replied in a thread", icon: <MessagesSquare /> },
  inbox: { label: "Inbox", icon: <Inbox /> },
  agent_waiting: { label: "Waiting on you", icon: <Hourglass /> },
  approval: { label: "Needs your review", icon: <GitPullRequest /> },
};

/** Room kept clear of the stack: the top bar and the edge on a computer; the top inset and the tab bar on a phone. */
const DESKTOP_MARGIN = 84;
const PHONE_MARGIN = 112;

/** Said to you, so drawn in the accent. */
const LOUD: ReadonlySet<NotificationKind> = new Set(["dm", "mention", "agent_waiting", "approval"]);

// The toast's entrance (up from the corner on a computer, down from the top
// on a phone) and its timer, a line that empties over TOAST_MS. Paused while
// the pointer or the keyboard is on the stack.
const STYLES = `
@keyframes g1t-toast-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes g1t-toast-in-top { from { opacity: 0; transform: translateY(-10px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes g1t-toast-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.g1t-toast { animation: g1t-toast-in 0.26s cubic-bezier(0.16, 1, 0.3, 1); }
@media (max-width: 639px) { .g1t-toast { animation-name: g1t-toast-in-top; } }
.g1t-toast-timer { animation: g1t-toast-timer linear forwards; transform-origin: left; }
@media (prefers-reduced-motion: reduce) { .g1t-toast { animation: none; } }
`;

function ActorAvatar({ notification }: { notification: FeedNotification }) {
  const { actor } = notification;
  if (actor.kind === "user" || actor.kind === "agent") {
    return (
      <MemberAvatar
        member={{ kind: actor.kind, id: actor.id, name: actor.name, avatar: actor.avatar ?? null, avatar_seed: actor.avatar_seed ?? null }}
        size={32}
      />
    );
  }
  return <Avatar name={actor.name} system={actor.id === "g1t"} square size={32} />;
}

function QuickReply({ notification, onSent }: { notification: FeedNotification; onSent: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const first = notification.actor.name.split(" ")[0];
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const request = quickReplyRequest(notification, text);
    if (!request || state === "sending") return;
    setState("sending");
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const answer = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !answer?.ok) throw new Error("not sent");
      setState("sent");
      setText("");
      setTimeout(onSent, 900);
    } catch {
      setState("failed");
    }
  };
  if (state === "sent") {
    return <p className="px-3 pb-3 text-xs text-success">Sent</p>;
  }
  return (
    <form onSubmit={send} className="px-3 pb-3">
      <div className="flex items-center gap-1.5 rounded-lg bg-bg/80 py-1 pr-1 pl-2.5 ring-1 ring-line transition-shadow focus-within:ring-accent-dim">
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (state === "failed") setState("idle");
          }}
          placeholder={`Reply to ${first}…`}
          aria-label={`Reply to ${notification.actor.name}`}
          autoComplete="off"
          data-1p-ignore
          className="h-7 min-w-0 grow bg-transparent text-[0.8125rem] text-fg outline-none placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={!text.trim() || state === "sending"}
          aria-label="Send reply"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-bg transition-opacity disabled:opacity-30"
        >
          <CornerDownLeft size={14} />
        </button>
      </div>
      {state === "failed" && <p className="mt-1.5 text-xs text-danger">That didn't send. Open the conversation to try again.</p>}
    </form>
  );
}

function ToastCard({ notification, paused }: { notification: FeedNotification; paused: boolean }) {
  const kind = KIND[notification.kind];
  const loud = LOUD.has(notification.kind);
  // A card's actions (Approve more, Stop, File issue…): more time to decide.
  const card = notificationActions(notification).length > 0;
  const open = () => {
    dismiss(notification.id);
    currentSink().open(notification.href);
  };
  return (
    <div
      role="status"
      className="g1t-toast group/toast pointer-events-auto relative overflow-hidden rounded-xl bg-[#17171b] shadow-[0_0_0_6px_var(--color-bg),0_20px_48px_-12px_rgba(0,0,0,0.9)] ring-1 ring-line-strong"
    >
      {loud && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
      <button type="button" onClick={open} className="flex w-full items-start gap-3 p-3 pr-9 text-left outline-none focus-visible:bg-raised/60">
        <span className="mt-0.5 shrink-0">
          <ActorAvatar notification={notification} />
        </span>
        <span className="min-w-0 grow">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[0.8125rem] font-semibold text-fg">{notification.title}</span>
            <span className="shrink-0 text-[0.6875rem] text-faint">now</span>
          </span>
          <span className={`mt-0.5 flex items-center gap-1 text-[0.6875rem] font-medium [&_svg]:size-3 ${loud ? "text-accent" : "text-faint"}`}>
            {kind.icon}
            {kind.label}
          </span>
          {notification.body && <span className="mt-1 line-clamp-2 block text-[0.8125rem] leading-snug text-muted">{notification.body}</span>}
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(notification.id)}
        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-faint opacity-0 transition-opacity group-hover/toast:opacity-100 hover:bg-raised hover:text-fg focus-visible:opacity-100 max-sm:opacity-100"
      >
        <X size={14} />
      </button>
      {card && <NotificationCardActions notification={notification} className="px-3 pb-3 sm:pl-14" />}
      {!card && canQuickReply(notification) && <QuickReply notification={notification} onSent={() => dismiss(notification.id)} />}
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-line">
        <span
          className="g1t-toast-timer block h-full bg-accent/70"
          style={{ animationDuration: `${card ? TOAST_MS * 2 : TOAST_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
          onAnimationEnd={() => dismiss(notification.id)}
        />
      </span>
    </div>
  );
}

/** The offer to turn on browser notifications, after the first DM or mention toast. */
function PushOffer() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="g1t-toast pointer-events-auto flex items-center gap-3 rounded-xl bg-[#17171b] p-3 shadow-[0_0_0_6px_var(--color-bg),0_20px_48px_-12px_rgba(0,0,0,0.9)] ring-1 ring-accent/35">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
        <BellRing size={16} />
      </span>
      <p className="min-w-0 grow text-[0.8125rem] leading-snug text-fg">Get notified when someone messages you</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await enablePush();
          setBusy(false);
          closeOffer();
        }}
        className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? "Turning on…" : "Turn on"}
      </button>
      <button
        type="button"
        aria-label="No thanks"
        onClick={declinePush}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * The toasts: bottom right on a computer, along the top on a phone, three
 * at most, each gone after six seconds unless the pointer or the keyboard
 * is on them.
 */
export function Toaster() {
  const { toasts, offer } = useNotifyState();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [, setResized] = useState(0);
  const stack = useRef<HTMLElement | null>(null);
  const heights = useRef(new Map<string, number>());

  // Taller than the screen: the oldest fold into "+N more", newest kept.
  useLayoutEffect(() => {
    const element = stack.current;
    if (!element) return;
    for (const card of element.querySelectorAll<HTMLElement>("[data-toast-id]")) heights.current.set(card.dataset.toastId!, card.offsetHeight);
    const live = new Set(toasts.map((t) => t.notification.id));
    for (const id of heights.current.keys()) if (!live.has(id)) heights.current.delete(id);
    const offerHeight = element.querySelector<HTMLElement>("[data-offer]")?.offsetHeight ?? 0;
    const phone = window.matchMedia("(max-width: 639px)").matches;
    const available = window.innerHeight - (phone ? PHONE_MARGIN : DESKTOP_MARGIN);
    const fit = hiddenToFit(
      toasts.map((t) => heights.current.get(t.notification.id) ?? TOAST_GUESS),
      available,
      offerHeight,
    );
    if (fit !== hidden) setHidden(fit);
  });
  useLayoutEffect(() => {
    const onResize = () => setResized((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!toasts.length && !offer) return null;
  const paused = hovered || focused;
  const folded = toasts.slice(0, hidden);
  const shown = toasts.slice(hidden);
  return (
    <section
      ref={stack}
      aria-label="Notifications"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      className="pointer-events-none fixed z-[65] flex flex-col gap-2 max-sm:inset-x-3 max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)] max-sm:flex-col-reverse sm:right-5 sm:bottom-5 sm:w-[376px]"
    >
      <style>{STYLES}</style>
      {offer && (
        <div data-offer>
          <PushOffer />
        </div>
      )}
      {folded.length > 0 && (
        <div className="pointer-events-auto flex h-[30px] items-center justify-between gap-2 self-center rounded-full bg-[#17171b] pr-1 pl-3 text-xs text-muted shadow-[0_0_0_6px_var(--color-bg),0_10px_30px_-10px_rgba(0,0,0,0.9)] ring-1 ring-line-strong">
          <span className="font-medium text-fg tabular-nums">+{folded.length} more</span>
          <button
            type="button"
            onClick={() => folded.forEach((t) => dismiss(t.notification.id))}
            aria-label={`Clear ${folded.length} older ${folded.length === 1 ? "notification" : "notifications"}`}
            className="rounded-full px-2 py-0.5 text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            Clear
          </button>
        </div>
      )}
      {shown.map((toast) => (
        <div key={toast.notification.id} data-toast-id={toast.notification.id}>
          <ToastCard notification={toast.notification} paused={paused} />
        </div>
      ))}
    </section>
  );
}
