import { ChevronsDown, ChevronsUp, CircleDot, GitPullRequest, PlayCircle, Rocket, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { AgentApproval, InboxItem } from "@g1t/contracts";

import type { InboxPanelData } from "../routes/inbox-json";
import type { ApprovalsData } from "../routes/workspace/approvals-json";
import { cn } from "../lib/cn";
import { REASON_LABEL, needsAttention, whenShort } from "../lib/inbox";
import { approvalWhat, attentionEntries, attentionKey, timeLeft, toolName } from "../lib/session-approvals";
import { sessionPath } from "../lib/work-items";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** Rows shown before Show more. */
const FIRST = 3;

/** What each kind of item is, as its card's mark. */
const SUBJECT_ICON: Record<NonNullable<InboxItem["subject"]>, ReactNode> = {
  pull: <GitPullRequest size={16} />,
  item: <CircleDot size={16} />,
  run: <PlayCircle size={16} />,
  deploy: <Rocket size={16} />,
};

/**
 * What waits on you, at the top of a sidebar: a card of the notifications
 * that need you in this workspace (a review asked of you, a check that wants
 * a look), newest first, three and then Show more. Each row opens its card
 * beside the sidebar: what it is, why you were told, and what to do now:
 * Review (open it), Snooze it to tomorrow, or Dismiss it (done). The list is
 * the inbox's Needs you (`/inbox.json?tab=needs`), read when the sidebar is
 * drawn and again when the window comes back into view. Beside them, newest
 * first with them, are the hosted sessions' calls waiting on your approval
 * (`-/approvals.json`), whose card's Review opens the session, where they
 * are allowed or denied. Nothing is drawn while it is on its way, when it
 * could not be read, or when nothing waits.
 */
export function NeedsAttention({ slug, className }: { slug: string; className?: string }) {
  const list = useFetcher<InboxPanelData>({ key: "needs-attention" });
  // The hosted sessions' calls waiting on the viewer's answer, beside the notifications.
  const waiting = useFetcher<ApprovalsData>({ key: "needs-attention-approvals" });
  const mark = useFetcher({ key: "needs-attention-mark" });
  const [more, setMore] = useState(false);
  // Dismissed or snoozed here: gone at once, before the inbox has said so.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // Its own: the sidebar beside the page and the drawer each draw one.
  const heading = useId();

  useEffect(() => {
    const read = () => {
      if (document.visibilityState !== "visible") return;
      list.load("/inbox.json?tab=needs&for=attention");
      waiting.load(`/${encodeURIComponent(slug)}/-/approvals.json`);
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const items = useMemo(() => {
    const now = Date.now();
    return attentionEntries(needsAttention(list.data?.items ?? [], slug, now, hidden), waiting.data?.approvals ?? [], now);
  }, [list.data, waiting.data, slug, hidden]);
  if (items.length === 0) return null;
  const shown = more ? items : items.slice(0, FIRST);

  const settle = (item: InboxItem, intent: "done" | "snooze") => {
    setHidden((was) => new Set([...was, item.id]));
    const form = new FormData();
    form.set("intent", intent);
    form.set("id", item.id);
    if (intent === "snooze") form.set("for", "tomorrow");
    mark.submit(form, { method: "post", action: "/notifications" });
  };

  return (
    <section aria-labelledby={heading} className={cn("mx-2 overflow-hidden rounded-xl bg-bg shadow-xs ring-1 ring-sidebar-border", className)}>
      <h2 id={heading} className="flex items-center justify-between px-3 pt-2.5 pb-1 text-xs text-faint">
        Needs attention
        <span className="rounded-full bg-danger/10 px-1.5 text-[0.6875rem] font-medium text-danger tabular-nums">{items.length}</span>
      </h2>
      <ul className="px-1 pb-1">
        {shown.map((entry) =>
          entry.kind === "inbox" ? (
            <AttentionRow key={attentionKey(entry)} item={entry.item} onSettle={(intent) => settle(entry.item, intent)} />
          ) : (
            <ApprovalRow key={attentionKey(entry)} approval={entry.approval} slug={slug} />
          ),
        )}
      </ul>
      {items.length > FIRST && (
        <button
          type="button"
          onClick={() => setMore((open) => !open)}
          aria-expanded={more}
          className="flex h-8 w-full items-center gap-2 border-t border-sidebar-border bg-sidebar/50 px-3 text-xs text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        >
          {more ? <ChevronsUp size={14} className="text-faint" /> : <ChevronsDown size={14} className="text-faint" />}
          {more ? "Show fewer" : `Show ${items.length - FIRST} more`}
        </button>
      )}
    </section>
  );
}

/** A row's popover beside the sidebar: the same frame for a notification and a waiting call. */
const CARD_CLASS = "w-88 rounded-2xl border-line bg-bg p-0 shadow-lg shadow-black/10";

/** A hosted session's call that waits on the viewer: an amber dot and what it wants to do, opening its card. */
function ApprovalRow({ approval, slug }: { approval: AgentApproval; slug: string }) {
  const [open, setOpen] = useState(false);
  const what = `Approve ${toolName(approval.tool)}: ${approvalWhat(approval)}`;
  return (
    <li>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="group flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[0.8125rem] text-fg-soft outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-sidebar-accent data-[state=open]:text-fg">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 grow truncate">{what}</span>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={14}
          className={CARD_CLASS}
          aria-label={what}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <ApprovalCard approval={approval} slug={slug} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/**
 * A waiting call's card: what it wants to do, in which session and
 * repository, how long it has left, and Review, which opens the session's
 * page, where it is allowed or denied. It cannot be snoozed or dismissed:
 * it goes once it is answered or g1t declines it.
 */
function ApprovalCard({ approval, slug, onClose }: { approval: AgentApproval; slug: string; onClose: () => void }) {
  const now = Date.now();
  const where = [approval.repo, approval.item != null ? `#${approval.item}` : null].filter(Boolean).join(" ");
  return (
    <div className="p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex shrink-0 text-warn">
          <ShieldAlert size={16} />
        </span>
        <h3 className="min-w-0 grow text-[0.9375rem] leading-snug font-semibold text-fg">{toolName(approval.tool)} waits for your approval</h3>
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />
      </div>
      <p className="mt-2 pl-6.5 text-[0.8125rem] leading-relaxed text-muted">
        <code className="block font-mono text-xs break-all text-fg-soft">{approvalWhat(approval)}</code>
        <span className="mt-1 block text-faint">
          {approval.startedBy}'s session{where && <> · {where}</>} · {whenShort(approval.askedAt, now)} · {timeLeft(approval.expiresAt, now)}
        </span>
      </p>
      <div className="mt-4 flex items-center gap-2 pl-6.5">
        <Button asChild size="sm" className="rounded-full px-4">
          <Link to={sessionPath(slug, approval.sessionId)} onClick={onClose}>
            Review
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** One item: a red dot and what it is about, opening its card beside the sidebar. */
function AttentionRow({ item, onSettle }: { item: InboxItem; onSettle: (intent: "done" | "snooze") => void }) {
  const [open, setOpen] = useState(false);
  const what = item.body || item.title;
  return (
    <li>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="group flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[0.8125rem] text-fg-soft outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-sidebar-accent data-[state=open]:text-fg">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger" />
          <span className="min-w-0 grow truncate">{what}</span>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={14}
          className={CARD_CLASS}
          aria-label={what}
          // The card takes focus itself, so no button is ringed before you choose; Tab reaches them.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <AttentionCard item={item} onClose={() => setOpen(false)} onSettle={onSettle} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/**
 * An item's card: its kind and what it is about, with a dot that says it
 * waits; why you were told and when; and Review, Snooze and Dismiss.
 */
function AttentionCard({ item, onClose, onSettle }: { item: InboxItem; onClose: () => void; onSettle: (intent: "done" | "snooze") => void }) {
  const what = item.body || item.title;
  const where = [item.repo, item.number != null ? `#${item.number}` : null].filter(Boolean).join(" ");
  return (
    <div className="p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex shrink-0 text-accent">{item.subject ? SUBJECT_ICON[item.subject] : <CircleDot size={16} />}</span>
        <h3 className="min-w-0 grow text-[0.9375rem] leading-snug font-semibold text-fg">{what}</h3>
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" />
      </div>
      <p className="mt-2 pl-6.5 text-[0.8125rem] leading-relaxed text-muted">
        {item.body && item.title !== item.body && <span className="block">{item.title}</span>}
        <span className="text-faint">
          {REASON_LABEL[item.reason]}
          {where && <> · {where}</>} · {whenShort(item.updatedAt, Date.now())}
        </span>
      </p>
      <div className="mt-4 flex items-center gap-2 pl-6.5">
        <Button asChild size="sm" className="rounded-full px-4">
          <Link to={item.url} onClick={onClose}>
            Review
          </Link>
        </Button>
        <Hint label="Until tomorrow">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full px-4"
            onClick={() => {
              onClose();
              onSettle("snooze");
            }}
          >
            Snooze
          </Button>
        </Hint>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto rounded-full"
          onClick={() => {
            onClose();
            onSettle("done");
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
