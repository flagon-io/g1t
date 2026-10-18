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
 * Workspace mode's pages, in the groups its sidebar lists them under: the
 * workspace's settings area, every page one click away. `owner` marks the
 * pages only owners open; the sidebar shows members the rest.
 * `path` is under `-/`.
 */
export type WorkspaceSettingsPage = { key: string; label: string; path: string; owner?: boolean };

export type WorkspaceSettingsGroup = { key: string; title: string; pages: WorkspaceSettingsPage[] };

export const WORKSPACE_SETTINGS_GROUPS: readonly WorkspaceSettingsGroup[] = [
  {
    key: "general",
    title: "General",
    pages: [{ key: "settings", label: "General", path: "settings", owner: true }],
  },
  {
    key: "ai",
    title: "AI",
    pages: [{ key: "ai", label: "Models", path: "ai" }],
  },
  {
    key: "access",
    title: "Access",
    pages: [
      { key: "members", label: "Members", path: "members" },
      { key: "invitations", label: "Invitations", path: "members/invitations", owner: true },
      { key: "permissions", label: "Permissions", path: "permissions", owner: true },
      { key: "sso", label: "Single sign-on", path: "sso", owner: true },
      { key: "tokens", label: "Access tokens", path: "tokens" },
      { key: "personal-access-tokens", label: "Personal access tokens", path: "personal-access-tokens", owner: true },
    ],
  },
  {
    key: "money",
    title: "Money",
    pages: [
      { key: "usage", label: "Usage", path: "usage" },
      { key: "billing", label: "Billing and plans", path: "billing" },
      { key: "provider-costs", label: "Provider costs", path: "provider-costs" },
    ],
  },
  {
    key: "compute",
    title: "Compute",
    pages: [{ key: "runners", label: "Runners", path: "runners", owner: true }],
  },
  {
    key: "code",
    title: "Code",
    pages: [
      { key: "repositories", label: "Repositories", path: "repositories" },
      { key: "actions", label: "Actions", path: "actions" },
      { key: "secrets", label: "Secrets and variables", path: "secrets" },
      { key: "webhooks", label: "Webhooks", path: "webhooks" },
    ],
  },
  {
    key: "chat",
    title: "Chat",
    pages: [
      { key: "chat-settings", label: "Chat settings", path: "settings/chat" },
      { key: "emoji", label: "Emoji", path: "emoji" },
    ],
  },
  {
    key: "security",
    title: "Security",
    pages: [
      { key: "security-settings", label: "Security settings", path: "security/settings" },
      { key: "guardrails", label: "Guardrails", path: "guardrails" },
      { key: "rules", label: "Rules", path: "rules" },
      { key: "audit", label: "Audit log", path: "audit" },
    ],
  },
  {
    key: "integrations",
    title: "Integrations",
    pages: [{ key: "integrations", label: "Integrations", path: "integrations" }],
  },
];

/**
 * Which of Workspace mode's pages `pathname` is, under the workspace
 * `slug`, as a group key and a page key; null for the overview and for
 * anything else. A page's own subpages (one ruleset, a receipt) count as
 * the page; the deepest match wins, so Invitations is its own page and
 * not a subpage of Members.
 */
export function workspaceSettingsPage(pathname: string, slug: string): { group: string; page: string } | null {
  const parts = pagePath(pathname).split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== slug.toLowerCase() || parts[1] !== "-") return null;
  const rest = parts.slice(2).join("/");
  let found: { group: string; page: string; depth: number } | null = null;
  for (const group of WORKSPACE_SETTINGS_GROUPS) {
    for (const page of group.pages) {
      if (rest === page.path || rest.startsWith(`${page.path}/`)) {
        const depth = page.path.split("/").length;
        if (!found || depth > found.depth) found = { group: group.key, page: page.key, depth };
      }
    }
  }
  return found ? { group: found.group, page: found.page } : null;
}

/** `?tab=` as people write it, from the tabs the workspace page once had: the page it means. */
const TAB_WORDS: Record<string, string> = {
  overview: "",
  projects: "-/projects",
  repositories: "-/projects",
  repos: "-/projects",
  packages: "-/packages",
  people: "-/people",
  members: "-/members",
  teams: "-/teams",
  insights: "-/insights",
  settings: "-/settings",
};

/** Workspace pages that moved, by their old name under `-/`; a new address may carry a query of its own. */
const MOVED: Record<string, string> = {
  // Home was called Today for a while.
  today: "-/home",
  "soon/teams": "-/teams",
  "soon/insights": "-/insights",
};

/** Where the page `rest` (under `-/`) is now, or null when it has not moved. */
function movedTo(rest: string): string | null {
  return MOVED[rest] ?? null;
}

/** `to` with `search` merged into any query of its own, as a path under the workspace. */
function withQuery(to: string, search: string): string {
  const [path = "", own = ""] = to.split("?", 2);
  const params = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(own)) params.set(key, value);
  const query = params.toString();
  return `${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
}

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
  const to = movedTo(parts.slice(2).join("/"));
  if (to === null) return null;
  return `/${slug}${withQuery(to, search)}`;
}

/**
 * The rail's modes. Home is the front page; Work is the workspace's work
 * items and the sessions working on them, for every member;
 * Chat, Code and Artifacts are where work happens; Notifications
 * spans them; People is who belongs; Workspace is the workspace itself,
 * its settings area: who has access, money, policies and how each part is
 * set up; Apps is everything installed that you
 * can use. `account` is your own settings, under the avatar. `site` is
 * g1t's own pages (policies, support, a new workspace): no workspace's, so
 * no mode is lit and no mode's sidebar sits beside them. `browse` is g1t
 * beyond your workspaces (Explore, search, a profile, another workspace
 * and its public projects): the rail lights Explore, and Explore's sidebar
 * sits beside them (`browsingOf`). Each mode has a sidebar of its own, or
 * none, and which one is lit follows the address.
 */
export type ModeKey =
  | "home"
  | "work"
  | "chat"
  | "notifications"
  | "code"
  | "artifacts"
  | "routines"
  | "people"
  | "workspace"
  | "apps"
  | "account"
  | "site"
  | "browse";

/** Workspace pages under `-/`, by the mode they belong to. Anything else of the workspace's is Code's. */
const PAGE_MODES: Record<string, ModeKey> = {
  home: "home",
  // Work's sessions (`-/work/sessions`) are Work's too.
  work: "work",
  chat: "chat",
  artifacts: "artifacts",
  routines: "routines",
  apps: "apps",
  people: "people",
  members: "workspace",
  permissions: "workspace",
  sso: "workspace",
  teams: "people",
  workspace: "workspace",
  usage: "workspace",
  billing: "workspace",
  "provider-costs": "workspace",
  integrations: "workspace",
  ai: "workspace",
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
  if (path === "/") return "home";
  if (path === "/notifications" || path.startsWith("/notifications/")) return "notifications";
  if (path === "/settings" || path.startsWith("/settings/")) return "account";
  const parts = path.split("/").filter(Boolean);
  if (SITE_PAGES.has(parts[0] ?? "")) return "site";
  if (slug && parts[0]?.toLowerCase() === slug.toLowerCase()) {
    if (parts.length === 1) return "home";
    if (parts[1] === "-") {
      // The workspace's security settings are a policy; its alerts are Code's.
      if (parts[2] === "security" && parts[3] === "settings") return "workspace";
      return PAGE_MODES[parts[2] ?? ""] ?? "code";
    }
  }
  // Another workspace's chat, where the viewer is a guest: Chat all the same.
  if (parts[1] === "-" && parts[2] === "chat") return "chat";
  return "code";
}

/** Where each mode's button in the rail goes, in the workspace `slug`. */
export function modeHome(mode: ModeKey, slug: string): string {
  switch (mode) {
    case "home":
      return homePagePath(slug);
    case "work":
      return `/${slug}/-/work`;
    case "notifications":
      return "/notifications";
    case "chat":
      return `/${slug}/-/chat`;
    case "artifacts":
      return `/${slug}/-/artifacts`;
    case "routines":
      return `/${slug}/-/routines`;
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
    case "browse":
      return "/explore";
  }
}

/** First segments that are g1t's own pages and never anyone's name (packages/contracts names.ts). */
const NOT_AN_OWNER = new Set([
  "-", "api", "mcp", "login", "logout", "register", "new", "settings", "search", "admin", "auth", "integrations",
  "pulls", "issues", "verify", "confirm-email", "forgot", "reset", "device", "workspaces", "u", "oauth", "assets",
  "avatars", "docs", "explore", "about", "pricing", "policies", "security", "support", "status", "terms", "privacy",
  "help", "blog", "invite", "invites", "waitlist", "invitations", "v2", "inbox", "notifications", "download",
  "downloads", "install",
]);

/**
 * Whose g1t a browsed page is: a workspace (its overview, its pages, or
 * one of its projects, `repo`) or a person (their profile).
 */
export type BrowsedOwner = { kind: "workspace"; name: string; repo: string | null } | { kind: "person"; name: string };

/** What the shell knows of the viewer, to tell their own pages from the rest of g1t. */
export type Viewer = {
  /** The workspace the shell is about. */
  slug: string | null;
  /** Every workspace they belong to, by slug. */
  memberships: readonly string[];
  /** Repositories shared with them in workspaces they do not belong to: Code lists them as theirs. */
  shared?: readonly { namespace: string; name: string }[];
  /** Their own username: their profile is theirs, not someone's being browsed. */
  username?: string | null;
};

/**
 * Whether `pathname` is g1t beyond the viewer's own workspaces, and whose
 * (`owner`, null for Explore, search and their own profile). Null for
 * anything of theirs. A workspace they belong to is never browsed, even
 * when it is not the one they are in: its pages and projects switch the
 * shell to it (lib/workspace-choice.ts `workspaceFor`), so they are that
 * workspace's modes. A project shared with them is Code's, whose sidebar
 * lists it. Without a workspace there is no rail, and nothing is browsed.
 */
export function browsingOf(pathname: string, viewer: Viewer): { owner: BrowsedOwner | null } | null {
  if (!viewer.slug) return null;
  const parts = pagePath(pathname).split("/").filter(Boolean);
  const first = parts[0]?.toLowerCase();
  if (!first) return null;
  if (first === "explore" || first === "search") return { owner: null };
  if (first === "u") {
    const name = parts[1];
    if (!name) return null;
    const own = viewer.username != null && name.toLowerCase() === viewer.username.toLowerCase();
    return { owner: own ? null : { kind: "person", name } };
  }
  // g1t's own pages, and files such as robots.txt.
  if (NOT_AN_OWNER.has(first) || first.includes(".")) return null;
  if (first === viewer.slug.toLowerCase() || viewer.memberships.some((slug) => slug.toLowerCase() === first)) return null;
  // Another workspace's channels, as a guest in them, are Chat's (`modeOf`), not Explore's.
  if (parts[1] === "-" && parts[2] === "chat") return null;
  const repo = parts[1] && parts[1] !== "-" ? parts[1] : null;
  if (repo && (viewer.shared ?? []).some((r) => r.namespace.toLowerCase() === first && r.name.toLowerCase() === repo.toLowerCase())) return null;
  return { owner: { kind: "workspace", name: parts[0]!, repo } };
}

/** The mode a path is in for this viewer: `browse` beyond their workspaces (`browsingOf`), else `modeOf`'s. */
export function shellMode(pathname: string, viewer: Viewer): ModeKey {
  return browsingOf(pathname, viewer) ? "browse" : modeOf(pathname, viewer.slug);
}

/** A workspace's front page: Home. */
export function homePagePath(slug: string): string {
  return `/${slug}/-/home`;
}

/**
 * Where g1t's front door (`/`) and a workspace's own address lead someone
 * in the workspace `slug`: Home, or Code's Overview when the query asks
 * for its panels (a tab or a sort).
 */
export function homePath(slug: string, search = ""): string {
  const params = new URLSearchParams(search);
  params.delete("_routes");
  params.delete("index");
  const query = params.toString();
  if (params.has("tab") || params.has("sort")) return `/${slug}/-/overview?${query}`;
  return homePagePath(slug);
}

/** The page a member without Code access sees in place of anything of Code's. */
export function codeAccessPath(slug: string, from?: string): string {
  return `/${slug}/-/code-access${from ? `?from=${encodeURIComponent(from)}` : ""}`;
}

/** A repository's addresses that only send the browser on to Work or to what a reference names. */
const WORK_REDIRECTS = new Set(["issues", "labels", "milestones", "ref"]);

/** The workspace pages under `-/` that are Code's: closed to a member without Code access. */
const CODE_PAGES = new Set(["overview", "projects", "repositories", "packages", "security", "rules", "runners", "actions", "insights", "soon"]);

/**
 * Where a member without Code access goes instead of `pathname`, or null
 * when the page is open to them. `noCode` is the workspaces (by slug) where
 * they lack it; `chosen` is the one they are in. g1t's front door (`/`) is
 * Home in that workspace, and so is the workspace's own address; its
 * Code pages and every repository page is the page that says to ask an
 * owner.
 */
export function codeGate(pathname: string, search: string, noCode: readonly string[], chosen: string | null): string | null {
  if (noCode.length === 0) return null;
  const path = pagePath(pathname);
  if (path === "/") {
    const slug = chosen && noCode.includes(chosen.toLowerCase()) ? chosen.toLowerCase() : null;
    return slug ? homePagePath(slug) : null;
  }
  const parts = path.split("/").filter(Boolean);
  const slug = parts[0]?.toLowerCase();
  if (!slug || !noCode.includes(slug)) return null;
  const from = `${path}${search && search !== "?" ? search : ""}`;
  // The workspace's own page is Home.
  if (parts.length === 1) return homePagePath(slug);
  if (parts[1] === "-") return CODE_PAGES.has(parts[2] ?? "") ? codeAccessPath(slug, from) : null;
  // An old link to a repository's issues, labels or milestones leads to
  // Work, which is every member's; a reference (`ref`) leads to what it names.
  if (WORK_REDIRECTS.has(parts[2] ?? "")) return null;
  // A repository, and everything in it.
  return codeAccessPath(slug, from);
}
