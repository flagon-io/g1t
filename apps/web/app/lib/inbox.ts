/**
 * The inbox's tabs, reasons, times and actions, shared by the panel in the
 * top bar (components/inbox.tsx) and the page at /inbox (routes/inbox.tsx),
 * and how people subscribe to threads and watch repositories
 * (components/notifications.tsx). The events service keeps the items and
 * decides who is told of what.
 */
import type {
  InboxCounts,
  InboxItem,
  InboxMarkArgs,
  InboxReason,
  InboxSeverity,
  InboxView,
  ThreadSubscription,
  WatchEvent,
  WatchLevel,
} from "@g1t/contracts";

// The contracts' lists, as types only, so this file runs under `node --test`.
// Typed by the contract: a reason or kind added there must be added here.
const INBOX_REASONS: InboxReason[] = [
  "agent",
  "review_requested",
  "assign",
  "mention",
  "ci_activity",
  "security_alert",
  "state_change",
  "author",
  "comment",
  "manual",
  "subscribed",
];
const WATCH_EVENTS: WatchEvent[] = ["issues", "pulls", "deployments", "security"];

export type InboxTab = "all" | "needs" | "error" | "success" | "info";

/** The tabs, in order, and the severity each shows. */
export const INBOX_TABS: { tab: InboxTab; label: string; severity: InboxSeverity | null }[] = [
  { tab: "all", label: "All", severity: null },
  // Warnings are what is waiting on a person: an agent, or a review asked of them.
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
      return { title: "Nothing needs you", detail: "When an agent is waiting on you, or someone asks for your review, it shows up here first." };
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
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  return { items: needs.slice(0, max), total: needs.length };
}

/** Whether an item is still unread. */
export function isUnread(item: Pick<InboxItem, "readAt">): boolean {
  return item.readAt == null;
}

/** Why someone was told, in a few quiet words on the card. */
export const REASON_LABEL: Record<InboxReason, string> = {
  agent: "agent waiting",
  review_requested: "review requested",
  assign: "assigned",
  mention: "mentioned",
  ci_activity: "CI activity",
  security_alert: "security alert",
  state_change: "state changed",
  author: "your work",
  comment: "commented",
  manual: "subscribed",
  subscribed: "watching",
};

/** The reason filter on /inbox, from the address: null for any reason. */
export function inboxReason(value: string | null | undefined): InboxReason | null {
  return INBOX_REASONS.find((reason) => reason === value) ?? null;
}

/** The reason filter's choices, in the order reasons rank. */
export const REASON_FILTERS: { reason: InboxReason | null; label: string }[] = [
  { reason: null, label: "Any reason" },
  ...INBOX_REASONS.map((reason) => ({ reason, label: REASON_LABEL[reason].replace(/^./, (c) => c.toUpperCase()) })),
];

/** How much has happened on a thread, when more than one thing has: "3 updates". */
export function updatesLabel(count: number | null | undefined): string {
  return count && count > 1 ? `${count} updates` : "";
}

/** The ways to watch a repository, in the order the menu shows them. */
export const WATCH_CHOICES: { level: WatchLevel; label: string; detail: string }[] = [
  { level: "participating", label: "Participating and @mentions", detail: "Only what you take part in, or are mentioned in." },
  { level: "all", label: "All activity", detail: "Every issue and pull request, and every deployment." },
  { level: "ignore", label: "Ignore", detail: "Nothing at all, not even a mention." },
  { level: "custom", label: "Custom", detail: "What you take part in, and the kinds you choose." },
];

/** The kinds a custom watch can follow, with their names for people. */
export const WATCH_EVENT_LABEL: Record<WatchEvent, string> = {
  issues: "Issues",
  pulls: "Pull requests",
  deployments: "Deployments",
  security: "Security alerts",
};

/** The Watch button's words for how someone watches. */
export function watchLabel(level: WatchLevel | null | undefined): string {
  switch (level) {
    case "all":
      return "Watching";
    case "custom":
      return "Watching some";
    case "ignore":
      return "Ignoring";
    default:
      return "Watch";
  }
}

/**
 * A posted watch form as the level and kinds it asks for: `level`, and for
 * `custom` the `event` fields checked. A custom watch with nothing checked
 * is participating. Null when the level is not one.
 */
export function watchFromForm(form: FormData): { level: WatchLevel; events: WatchEvent[] } | null {
  const level = String(form.get("level") ?? "");
  if (!["participating", "all", "ignore", "custom"].includes(level)) return null;
  if (level !== "custom") return { level: level as WatchLevel, events: [] };
  const checked = form.getAll("event").map(String);
  const events = WATCH_EVENTS.filter((event) => checked.includes(event));
  return events.length > 0 ? { level: "custom", events } : { level: "participating", events: [] };
}

/** The line under the subscribe button: whether, and why. */
export function subscriptionLine(subscription: ThreadSubscription | null | undefined, kind: "issue" | "pull"): string {
  const thing = kind === "pull" ? "pull request" : "issue";
  if (!subscription) return `Subscribe to hear of what happens on this ${thing}.`;
  if (subscription.ignored) return `You ignore this ${thing}: you hear of nothing on it, not even a mention.`;
  if (!subscription.subscribed) return "You're not subscribed. You'll still hear if you're mentioned or asked to review.";
  switch (subscription.reason) {
    case "author":
      return `You're subscribed because you opened this ${thing}, or asked g1t for it.`;
    case "assign":
      return "You're subscribed because you were assigned.";
    case "review_requested":
      return "You're subscribed because you were asked to review.";
    case "comment":
      return "You're subscribed because you commented.";
    case "mention":
      return "You're subscribed because you were mentioned.";
    default:
      return `You're subscribed to this ${thing}.`;
  }
}

/** What a posted subscription form asks for: subscribe, unsubscribe, ignore, or the default. */
export function subscriptionFromForm(form: FormData): { subscribed: boolean | null; ignored: boolean } | null {
  switch (String(form.get("intent") ?? "")) {
    case "subscribe":
      return { subscribed: true, ignored: false };
    case "unsubscribe":
      return { subscribed: false, ignored: false };
    case "ignore":
      return { subscribed: false, ignored: true };
    case "default":
      return { subscribed: null, ignored: false };
    default:
      return null;
  }
}

/** The reasons someone can be emailed for, in the settings' order, with what each is. */
export const EMAIL_REASONS: { reason: InboxReason; label: string; detail: string }[] = [
  { reason: "agent", label: "An agent is waiting on you", detail: "It asked you something, or stopped until you step in." },
  { reason: "review_requested", label: "You're asked to review", detail: "Someone asked for your review of a pull request." },
  { reason: "mention", label: "You're mentioned", detail: "Someone wrote your @username in a comment." },
  { reason: "assign", label: "You're assigned", detail: "Someone assigned you an issue or a pull request." },
  { reason: "ci_activity", label: "Your work's checks and deployments", detail: "Checks, a workflow or a deployment failed on your work." },
  { reason: "state_change", label: "What you follow closes or merges", detail: "An issue or pull request you're subscribed to was closed, reopened or merged." },
  { reason: "author", label: "News on your work", detail: "An approval, changes asked for, or g1t finishing what you asked for." },
  { reason: "comment", label: "Conversations you're in", detail: "Comments on issues and pull requests you commented on." },
  { reason: "manual", label: "Threads you subscribed to", detail: "Activity on issues and pull requests you subscribed to by hand." },
  { reason: "subscribed", label: "Repositories you watch", detail: "Activity in repositories you watch." },
];

/** The reasons checked on the settings form, each once, in rank order. */
export function emailReasonsFromForm(form: FormData): InboxReason[] {
  const checked = form.getAll("email").map(String);
  return INBOX_REASONS.filter((reason) => checked.includes(reason));
}
