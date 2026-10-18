/**
 * Pages that are tabs of one page keep their tab in the path, not in
 * `?tab=`: `/u/ada/pulls`, `/acme/web/pull/12/files`,
 * `/acme/web/branches/stale`, `/acme/web/settings/rules/insights`,
 * `/notifications/saved`. What narrows a list (state, q, sort, a cursor)
 * stays in the query.
 *
 * Addresses from before still say `?tab=`: `movedTab` is where one goes
 * now, the rest of its query kept, so each page's loader sends it on (301).
 * No Workers or DOM imports, so it is tested under Node.
 */

/** Where an address that still says `?tab=` goes now, or null when it says no `?tab=`. */
export function movedTab(url: URL, pathFor: (tab: string) => string): string | null {
  const tab = url.searchParams.get("tab");
  if (tab == null) return null;
  return `${pathFor(tab.toLowerCase())}${rest(url, "tab")}`;
}

/**
 * The query an address keeps once `moved` is in its path, with its `?`.
 * A click asks for a page's data at `<path>.data?_routes=…`; the address
 * sent on is the page's own, which the browser then asks for as usual.
 */
function rest(url: URL, moved: string): string {
  const kept = new URLSearchParams(url.searchParams);
  kept.delete(moved);
  kept.delete("_routes");
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/** The segment `value` names among `tabs`, the first (the page's own address) for nothing, null for anything else. */
function segmentTab<T extends string>(tabs: readonly T[], value: string | undefined): T | null {
  if (value == null || value === "") return tabs[0];
  return tabs.find((tab) => tab !== tabs[0] && tab === value.toLowerCase()) ?? null;
}

// --- A person's profile -----------------------------------------------------------

export const PROFILE_TABS = ["overview", "pulls", "items", "stars"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** Profile tabs by an old name: Issues is Work items now. */
const PROFILE_MOVED: Record<string, ProfileTab> = { issues: "items" };

/** `/u/<username>`, or one of its tabs: `/u/<username>/pulls`. */
export function profilePath(username: string, tab: ProfileTab | string = "overview"): string {
  const named = PROFILE_MOVED[tab] ?? tab;
  const known = (PROFILE_TABS as readonly string[]).includes(named) ? named : "overview";
  return known === "overview" ? `/u/${username}` : `/u/${username}/${known}`;
}

/** The profile tab a path segment names; null for one it does not (a 404). */
export function profileTab(segment: string | undefined): ProfileTab | null {
  return PROFILE_MOVED[segment?.toLowerCase() ?? ""] ?? segmentTab(PROFILE_TABS, segment);
}

// --- A pull request ---------------------------------------------------------------

export const PULL_TABS = ["conversation", "session", "changes"] as const;
export type PullTab = (typeof PULL_TABS)[number];

/** Each tab's segment: Files changed is `/files`. */
const PULL_SEGMENTS: Record<PullTab, string> = { conversation: "", session: "/session", changes: "/files" };

/** `<repo>/pull/<n>`, or one of its tabs: `<repo>/pull/<n>/files`. `repo` is `/<owner>/<repo>`. */
export function pullPath(repo: string, number: number | string, tab: PullTab | string = "conversation"): string {
  const known: PullTab = tab === "files" ? "changes" : (PULL_TABS as readonly string[]).includes(tab) ? (tab as PullTab) : "conversation";
  return `${repo}/pull/${number}${PULL_SEGMENTS[known]}`;
}

/** The pull request tab a path segment names; null for one it does not (a 404). */
export function pullTab(segment: string | undefined): PullTab | null {
  if (segment == null || segment === "") return "conversation";
  const value = segment.toLowerCase();
  if (value === "files") return "changes";
  if (value === "session") return "session";
  return null;
}

// --- A repository's branches ------------------------------------------------------

/** The Branches page's tabs, as lib/branches.ts's BRANCH_TABS. */
const BRANCH_SEGMENTS = ["overview", "yours", "active", "stale", "all"] as const;

/** `<repo>/branches`, or one of its tabs: `<repo>/branches/stale`. */
export function branchesPath(repo: string, tab: string = "overview"): string {
  const known = (BRANCH_SEGMENTS as readonly string[]).includes(tab) ? tab : "overview";
  return known === "overview" ? `${repo}/branches` : `${repo}/branches/${known}`;
}

/** The Branches tab a path segment names; null for one it does not (a 404). */
export function branchSegment(segment: string | undefined): (typeof BRANCH_SEGMENTS)[number] | null {
  return segmentTab(BRANCH_SEGMENTS, segment);
}

// --- Rules: a repository's or a workspace's ---------------------------------------

export type RulesTab = "rulesets" | "insights";

/** The rules page (`<repo>/settings/rules`, `/<workspace>/-/rules`), or its Insights: `…/rules/insights`. */
export function rulesPath(rules: string, tab: RulesTab | string = "rulesets"): string {
  return tab === "insights" ? `${rules}/insights` : rules;
}

/** The rules tab a page's path is on: `…/rules/insights` is Insights (its data at `…/insights.data`). */
export function rulesAt(pathname: string): RulesTab {
  return /\/rules\/insights(\.data)?\/?$/.test(pathname) ? "insights" : "rulesets";
}

// --- Notifications ----------------------------------------------------------------

export const NOTIFICATION_VIEWS = ["inbox", "saved", "done"] as const;
export type NotificationView = (typeof NOTIFICATION_VIEWS)[number];

/** `/notifications` (Everything), `/notifications/saved` or `/notifications/done`. */
export function notificationsPath(view: NotificationView | string = "inbox"): string {
  return view === "saved" || view === "done" ? `/notifications/${view}` : "/notifications";
}

/** The notifications view a path segment names; null for one it does not (a 404). */
export function notificationView(segment: string | undefined): NotificationView | null {
  return segmentTab(NOTIFICATION_VIEWS, segment);
}

/**
 * A notifications address: the view as its path, and what narrows it
 * (`tab`, the severity tabs; `reason`; `before`, a page's cursor) as its
 * query. Empty values, and the `all` tab, are left out.
 */
export function notificationsAddress(state: { view?: string | null; tab?: string | null; reason?: string | null; before?: string | null }): string {
  const query = new URLSearchParams();
  if (state.tab && state.tab !== "all") query.set("tab", state.tab);
  if (state.reason) query.set("reason", state.reason);
  if (state.before) query.set("before", state.before);
  const text = query.toString();
  return `${notificationsPath(state.view ?? "inbox")}${text ? `?${text}` : ""}`;
}

/** The view a notifications page's path is on: `/notifications/saved` is Saved. */
export function notificationViewAt(pathname: string): NotificationView {
  const [first, second] = pathname.split("/").filter(Boolean);
  return first === "notifications" ? (notificationView(second) ?? "inbox") : "inbox";
}

/** Where a notifications address that still says `?view=` goes now, or null. */
export function movedView(url: URL): string | null {
  const view = url.searchParams.get("view");
  if (view == null) return null;
  return `${notificationsPath(view.toLowerCase())}${rest(url, "view")}`;
}
