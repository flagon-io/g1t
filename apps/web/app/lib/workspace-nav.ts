/**
 * A workspace's pages and where the sidebar finds them. `g1t.sh/<workspace>`
 * is the workspace's own page, its header and overview; Projects, Packages,
 * Teams, People, Insights and Settings are pages of their own under `-/`,
 * each reached from the sidebar and each with its own heading. The sidebar
 * is always the current workspace's.
 */

/** The workspace's pages a person moves between, and which the sidebar lists. */
export type WorkspacePageKey = "overview" | "projects" | "packages" | "teams" | "people" | "insights";

/** Those pages under `-/`: the overview is the workspace's own address. */
export const WORKSPACE_PAGES = ["projects", "packages", "teams", "people", "insights"] as const;

/**
 * Which of those pages a path is, under `/<workspace>`: null for the
 * workspace's other pages (settings, Agent fleet, Usage and the rest), for
 * one package's or one team's page, and for anything else.
 */
export function workspacePage(pathname: string, slug: string): WorkspacePageKey | null {
  const parts = pagePath(pathname).split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== slug.toLowerCase()) return null;
  if (parts.length === 1) return "overview";
  if (parts[1] !== "-" || parts.length !== 3) return null;
  return (WORKSPACE_PAGES as readonly string[]).includes(parts[2]!) ? (parts[2] as WorkspacePageKey) : null;
}

/**
 * The sidebar's rows. The first two are the person's own, whichever
 * workspace they are in; the rest are the workspace's.
 */
export type SidebarKey =
  | "mission"
  | "inbox"
  | "overview"
  | "projects"
  | "agents"
  | "context"
  | "memory"
  | "security"
  | "packages"
  | "insights"
  | "people"
  | "teams"
  | "usage"
  | "support"
  | "settings";

/** The workspace's pages that its Settings row drills into. */
export const SETTINGS_PAGES = [
  "settings",
  "repositories",
  "tokens",
  "guardrails",
  "secrets",
  "runners",
  "integrations",
  "webhooks",
  "billing",
  "audit",
] as const;

/** Pages under `-/` whose sidebar row has another name. */
const ROW_OF: Record<string, SidebarKey> = {
  projects: "projects",
  agents: "agents",
  context: "context",
  memory: "memory",
  security: "security",
  packages: "packages",
  insights: "insights",
  people: "people",
  teams: "teams",
  usage: "usage",
};

/**
 * The sidebar row that is current on a path: one row at most, so the
 * sidebar always says where you are. `slug` is the workspace the sidebar
 * is about; another workspace's pages light nothing.
 */
export function sidebarCurrent(pathname: string, slug: string | null): SidebarKey | null {
  const path = pagePath(pathname);
  if (path === "/") return "mission";
  if (path === "/inbox" || path.startsWith("/inbox/")) return "inbox";
  if (path === "/support" || path.startsWith("/support/")) return "support";
  const parts = path.split("/").filter(Boolean);
  if (!slug || parts[0]?.toLowerCase() !== slug.toLowerCase()) return null;
  if (parts.length === 1) return "overview";
  if (parts[1] !== "-") return null;
  const page = parts[2] ?? "";
  if ((SETTINGS_PAGES as readonly string[]).includes(page)) return "settings";
  return ROW_OF[page] ?? null;
}

/** `?tab=` as people write it, from the tabs the workspace page once had: the page it means. */
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
  settings: "-/settings",
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
 * The page at `pathname` under the workspace `slug` instead of its first
 * segment, keeping its query: where an old name or an alias leads. A click
 * asks for the page's data at `<path>.data?_routes=…`; the address given is
 * the page's own, which the browser then asks for as usual.
 */
export function underWorkspace(pathname: string, search: string, slug: string): string {
  const params = new URLSearchParams(search);
  params.delete("_routes");
  const query = params.toString();
  const segments = pagePath(pathname).split("/");
  // segments[0] is the empty string before the leading slash.
  segments[1] = slug;
  return `${segments.join("/")}${query ? `?${query}` : ""}`;
}

/**
 * Where an old address of a workspace's pages is now, keeping its query;
 * null when it has not moved. `/<workspace>?tab=projects` and the like
 * open that page.
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
