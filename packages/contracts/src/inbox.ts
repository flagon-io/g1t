/**
 * The inbox: what needs a person, or what they follow, as it happens. The
 * events service keeps it and brings each person's thread about a thing
 * (an issue, a pull request, a workflow on a branch, a deployment) back to
 * the top as things happen to it. Mirrors `crates/contracts/src/inbox.rs`,
 * which says who is told of what, and why.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";

/**
 * How much an item matters: a failure, something a person must answer (an
 * agent waiting on them, a review asked of them), something that went well,
 * or something to know.
 */
export type InboxSeverity = "error" | "warning" | "success" | "info";

export const INBOX_SEVERITIES: InboxSeverity[] = ["error", "warning", "success", "info"];

/**
 * Why a person was told: what the thread asked of them, or what ties them
 * to it. Most specific first.
 */
export type InboxReason =
  | "agent"
  | "review_requested"
  | "assign"
  | "mention"
  | "team_mention"
  | "ci_activity"
  | "security_alert"
  | "state_change"
  | "author"
  | "comment"
  | "manual"
  | "subscribed";

export const INBOX_REASONS: InboxReason[] = [
  "agent",
  "review_requested",
  "assign",
  "mention",
  "team_mention",
  "ci_activity",
  "security_alert",
  "state_change",
  "author",
  "comment",
  "manual",
  "subscribed",
];

export type InboxSubjectKind = "issue" | "pull" | "run" | "deploy";

/** One thread in a person's inbox: what it is about, and its latest activity. */
export type InboxItem = {
  /** The thread's id: the same for as long as the person has it. */
  id: string;
  /** Why they were told of the latest activity. */
  reason: InboxReason;
  /** While unread, the most urgent of what happened since it was last read. */
  severity: InboxSeverity;
  /** One line: what happened last, and where. */
  title: string;
  /** One line: what it happened to, such as the pull request's title. */
  body: string;
  /** The event behind the latest activity, such as `pull.merged`. */
  event: string | null;
  /** `owner/name`. */
  repo: string | null;
  workspace: string | null;
  subject: InboxSubjectKind | null;
  number: number | null;
  /** A path on g1t.sh, such as `/acme/rocket/pull/12`. */
  url: string;
  /** A username, or `g1t`. */
  actor: string | null;
  /** How many things have happened on the thread. */
  count: number;
  /** RFC 3339: when the person was first told of the thread. */
  createdAt: string;
  /** RFC 3339: its latest activity. */
  updatedAt: string;
  readAt: string | null;
  doneAt: string | null;
  saved: boolean;
  snoozedUntil: string | null;
};

/** One thing that happened on a thread, as the person was told of it. */
export type InboxActivity = {
  reason: InboxReason;
  severity: InboxSeverity;
  title: string;
  body: string;
  event: string | null;
  actor: string | null;
  createdAt: string;
};

/** A person's subscription to an issue or pull request. */
export type ThreadSubscription = {
  /** Whether they hear of what happens on it. */
  subscribed: boolean;
  /** Whether they hear of nothing on it at all, not even a mention. */
  ignored: boolean;
  /** Why they are subscribed; null when they are not. */
  reason: InboxReason | null;
  repo: string | null;
  number: number | null;
  /** When they last chose, or null if they never did. */
  updatedAt: string | null;
};

/** A thread with its history, newest first, and the person's subscription. */
export type InboxThread = InboxItem & {
  activity: InboxActivity[];
  subscription: ThreadSubscription | null;
};

/** How closely a person follows a repository. */
export type WatchLevel = "participating" | "all" | "ignore" | "custom";

export const WATCH_LEVELS: WatchLevel[] = ["participating", "all", "ignore", "custom"];

/** The kinds of activity a custom watch can follow. */
export type WatchEvent = "issues" | "pulls" | "deployments" | "security";

export const WATCH_EVENTS: WatchEvent[] = ["issues", "pulls", "deployments", "security"];

export type Watching = {
  repoId: string;
  repo: string | null;
  level: WatchLevel;
  /** With `custom`: what it follows. */
  events: WatchEvent[];
  updatedAt: string | null;
};

/** A person's choices about being told. */
export type InboxSettings = {
  /** The reasons they are also emailed for. */
  email: InboxReason[];
  /** How they watch a repository they create. */
  defaultWatch: WatchLevel;
};

/** The inbox itself (not done, not snoozed), what was saved, or what is done. */
export type InboxView = "inbox" | "saved" | "done";

export type InboxQuery = {
  view?: InboxView;
  severity?: InboxSeverity | null;
  reason?: InboxReason | null;
  /** Only threads the person takes part in: not those followed by watching or by hand. */
  participating?: boolean;
  repoId?: string | null;
  unread?: boolean;
  /** RFC 3339: only threads with activity at or after it. */
  since?: string | null;
  /** RFC 3339: only threads whose latest activity was before it. */
  updatedBefore?: string | null;
  /** The `next` of the page before. */
  before?: string | null;
  /** At most 100. */
  limit?: number;
};

export type InboxPage = { items: InboxItem[]; next: string | null };

/** Unread items in the inbox, by severity. */
export type InboxCounts = { unread: number } & Record<InboxSeverity, number>;

export type InboxMark = "read" | "unread" | "done" | "undone" | "save" | "unsave" | "snooze" | "unsnooze";

export type InboxMarkArgs = {
  mark: InboxMark;
  /** At most 100. */
  ids?: string[];
  /** Every item in the inbox, when `ids` is empty: Mark all read. */
  all?: boolean;
  severity?: InboxSeverity | null;
  repoId?: string | null;
  /** With `all`: only threads whose latest activity was at or before this. */
  lastReadAt?: string | null;
  /** For `snooze`: RFC 3339, later than now. */
  until?: string | null;
};

/** Which issue or pull request: a thread's id, or a repository and number. */
export type SubscriptionTarget = { id: string } | { repoId: string; number: number };

export interface InboxApi {
  /**
   * Latest activity first; in the inbox unfiltered, unread warnings first.
   * Items about a repository the viewer can no longer read are dropped.
   */
  list(viewer: User, query?: InboxQuery): Promise<InboxPage>;
  counts(username: string): Promise<InboxCounts>;
  /** Changes the person's own items. Returns how many changed. */
  mark(username: string, args: InboxMarkArgs): Promise<number>;
  /** One of the viewer's threads with its history, or null. */
  thread(viewer: User, id: string): Promise<InboxThread | null>;
  /** The viewer's subscription to an issue or pull request; null when there is none to have. */
  subscription(viewer: User, target: SubscriptionTarget): Promise<ThreadSubscription | null>;
  /**
   * Subscribes (`true`), unsubscribes (`false`), ignores, or goes back to
   * the default (`null`, subscribed only while taking part).
   */
  subscribe(viewer: User, target: SubscriptionTarget, subscribed: boolean | null, ignored?: boolean): Promise<ThreadSubscription | null>;
  watching(username: string, repoId: string): Promise<Watching>;
  /** `null` goes back to the default, participating. */
  watch(username: string, repoId: string, repo: string, level: WatchLevel | null, events?: WatchEvent[]): Promise<Watching>;
  watched(username: string): Promise<Watching[]>;
  settings(username: string): Promise<InboxSettings>;
  updateSettings(username: string, changes: Partial<InboxSettings>): Promise<InboxSettings>;
}

/** The inbox, which the events service keeps. */
export function inboxClient(events: ServiceBinding): InboxApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await events.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    list: (viewer, query = {}) => call("inbox_list", { viewer, ...query }),
    counts: (username) => call("inbox_counts", { username }),
    mark: (username, args) => call("inbox_mark", { username, ...args }),
    thread: (viewer, id) => call("inbox_thread", { viewer, id }),
    subscription: (viewer, target) => call("inbox_subscription", { viewer, ...target }),
    subscribe: (viewer, target, subscribed, ignored = false) =>
      call("inbox_subscribe", { viewer, ...target, subscribed, ignored }),
    watching: (username, repoId) => call("inbox_watching", { username, repoId }),
    watch: (username, repoId, repo, level, events = []) => call("inbox_watch", { username, repoId, repo, level, events }),
    watched: (username) => call("inbox_watched", { username }),
    settings: (username) => call("inbox_settings", { username }),
    updateSettings: (username, changes) => call("inbox_update_settings", { username, ...changes }),
  };
}
