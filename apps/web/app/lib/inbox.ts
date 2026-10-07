/**
 * The inbox's tabs, times and actions, shared by the panel in the top bar
 * (components/inbox.tsx) and the page at /inbox (routes/inbox.tsx). The
 * events service keeps the items and decides who is told of what.
 */
import type { InboxCounts, InboxItem, InboxMarkArgs, InboxSeverity, InboxView } from "@g1t/contracts";

export type InboxTab = "all" | "needs" | "error" | "success" | "info";

/** The tabs, in order, and the severity each shows. */
export const INBOX_TABS: { tab: InboxTab; label: string; severity: InboxSeverity | null }[] = [
  { tab: "all", label: "All", severity: null },
  // Warnings are what an agent is waiting on a person for.
  { tab: "needs", label: "Needs you", severity: "warning" },
  { tab: "error", label: "Errors", severity: "error" },
  { tab: "success", label: "Success", severity: "success" },
  { tab: "info", label: "Info", severity: "info" },
];

/** The words on an item's badge. */
export const SEVERITY_LABEL: Record<InboxSeverity, string> = {
  error: "Error",
  warning: "Needs you",
  success: "Success",
  info: "Info",
};

export function inboxTab(value: string | null | undefined): InboxTab {
  return INBOX_TABS.find((entry) => entry.tab === value)?.tab ?? "all";
}

export function severityOf(tab: InboxTab): InboxSeverity | null {
  return INBOX_TABS.find((entry) => entry.tab === tab)?.severity ?? null;
}

export function inboxView(value: string | null | undefined): InboxView {
  return value === "saved" || value === "done" ? value : "inbox";
}

/** What is unread under a tab. */
export function tabCount(counts: InboxCounts | null | undefined, tab: InboxTab): number {
  if (!counts) return 0;
  const severity = severityOf(tab);
  return severity ? counts[severity] : counts.unread;
}

/** The bell's number: up to 99, then "99+". Empty when nothing is unread. */
export function bellCount(unread: number | null | undefined): string {
  if (!unread || unread < 1) return "";
  return unread > 99 ? "99+" : String(unread);
}

/** What an empty tab says. */
export function emptyFor(tab: InboxTab, view: InboxView = "inbox"): { title: string; detail: string } {
  if (view === "saved") return { title: "Nothing saved", detail: "Save an item to keep it here after it is done." };
  if (view === "done") return { title: "Nothing done yet", detail: "Items you mark done move here." };
  switch (tab) {
    case "needs":
      return { title: "Nothing needs you", detail: "When an agent is waiting on you, it shows up here first." };
    case "error":
      return { title: "No failures", detail: "Failed checks and workflows on your work show up here." };
    case "success":
      return { title: "Nothing new landed", detail: "Merges, approvals and finished agent work show up here." };
    case "info":
      return { title: "No mentions or comments", detail: "Mentions of you and comments on your work show up here." };
    default:
      return { title: "You're all caught up", detail: "What needs you, or what you follow, shows up here as it happens." };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When, in a few characters: "just now", "15m ago", "3h ago", "Yesterday", "4d ago", "Sep 30". */
export function whenShort(at: string, now: number): string {
  const time = Date.parse(at);
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 2 * DAY) return "Yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** How long an item can be snoozed for. */
export const SNOOZES = [
  { key: "3h", label: "3 hours", ms: 3 * HOUR },
  { key: "tomorrow", label: "Tomorrow", ms: DAY },
  { key: "week", label: "Next week", ms: 7 * DAY },
] as const;

export function snoozeUntil(key: string | null | undefined, now: number): string | null {
  const snooze = SNOOZES.find((entry) => entry.key === key);
  return snooze ? new Date(now + snooze.ms).toISOString() : null;
}

/** What the inbox forms post, by `intent`. */
const MARKS: Record<string, InboxMarkArgs["mark"]> = {
  read: "read",
  unread: "unread",
  done: "done",
  undone: "undone",
  save: "save",
  unsave: "unsave",
  snooze: "snooze",
};

/**
 * A posted inbox form as the mark it asks for: one item (`id`), or every
 * item (`intent` `read_all`, optionally for one tab). Null when it asks for
 * nothing the inbox does.
 */
export function markFromForm(form: FormData, now: number): InboxMarkArgs | null {
  const intent = String(form.get("intent") ?? "");
  if (intent === "read_all") {
    return { mark: "read", all: true, severity: severityOf(inboxTab(String(form.get("tab") ?? ""))) };
  }
  const mark = MARKS[intent];
  const id = String(form.get("id") ?? "").trim();
  if (!mark || !id) return null;
  if (mark === "snooze") {
    const until = snoozeUntil(String(form.get("for") ?? ""), now);
    return until ? { mark, ids: [id], until } : null;
  }
  return { mark, ids: [id] };
}

/**
 * Mission control's Needs you card, from unread items: what an agent is
 * waiting on first, then failures, newest first within each; `max` of them,
 * and how many there are in all.
 */
export function needsYou(items: InboxItem[], max: number): { items: InboxItem[]; total: number } {
  const rank = (item: InboxItem) => (item.severity === "warning" ? 0 : 1);
  const needs = items
    .filter((item) => isUnread(item) && (item.severity === "warning" || item.severity === "error"))
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
  return { items: needs.slice(0, max), total: needs.length };
}

/** Whether an item is still unread. */
export function isUnread(item: Pick<InboxItem, "readAt">): boolean {
  return item.readAt == null;
}
