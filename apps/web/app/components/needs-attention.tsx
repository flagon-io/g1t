import { ChevronsDown, ChevronsUp, CircleDot, GitPullRequest, PlayCircle, Rocket, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { type FetcherWithComponents, Link, useFetcher } from "react-router";

import type { AgentApproval, InboxItem } from "@g1t/contracts";

import type { InboxPanelData } from "../routes/inbox-json";
import type { ApprovalsData } from "../routes/workspace/approvals-json";
import { cn } from "../lib/cn";
import { REASON_LABEL, needsAttention, whenShort } from "../lib/inbox";
import { useNotifySelector } from "../lib/notify-client";
import {
  APPROVAL_ANSWERED_EVENT,
  type AnswerOutcome,
  approvalKey,
  approvalWhat,
  attentionEntries,
  attentionKey,
  timeLeft,
  toolName,
} from "../lib/session-approvals";
import { sessionPath } from "../lib/work-items";
import { AnswerButtons, ApprovalWhat } from "./session-answer";
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
 * drawn, again when the window comes back into view, and when a
 * notification arrives over the live feed. Beside them, newest first with
 * them, are the hosted sessions' calls waiting on your approval
 * (`-/approvals.json`), whose card allows or denies one where it is
 * (`-/approvals`), or opens it on its session's page with Review. A call
 * shows once, though its starter is also told of it in their inbox
 * (`attentionEntries`). Nothing is drawn while it is on its way, when it
 * could not be read, or when nothing waits.
 */
export function NeedsAttention({ slug, className }: { slug: string; className?: string }) {
  const list = useFetcher<InboxPanelData>({ key: "needs-attention" });
  // The hosted sessions' calls waiting on the viewer's answer, beside the notifications: one workspace's each.
  const waiting = useFetcher<ApprovalsData>({ key: `needs-attention-approvals:${slug.toLowerCase()}` });
  const mark = useFetcher({ key: "needs-attention-mark" });
  const [more, setMore] = useState(false);
  // Dismissed or snoozed here, or a call answered here: gone at once, before the inbox has said so.
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
    // A call answered anywhere (here, or on its session's page) is read again.
    window.addEventListener(APPROVAL_ANSWERED_EVENT, read);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener(APPROVAL_ANSWERED_EVENT, read);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // A notification arriving over the live feed (such as a call that starts waiting) reads both again.
  const latest = useNotifySelector((state) => state.recent[0]?.id ?? null);
  const seen = useRef(latest);
  useEffect(() => {
    if (latest === seen.current) return;
    seen.current = latest;
    if (document.visibilityState !== "visible") return;
    list.load("/inbox.json?tab=needs&for=attention");
    waiting.load(`/${encodeURIComponent(slug)}/-/approvals.json`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);

  const items = useMemo(() => {
    const now = Date.now();
    // Until the calls are read (or when they could not be), a notification about one shows as a link.
    const approvals = waiting.data ? waiting.data.approvals : null;
    return attentionEntries(needsAttention(list.data?.items ?? [], slug, now, hidden), approvals, now, hidden);
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
            <ApprovalRow
              key={attentionKey(entry)}
              approval={entry.approval}
              slug={slug}
              onGone={() => setHidden((was) => new Set([...was, approvalKey(entry.approval)]))}
            />
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

/** How long a card refused for good stays to say why before it leaves. */
const REFUSED_MS = 4_000;

/**
 * A hosted session's call that waits on the viewer: an amber dot and what
 * it wants to do, opening its card. Its answer is posted from here, so it
 * carries on while the card is closed. Once answered it leaves the list
 * (`onGone`); refused for good (answered by someone else, declined, the
 * session ended), its card says why, then it leaves.
 */
function ApprovalRow({ approval, slug, onGone }: { approval: AgentApproval; slug: string; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<AnswerOutcome>();
  const what = `Approve ${toolName(approval.tool)}: ${approvalWhat(approval)}`;
  const outcome = fetcher.state === "idle" ? fetcher.data : undefined;
  const refused = outcome != null && "error" in outcome && outcome.refused;
  useEffect(() => {
    if (!outcome) return;
    if ("answered" in outcome) {
      // What else shows the call (Recents, an open session page's lists) reads again.
      window.dispatchEvent(new Event(APPROVAL_ANSWERED_EVENT));
      onGone();
      return;
    }
    if (!outcome.refused) return;
    const timer = setTimeout(onGone, REFUSED_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  return (
    <li>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Closed after it said why it was refused: it has nothing left to answer.
          if (!next && refused) onGone();
        }}
      >
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
          <ApprovalCard approval={approval} slug={slug} fetcher={fetcher} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/**
 * A waiting call's card: what it wants to do (as its session's page shows
 * it), in which session and repository, and how long it has left; Allow
 * and Deny, answered from here through `-/approvals`, and Review, which
 * opens the session's page at the call. What is pending and what went
 * wrong show in place. It cannot be snoozed or dismissed: it goes once it
 * is answered or g1t declines it.
 */
function ApprovalCard({
  approval,
  slug,
  fetcher,
  onClose,
}: {
  approval: AgentApproval;
  slug: string;
  fetcher: FetcherWithComponents<AnswerOutcome>;
  onClose: () => void;
}) {
  const now = Date.now();
  const where = [approval.repo, approval.item != null ? `#${approval.item}` : null].filter(Boolean).join(" ");
  const outcome = fetcher.state === "idle" ? fetcher.data : undefined;
  const error = outcome && "error" in outcome ? outcome : null;
  return (
    <div className="p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex shrink-0 text-warn">
          <ShieldAlert size={16} />
        </span>
        <h3 className="min-w-0 grow text-[0.9375rem] leading-snug font-semibold text-fg">{toolName(approval.tool)} waits for your approval</h3>
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />
      </div>
      <div className="mt-2 pl-6.5 text-[0.8125rem] leading-relaxed text-muted">
        <ApprovalWhat approval={approval} />
        <p className="mt-1 text-faint">
          {approval.startedBy}'s session{where && <> · {where}</>} · {whenShort(approval.askedAt, now)} · {timeLeft(approval.expiresAt, now)}
        </p>
      </div>
      {error && (
        <p role="alert" className={cn("mt-3 pl-6.5 text-[0.8125rem]", error.refused ? "text-muted" : "text-danger")}>
          {error.error}
        </p>
      )}
      <fetcher.Form method="post" action={`/${encodeURIComponent(slug)}/-/approvals`} className="mt-4 flex flex-wrap items-center gap-2 pl-6.5">
        <input type="hidden" name="repo" value={approval.repo} />
        <input type="hidden" name="sessionId" value={approval.sessionId} />
        {!error?.refused && <AnswerButtons approval={approval} fetcher={fetcher} />}
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link to={`${sessionPath(slug, approval.sessionId)}#approval-${encodeURIComponent(approval.toolUseId)}`} onClick={onClose}>
            Review
          </Link>
        </Button>
      </fetcher.Form>
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
