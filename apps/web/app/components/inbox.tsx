import { AlarmClock, Bell, Bookmark, Check, CheckCheck, CircleCheck, CircleX, Ellipsis, Hand, Inbox, Info, Mail, MailOpen, Sparkles, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { InboxCounts, InboxItem, InboxSeverity } from "@g1t/contracts";

import { SubmitButton } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Hint } from "./ui/hint";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/cn";
import { isPending } from "../lib/pending";
import { INBOX_TABS, type InboxTab, REASON_LABEL, SEVERITY_LABEL, SNOOZES, bellCount, emptyFor, isUnread, tabCount, updatesLabel, whenShort } from "../lib/inbox";
import type { InboxPanelData } from "../routes/inbox-json";

/** Where every inbox form posts (routes/inbox.tsx). */
const ACTION = "/inbox";
/** How often the bell asks for its count while the page is in view. */
const COUNT_EVERY_MS = 60_000;

const TONE: Record<InboxSeverity, BadgeTone> = {
  error: "danger",
  warning: "warn",
  success: "accent",
  info: "info",
};

const ICON: Record<InboxSeverity, { icon: ReactNode; ring: string }> = {
  error: { icon: <CircleX size={15} />, ring: "bg-danger/10 text-danger ring-danger/30" },
  warning: { icon: <Hand size={15} />, ring: "bg-warn/10 text-warn ring-warn/30" },
  success: { icon: <CircleCheck size={15} />, ring: "bg-success/10 text-success ring-success/30" },
  info: { icon: <Info size={15} />, ring: "bg-info/10 text-info ring-info/30" },
};

/** The round mark that says what kind of item it is. */
function SeverityMark({ severity }: { severity: InboxSeverity }) {
  const { icon, ring } = ICON[severity];
  return (
    <span aria-hidden="true" className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ring-1", ring)}>
      {icon}
    </span>
  );
}

/** Hidden fields naming one item's action. */
function Fields({ intent, id, extra }: { intent: string; id: string; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      {Object.entries(extra ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * One item: what happened, to what, when, and how much it matters. The
 * whole card opens what it is about and marks it read; Done is at hand,
 * and the menu has the rest. Read items are dimmed. While Done or Snooze
 * is on its way the card steps out of the list.
 */
export function InboxCard({ item, onOpen }: { item: InboxItem; onOpen?: () => void }) {
  const fetcher = useFetcher<{ error?: string }>();
  const unread = isUnread(item);
  const leaving = isPending(fetcher, { id: item.id }) && ["done", "snooze", "undone"].includes(String(fetcher.formData?.get("intent")));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [item.updatedAt]);
  if (leaving) return null;

  const submit = (intent: string, extra?: Record<string, string>) =>
    fetcher.submit({ intent, id: item.id, ...extra }, { method: "post", action: ACTION });
  const open = () => {
    if (unread) submit("read");
    onOpen?.();
  };

  return (
    <li
      className={cn(
        "group relative flex gap-3 rounded-lg border border-line bg-bg/40 p-3 transition-colors hover:border-line-strong hover:bg-raised/50",
        !unread && "opacity-60 hover:opacity-100",
      )}
    >
      <SeverityMark severity={item.severity} />
      <div className="min-w-0 flex-1">
        <Link
          to={item.url}
          onClick={open}
          className="block truncate pr-14 text-sm font-semibold text-fg outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-accent"
        >
          {item.title}
        </Link>
        {item.body && <p className="mt-0.5 truncate text-xs text-muted">{item.body}</p>}
        <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-faint">
          <time dateTime={item.updatedAt} suppressHydrationWarning className="shrink-0 whitespace-nowrap">
            {whenShort(item.updatedAt, now)}
          </time>
          <Badge tone={TONE[item.severity]} className="shrink-0">{SEVERITY_LABEL[item.severity]}</Badge>
          {/* Why they were told, and how much has happened, said quietly. */}
          <span className="truncate">{REASON_LABEL[item.reason] ?? item.reason}</span>
          {updatesLabel(item.count) && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 tabular-nums">{updatesLabel(item.count)}</span>
            </>
          )}
          {item.saved && (
            <span className="inline-flex items-center gap-1 text-faint">
              <Bookmark size={12} aria-hidden="true" />
              Saved
            </span>
          )}
        </div>
        {fetcher.data?.error && <p className="mt-1 text-xs text-danger">{fetcher.data.error}</p>}
      </div>
      {unread && <span aria-label="Unread" className="absolute top-3.5 right-3 size-2 rounded-full bg-accent group-focus-within:hidden group-hover:hidden [@media(hover:none)]:hidden" />}
      {/* Above the card's link, so they act instead of opening it. On hover or focus, and always on a touch screen. */}
      <div className="absolute top-2 right-2 z-10 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
        {item.doneAt ? (
          <fetcher.Form method="post" action={ACTION}>
            <Fields intent="undone" id={item.id} />
            <Hint label="Move back to the inbox">
              <SubmitButton fetcher={fetcher} icon aria-label="Move back to the inbox" className={ICON_BUTTON}>
                <Undo2 size={14} />
              </SubmitButton>
            </Hint>
          </fetcher.Form>
        ) : (
          <fetcher.Form method="post" action={ACTION}>
            <Fields intent="done" id={item.id} />
            <Hint label="Done">
              <SubmitButton fetcher={fetcher} icon aria-label="Done" className={ICON_BUTTON}>
                <Check size={14} />
              </SubmitButton>
            </Hint>
          </fetcher.Form>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="More actions" className={ICON_BUTTON}>
            <Ellipsis size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => submit(unread ? "read" : "unread")}>
              {unread ? <MailOpen /> : <Mail />}
              {unread ? "Mark as read" : "Mark as unread"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => submit(item.saved ? "unsave" : "save")}>
              <Bookmark />
              {item.saved ? "Unsave" : "Save"}
            </DropdownMenuItem>
            {!item.doneAt && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                {SNOOZES.map((snooze) => (
                  <DropdownMenuItem key={snooze.key} onSelect={() => submit("snooze", { for: snooze.key })}>
                    <AlarmClock />
                    {snooze.label}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

const ICON_BUTTON =
  "flex size-7 items-center justify-center rounded-md border border-line bg-surface text-muted transition-colors outline-none hover:border-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60";

/** What an empty list says, for its tab. */
export function InboxEmpty({ tab, view }: { tab: InboxTab; view?: "inbox" | "saved" | "done" }) {
  const { title, detail } = emptyFor(tab, view);
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <Inbox size={20} className="text-faint" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-64 text-xs text-muted">{detail}</p>
    </div>
  );
}

/** The tab row, with what is unread under each. */
export function InboxTabs({ tab, counts, onChange }: { tab: InboxTab; counts: InboxCounts | null; onChange: (tab: InboxTab) => void }) {
  return (
    <Tabs value={tab} onValueChange={(value) => onChange(value as InboxTab)}>
      <TabsList className="flex w-full overflow-x-auto [scrollbar-width:none]">
        {INBOX_TABS.map((entry) => {
          const count = tabCount(counts, entry.tab);
          return (
            <TabsTrigger key={entry.tab} value={entry.tab} className="flex shrink-0 grow items-center justify-center gap-1.5">
              {entry.label}
              {count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[0.6875rem] tabular-nums",
                    entry.tab === "needs" ? "bg-warn/15 text-warn" : "bg-line text-muted",
                  )}
                >
                  {count}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

/** Mark all read, for the tab being looked at. */
export function MarkAllRead({ tab, disabled }: { tab: InboxTab; disabled: boolean }) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post" action={ACTION}>
      <input type="hidden" name="intent" value="read_all" />
      <input type="hidden" name="tab" value={tab} />
      <SubmitButton
        fetcher={fetcher}
        disabled={disabled}
        pending="Marking…"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <CheckCheck size={14} />
        Mark all read
      </SubmitButton>
    </fetcher.Form>
  );
}

/**
 * The bell in the top bar, and the panel it opens from the right: the
 * inbox's tabs and newest items, to work through without leaving the page.
 * Its count comes with the page (root.tsx), and is asked for again every
 * minute while the page is in view, and after anything is marked.
 */
export function InboxBell({ counts: loaded }: { counts: InboxCounts | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<InboxTab>("all");
  const list = useFetcher<InboxPanelData>({ key: "inbox-panel" });
  const poll = useFetcher<InboxPanelData>({ key: "inbox-count" });

  useEffect(() => {
    if (open) list.load(`/inbox.json?tab=${tab}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);
  useEffect(() => {
    const ask = () => {
      if (document.visibilityState === "visible") poll.load("/inbox.json?only=counts");
    };
    const timer = setInterval(ask, COUNT_EVERY_MS);
    window.addEventListener("focus", ask);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", ask);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = (open ? list.data?.counts : null) ?? poll.data?.counts ?? loaded;
  const unread = counts?.unread ?? 0;
  const items = list.data?.tab === tab ? list.data.items : null;
  const shown = bellCount(unread);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"}
        className="relative flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <Bell size={17} />
        {shown && (
          // Amber while an agent waits on them, red for a failure, else the accent.
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold tabular-nums text-bg ring-2 ring-bg",
              (counts?.warning ?? 0) > 0 ? "bg-warn" : (counts?.error ?? 0) > 0 ? "bg-danger" : "bg-accent",
            )}
          >
            {shown}
          </span>
        )}
      </SheetTrigger>
      <SheetContent
        // Focus starts on the tab being looked at, not on Mark all read.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus();
        }}
      >
        <SheetHeader className="flex-row items-center justify-between gap-3">
          <SheetTitle>Inbox</SheetTitle>
          <MarkAllRead tab={tab} disabled={tabCount(counts, tab) === 0} />
        </SheetHeader>
        <div className="border-b border-line px-5 py-3">
          <InboxTabs tab={tab} counts={counts} onChange={setTab} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {items == null ? (
            list.state === "idle" && list.data?.tab === tab ? (
              <p className="text-sm text-muted">The inbox could not be loaded. Try again in a moment.</p>
            ) : (
              <ul aria-busy="true" className="space-y-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <li key={index} className="flex gap-3 rounded-lg border border-line p-3">
                    <Skeleton className="size-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : items.length === 0 ? (
            <InboxEmpty tab={tab} />
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <InboxCard key={item.id} item={item} onOpen={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
        <SheetFooter className="justify-between">
          <SheetDescription className="text-xs">Done, saved and snoozed items are in the full inbox.</SheetDescription>
          <SheetClose asChild>
            <Link to={tab === "all" ? "/inbox" : `/inbox?tab=${tab}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
              Open inbox
            </Link>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Agent: g1t's agent to talk to, here to say it is coming, and not yet usable. A disabled button
 * gets no pointer events, so the tooltip hangs on a span around it: shown on hover and focus,
 * and on a tap, since a touch screen has no hover.
 */
export function AgentButton() {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          // A tap opens it; without preventDefault the trigger's own click would close it again.
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
          className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <button
            type="button"
            disabled
            aria-label="Agent"
            className="pointer-events-none flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm text-muted opacity-60 sm:px-3"
          >
            <Sparkles size={15} className="text-accent" />
            <span className="hidden sm:inline">Agent</span>
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Agent is coming later</TooltipContent>
    </Tooltip>
  );
}

/**
 * Mission control's card of what is unread in the person's inbox and
 * worth a look: items an agent is waiting on, then failures. Titled for
 * the inbox, not "Needs you", which on mission control is the work list's
 * own count. Not shown when there are none.
 */
export function InboxNeedsCard({ items, total }: { items: InboxItem[]; total: number }) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Inbox size={14} className="text-warn" aria-hidden="true" />
          From your inbox
          <span className="rounded-full bg-warn/15 px-1.5 text-[0.6875rem] font-medium tabular-nums text-warn">{total}</span>
        </h2>
        <Link to="/inbox" className="text-xs font-medium text-accent hover:underline">
          Open inbox
        </Link>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <InboxCard key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}
