/**
 * A workspace's own page at `g1t.sh/<workspace>`: its header, and tabs for
 * what it has (Overview, Projects, Packages, Teams, People, Insights and,
 * for owners, Settings). The sidebar is always the current workspace's;
 * this page is where the workspace itself is shown, to members and to
 * everyone else.
 */

export type WorkspaceTabKey = "overview" | "projects" | "packages" | "teams" | "people" | "insights" | "settings";

export type WorkspaceTab = {
  key: WorkspaceTabKey;
  label: string;
  to: string;
  /** Shown beside the label; left out when unknown. */
  count?: number | null;
  /** Not built yet: its tab opens what it will be. */
  soon?: boolean;
};

/** The workspace's pages under `-/` that are drawn under its tabs. */
export const TAB_PAGES = ["projects", "packages", "teams", "people", "insights"] as const;

/** Tabs whose pages say what they will be, until they are built. */
export const SOON_TABS = new Set<WorkspaceTabKey>(["insights"]);

/**
 * The tabs, in order. People, Teams and Insights are for members, and
 * Settings for owners; everyone sees the rest.
 */
export function workspaceTabs(
  slug: string,
  options: { member: boolean; owner: boolean; projects?: number | null; people?: number | null },
): WorkspaceTab[] {
  const base = `/${slug}`;
  const tabs: (WorkspaceTab | false)[] = [
    { key: "overview", label: "Overview", to: base },
    { key: "projects", label: "Projects", to: `${base}/-/projects`, count: options.projects ?? null },
    { key: "packages", label: "Packages", to: `${base}/-/packages` },
    options.member && { key: "teams", label: "Teams", to: `${base}/-/teams` },
    options.member && { key: "people", label: "People", to: `${base}/-/people`, count: options.people ?? null },
    options.member && { key: "insights", label: "Insights", to: `${base}/-/insights`, soon: true },
    options.owner && { key: "settings", label: "Settings", to: `${base}/-/settings` },
  ];
  return tabs.filter((tab): tab is WorkspaceTab => tab !== false);
}

/**
 * Which tab a path is, under `/<workspace>`: null for the workspace's other
 * pages (its settings, Agent fleet, Usage and the rest), which have a page
 * heading of their own, and for one package's page.
 */
export function workspaceTab(pathname: string, slug: string): WorkspaceTabKey | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== slug.toLowerCase()) return null;
  if (parts.length === 1) return "overview";
  if (parts[1] !== "-" || parts.length !== 3) return null;
  return (TAB_PAGES as readonly string[]).includes(parts[2]!) ? (parts[2] as WorkspaceTabKey) : null;
}

/** `?tab=` as people write it, from habit: the tab it means. */
const TAB_WORDS: Record<string, string> = {
  overview: "",
  projects: "-/projects",
  repositories: "-/projects",
  repos: "-/projects",
  packages: "-/packages",
  people: "-/people",
  members: "-/people",
  teams: "-/teams",
  insights: "-/insights",
};

/** Workspace pages that moved, by their old name under `-/`. */
const MOVED: Record<string, string> = {
  members: "-/people",
  overview: "",
  "soon/teams": "-/teams",
  "soon/insights": "-/insights",
};

/** The page a request is for: a click's data request ends in `.data`. */
export function pagePath(pathname: string): string {
  return pathname.replace(/\.data$/, "").replace(/\/+$/, "") || "/";
}

/**
 * Where an old address of a workspace's pages is now, keeping its query;
 * null when it has not moved. `/<workspace>?tab=projects` and the like
 * open that tab.
 */
export function workspaceRedirect(pathname: string, search = ""): string | null {
  // A click asks for the page's data at `<path>.data?_routes=…`; the page
  // is the same one a full load asks for.
  const params = new URLSearchParams(search);
  params.delete("_routes");
  search = params.toString();
  const parts = pagePath(pathname).split("/").filter(Boolean);
  const slug = parts[0];
  if (!slug) return null;
  if (parts.length === 1 && params.has("tab")) {
    const to = TAB_WORDS[(params.get("tab") ?? "").toLowerCase()];
    if (to === undefined) return null;
    params.delete("tab");
    const rest = params.toString();
    return `/${slug}${to ? `/${to}` : ""}${rest ? `?${rest}` : ""}`;
  }
  if (parts[1] !== "-") return null;
  const to = MOVED[parts.slice(2).join("/")];
  if (to === undefined) return null;
  return `/${slug}${to ? `/${to}` : ""}${search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : ""}`;
}
