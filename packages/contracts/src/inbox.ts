/**
 * The inbox: what needs a person, or what they follow, as it happens. The
 * events service keeps it and writes items as events arrive. Mirrors
 * `crates/contracts/src/inbox.rs`, which says who is told of what.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";

/**
 * How much an item matters: a failure, something a person must answer (an
 * agent waiting on them), something that went well, or something to know.
 */
export type InboxSeverity = "error" | "warning" | "success" | "info";

export const INBOX_SEVERITIES: InboxSeverity[] = ["error", "warning", "success", "info"];

export type InboxSubjectKind = "issue" | "pull" | "run";

export type InboxItem = {
  id: string;
  /** Why they were told, such as `checks_failed`, `agent_asked` or `mentioned`. */
  reason: string;
  severity: InboxSeverity;
  /** One line: what happened, and where. */
  title: string;
  /** One line: what it happened to, such as the pull request's title. */
  body: string;
  /** `owner/name`. */
  repo: string | null;
  workspace: string | null;
  subject: InboxSubjectKind | null;
  number: number | null;
  /** A path on g1t.sh, such as `/acme/rocket/pull/12`. */
  url: string;
  /** A username, or `g1t`. */
  actor: string | null;
  /** RFC 3339. */
  createdAt: string;
  readAt: string | null;
  doneAt: string | null;
  saved: boolean;
  snoozedUntil: string | null;
};

/** The inbox itself (not done, not snoozed), what was saved, or what is done. */
export type InboxView = "inbox" | "saved" | "done";

export type InboxQuery = {
  view?: InboxView;
  severity?: InboxSeverity | null;
  unread?: boolean;
  /** The `next` of the page before. */
  before?: string | null;
  /** At most 100. */
  limit?: number;
};

export type InboxPage = { items: InboxItem[]; next: string | null };

/** Unread items in the inbox, by severity. */
export type InboxCounts = { unread: number } & Record<InboxSeverity, number>;

export type InboxMark = "read" | "unread" | "done" | "undone" | "save" | "unsave" | "snooze";

export type InboxMarkArgs = {
  mark: InboxMark;
  /** At most 100. */
  ids?: string[];
  /** Every item in the inbox, when `ids` is empty: Mark all read. */
  all?: boolean;
  severity?: InboxSeverity | null;
  /** For `snooze`: RFC 3339, later than now. */
  until?: string | null;
};

export interface InboxApi {
  /**
   * Newest first; in the inbox unfiltered, unread warnings first. Items about
   * a repository the viewer can no longer read are dropped.
   */
  list(viewer: User, query?: InboxQuery): Promise<InboxPage>;
  counts(username: string): Promise<InboxCounts>;
  /** Changes the person's own items. Returns how many changed. */
  mark(username: string, args: InboxMarkArgs): Promise<number>;
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
  };
}
