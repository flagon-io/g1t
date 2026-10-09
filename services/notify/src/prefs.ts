/**
 * Who hears of what, and how: preferences, and the toast-or-push decision.
 * Pure, so the rules are tested apart from the feed.
 *
 * - Counts always move, whatever the preferences.
 * - A notification is shown (toasted in open tabs, pushed to browsers) when
 *   the person's level for its workspace wants its kind.
 * - Under Do Not Disturb nothing is toasted or pushed.
 * - It is pushed only when no tab of theirs is in front of them: a tab
 *   says it has focus over its socket, and a tab that has said nothing for
 *   `STALE_MS` counts as gone (a laptop lid closed on it).
 */
import type { FeedNotification, NotificationKind, NotifyLevel, NotifyPreferences } from "@g1t/contracts";

// The same as NOTIFY_LEVELS and DEFAULT_NOTIFY_PREFERENCES in @g1t/contracts, kept here so
// Node runs the tests on this file without the contracts package.
const NOTIFY_LEVELS: readonly NotifyLevel[] = ["all", "dms_mentions", "none"];
const DEFAULT_NOTIFY_PREFERENCES: NotifyPreferences = { level: "dms_mentions", workspaces: {} };

/** What `dms_mentions`, the default, lets through: what was said to you, or waits on you. */
const DIRECT: ReadonlySet<NotificationKind> = new Set(["dm", "mention", "thread_reply", "agent_waiting", "approval"]);

/** A tab whose last word is older than this is not in front of anyone. Pings come every 25 s. */
export const STALE_MS = 70_000;

/** The most workspaces with their own level. */
const MAX_OVERRIDES = 200;

export function isLevel(value: unknown): value is NotifyLevel {
  return typeof value === "string" && (NOTIFY_LEVELS as readonly string[]).includes(value);
}

/** The level that applies in `workspace`. */
export function levelFor(prefs: NotifyPreferences, workspace: string): NotifyLevel {
  return prefs.workspaces[workspace.toLowerCase()] ?? prefs.level;
}

/** Whether `level` lets a notification of `kind` be shown. */
export function wants(level: NotifyLevel, kind: NotificationKind): boolean {
  if (level === "none") return false;
  if (level === "all") return true;
  return DIRECT.has(kind);
}

/**
 * Preferences after a change: `change` as sent, checked, over `current`.
 * A workspace set to `null` (or to the general level) goes back to it.
 */
export function mergePreferences(current: NotifyPreferences, change: unknown): NotifyPreferences {
  const c = (change && typeof change === "object" ? change : {}) as Record<string, unknown>;
  const level = isLevel(c.level) ? c.level : current.level;
  const workspaces: Record<string, NotifyLevel> = { ...current.workspaces };
  if (c.workspaces && typeof c.workspaces === "object") {
    for (const [slug, value] of Object.entries(c.workspaces as Record<string, unknown>)) {
      const key = slug.toLowerCase().slice(0, 100);
      if (!key) continue;
      if (isLevel(value)) workspaces[key] = value;
      else if (value === null) delete workspaces[key];
    }
  }
  for (const [slug, value] of Object.entries(workspaces)) if (value === level) delete workspaces[slug];
  const kept = Object.fromEntries(Object.entries(workspaces).slice(0, MAX_OVERRIDES));
  return { level, workspaces: kept };
}

/** Preferences as kept, or the default for anything that is not them. */
export function readPreferences(json: string | null | undefined): NotifyPreferences {
  if (!json) return { ...DEFAULT_NOTIFY_PREFERENCES, workspaces: {} };
  try {
    return mergePreferences({ ...DEFAULT_NOTIFY_PREFERENCES, workspaces: {} }, JSON.parse(json));
  } catch {
    return { ...DEFAULT_NOTIFY_PREFERENCES, workspaces: {} };
  }
}

/** A tab's state as its socket last told it. `seen_at` is when it last said anything, a ping included. */
export type TabState = { focused: boolean; seen_at: number };

/** Whether any tab is in front of the person now. */
export function anyFocused(tabs: TabState[], now: number): boolean {
  return tabs.some((tab) => tab.focused && now - tab.seen_at < STALE_MS);
}

export type Decision = { toast: boolean; push: boolean };

/**
 * What to do with one notification: toast it in open tabs, push it to
 * browsers, both or neither. A test is shown and pushed whatever the
 * preferences and focus say.
 */
export function decide(input: {
  prefs: NotifyPreferences;
  notification: Pick<FeedNotification, "kind" | "workspace">;
  tabs: TabState[];
  subscriptions: number;
  now: number;
  test?: boolean;
  /** Do Not Disturb holds: nothing is toasted or pushed (a test still is). */
  dnd?: boolean;
}): Decision {
  if (input.test) return { toast: true, push: input.subscriptions > 0 };
  if (input.dnd) return { toast: false, push: false };
  const shown = wants(levelFor(input.prefs, input.notification.workspace), input.notification.kind);
  return { toast: shown, push: shown && input.subscriptions > 0 && !anyFocused(input.tabs, input.now) };
}

/** A notification as sent, checked and trimmed; null when it is not one. */
export function cleanNotification(value: unknown): FeedNotification | null {
  if (!value || typeof value !== "object") return null;
  const n = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const kinds: NotificationKind[] = ["dm", "mention", "thread_reply", "inbox", "agent_waiting", "approval"];
  const kind = kinds.find((k) => k === n.kind);
  const id = text(n.id, 200);
  const workspace = text(n.workspace, 100).toLowerCase();
  const title = text(n.title, 200);
  if (!kind || !id || !title) return null;
  const href = text(n.href, 2000);
  const a = (n.actor && typeof n.actor === "object" ? n.actor : {}) as Record<string, unknown>;
  const actorKind = a.kind === "user" || a.kind === "agent" ? a.kind : "system";
  return {
    id,
    kind,
    workspace,
    title,
    body: text(n.body, 300),
    // Relative to the site only: a notification never links somewhere else.
    href: href.startsWith("/") && !href.startsWith("//") ? href : "/",
    actor: {
      kind: actorKind,
      id: text(a.id, 100) || "g1t",
      name: text(a.name, 100) || "g1t",
      avatar: text(a.avatar, 100) || null,
      avatar_seed: text(a.avatar_seed, 100) || null,
    },
    channel_id: text(n.channel_id, 100) || null,
    thread_root: text(n.thread_root, 100) || null,
    created_at: text(n.created_at, 40) || new Date().toISOString(),
  };
}

/**
 * What a push carries: little, under the 4 KB a push may hold. `tag` makes
 * the notifications of one conversation replace each other.
 */
export function pushPayload(n: FeedNotification): { title: string; body: string; href: string; tag: string; kind: NotificationKind; urgent: boolean } {
  return {
    title: n.title,
    body: n.body.slice(0, 240),
    href: n.href,
    tag: n.channel_id ? `chat:${n.channel_id}` : `${n.kind}:${n.id}`,
    kind: n.kind,
    urgent: DIRECT.has(n.kind),
  };
}
