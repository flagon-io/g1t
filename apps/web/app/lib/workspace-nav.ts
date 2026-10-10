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
 * workspace's other pages (settings, Usage and the rest), for
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
 * The workspace's pages that its Settings row drills into. Runners is not
 * one: it is a page of Workspace mode's own, at `-/runners`.
 */
export const SETTINGS_PAGES = [
  "settings",
  "repositories",
  "tokens",
  "rules",
  "guardrails",
  "secrets",
  "actions",
  "integrations",
  "webhooks",
  "emoji",
  "billing",
  "audit",
] as const;

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
  home: "-/today",
  members: "-/people",
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

/**
 * The dock's modes. Today is the front page;
 * Chat, Agents, Code and Artifacts are where work happens; Notifications
 * spans them; People is who belongs; Workspace is the workspace itself:
 * its money, policies and settings; Apps is everything installed that you
 * can use. `account` is your own settings, under the avatar. `site` is
 * g1t's own public pages (a profile, Explore, Search): no workspace's, so
 * no mode is lit and no mode's sidebar sits beside them. Each mode has a
 * sidebar of its own, or none, and which one is lit follows the address.
 */
export type ModeKey =
  | "today"
  | "chat"
  | "notifications"
  | "agents"
  | "code"
  | "artifacts"
  | "people"
  | "workspace"
  | "apps"
  | "account"
  | "site";

/** Workspace pages under `-/`, by the mode they belong to. Anything else of the workspace's is Code's. */
const PAGE_MODES: Record<string, ModeKey> = {
  today: "today",
  chat: "chat",
  artifacts: "artifacts",
  agents: "agents",
  context: "agents",
  memory: "agents",
  apps: "apps",
  people: "people",
  members: "people",
  teams: "people",
  workspace: "workspace",
  spend: "workspace",
  usage: "workspace",
  gateway: "workspace",
  billing: "workspace",
  integrations: "workspace",
  guardrails: "workspace",
  rules: "workspace",
  audit: "workspace",
  settings: "workspace",
  repositories: "workspace",
  tokens: "workspace",
  "personal-access-tokens": "workspace",
  secrets: "workspace",
  actions: "workspace",
  runners: "workspace",
  webhooks: "workspace",
  emoji: "workspace",
};

/** First segments that are g1t's own pages, never a workspace: none is any mode's. */
const SITE_PAGES = new Set(["explore", "search", "support", "policies", "security", "status", "u", "invite", "workspaces"]);

/**
 * The mode a path is in, for the workspace `slug`. A repository (anyone's)
 * and a new project are Code's; g1t's own pages (Explore, search, a
 * profile) are `site`: public, and no workspace's mode.
 */
export function modeOf(pathname: string, slug: string | null): ModeKey {
  const path = pagePath(pathname);
  if (path === "/") return "today";
  if (path === "/notifications" || path.startsWith("/notifications/")) return "notifications";
  if (path === "/settings" || path.startsWith("/settings/")) return "account";
  const parts = path.split("/").filter(Boolean);
  if (SITE_PAGES.has(parts[0] ?? "")) return "site";
  if (slug && parts[0]?.toLowerCase() === slug.toLowerCase()) {
    if (parts.length === 1) return "today";
    if (parts[1] === "-") {
      // The workspace's security settings are a policy; its alerts are Code's.
      if (parts[2] === "security" && parts[3] === "settings") return "workspace";
      return PAGE_MODES[parts[2] ?? ""] ?? "code";
    }
  }
  return "code";
}

/** Where each mode's button in the dock goes, in the workspace `slug`. */
export function modeHome(mode: ModeKey, slug: string): string {
  switch (mode) {
    case "today":
      return todayPath(slug);
    case "notifications":
      return "/notifications";
    case "chat":
      return `/${slug}/-/chat`;
    case "artifacts":
      return `/${slug}/-/artifacts`;
    case "agents":
      return `/${slug}/-/agents`;
    case "code":
      return `/${slug}/-/overview`;
    case "people":
      return `/${slug}/-/people`;
    case "workspace":
      return `/${slug}/-/workspace`;
    case "apps":
      return `/${slug}/-/apps`;
    case "account":
      return "/settings";
    case "site":
      return "/explore";
  }
}

/** A workspace's front page: Today. */
export function todayPath(slug: string): string {
  return `/${slug}/-/today`;
}

/**
 * Where g1t's front door (`/`) and a workspace's own address lead someone
 * in the workspace `slug`: Today, or Code's Overview when the query asks
 * for its panels (a tab, or `?agent=new` to put an agent on something).
 */
export function homePath(slug: string, search = ""): string {
  const params = new URLSearchParams(search);
  params.delete("_routes");
  params.delete("index");
  const query = params.toString();
  if (params.has("agent") || params.has("tab") || params.has("sort")) return `/${slug}/-/overview?${query}`;
  return todayPath(slug);
}

/** The page a member without Code access sees in place of anything of Code's. */
export function codeAccessPath(slug: string, from?: string): string {
  return `/${slug}/-/code-access${from ? `?from=${encodeURIComponent(from)}` : ""}`;
}

/** The workspace pages under `-/` that are Code's: closed to a member without Code access. */
const CODE_PAGES = new Set(["overview", "projects", "repositories", "packages", "security", "rules", "runners", "actions", "context", "memory", "insights", "soon"]);

/**
 * Where a member without Code access goes instead of `pathname`, or null
 * when the page is open to them. `noCode` is the workspaces (by slug) where
 * they lack it; `chosen` is the one they are in. g1t's front door (`/`) is
 * Today in that workspace, and so is the workspace's own address; its
 * Code pages and every repository page is the page that says to ask an
 * owner.
 */
export function codeGate(pathname: string, search: string, noCode: readonly string[], chosen: string | null): string | null {
  if (noCode.length === 0) return null;
  const path = pagePath(pathname);
  if (path === "/") {
    const slug = chosen && noCode.includes(chosen.toLowerCase()) ? chosen.toLowerCase() : null;
    return slug ? todayPath(slug) : null;
  }
  const parts = path.split("/").filter(Boolean);
  const slug = parts[0]?.toLowerCase();
  if (!slug || !noCode.includes(slug)) return null;
  const from = `${path}${search && search !== "?" ? search : ""}`;
  // The workspace's own page is Today.
  if (parts.length === 1) return todayPath(slug);
  if (parts[1] === "-") return CODE_PAGES.has(parts[2] ?? "") ? codeAccessPath(slug, from) : null;
  // A repository, and everything in it.
  return codeAccessPath(slug, from);
}
