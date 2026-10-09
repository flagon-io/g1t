/**
 * Which frame a page is drawn in, and what the sidebar offers someone who
 * is not signed in.
 *
 * Someone signed in always gets the app's frame: the rail and its modes.
 * A visitor gets it on projects, workspaces and not-found pages, where the
 * sidebar is the project's own menu. g1t's public pages that belong to no
 * workspace (a person's profile, Explore, Search) are drawn for a visitor
 * in the public frame instead: the top bar with the mark, search and
 * signing in, the page at full width, and the footer. So do the front page
 * and the pages about signing in, paying and trust.
 */

import type { Abilities, Capability } from "@g1t/contracts";

/** Pages a visitor sees in the marketing frame. */
const MARKETING = new Set([
  "/",
  "/pricing",
  "/login",
  "/register",
  "/logout",
  "/verify",
  "/confirm-email",
  "/forgot",
  "/reset",
  "/device",
  // Who makes g1t, and the promises it keeps: the policies, security,
  // support and status.
  "/policies",
  "/security",
  "/support",
  "/status",
  // These send a visitor to sign in; the frame matters only for a moment.
  "/new",
  "/settings",
  "/workspaces/new",
]);

/** g1t's public pages that are no workspace's: a visitor reads them in the public frame. */
const PUBLIC_PAGES = new Set(["/explore", "/search"]);

/** Whether the page is drawn in the app's sidebar frame. */
export function usesAppShell(pathname: string, signedIn: boolean): boolean {
  if (signedIn) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (MARKETING.has(path) || PUBLIC_PAGES.has(path)) return false;
  // A person's profile: theirs, not any workspace's.
  if (/^\/u\/[^/]+$/.test(path)) return false;
  if (path === "/oauth" || path.startsWith("/oauth/")) return false;
  // An invite link is the front door: the marketing frame, like /register.
  if (path.startsWith("/invite/")) return false;
  if (path.startsWith("/policies/")) return false;
  // Your settings pages, like /settings: a visitor is sent to sign in.
  if (path.startsWith("/settings/")) return false;
  return true;
}

export type SidebarItem = { label: string; to: string };

/** The visitor's sidebar menu: where to browse from. */
export const VISITOR_LINKS: SidebarItem[] = [
  { label: "Explore", to: "/explore" },
  { label: "Search", to: "/search" },
];

/** The project pages the sidebar lists, by key, for a member or not. */
export type ProjectPage =
  | "code"
  | "issues"
  | "pulls"
  | "agents"
  | "actions"
  | "deployments"
  | "observability"
  | "security"
  | "insights"
  | "settings";

/**
 * What a page needs beyond a role on the repository, once what the viewer
 * may do is known: Security's findings are for people who can push.
 */
export const PAGE_NEEDS: Partial<Record<ProjectPage, Capability>> = { security: "push" };

/**
 * A project's menu, in order. Security and Settings are for people with a
 * role on its repository, and a page in `PAGE_NEEDS` only for those whose
 * role has its capability (`can`, once the repository's page has loaded);
 * everyone who can see the project sees the rest.
 */
export function projectPages(member: boolean, can?: Partial<Abilities>): ProjectPage[] {
  const pages: (ProjectPage | false)[] = [
    "code",
    "issues",
    "pulls",
    "agents",
    "actions",
    // A public repository's deployments and build logs are for anyone, as its code is.
    "deployments",
    "observability",
    member && "security",
    "insights",
    member && "settings",
  ];
  return pages.filter(
    (page): page is ProjectPage => page !== false && (!can || !PAGE_NEEDS[page] || Boolean(can[PAGE_NEEDS[page]!])),
  );
}

/**
 * A project's pages as the phone's strip of tabs under its name names them
 * (routes/repo/layout.tsx): the sidebar's words, and the paths under the
 * project at which each is the current one.
 */
export const PROJECT_PAGE_LINKS: Record<ProjectPage, { label: string; path: string; also: string[]; soon?: boolean }> = {
  code: { label: "Code", path: "code", also: ["tree", "blob", "commits", "commit", "branches", "tags", "releases", "compare"] },
  issues: { label: "Issues", path: "issues", also: ["plans", "milestones", "labels"] },
  pulls: { label: "Pull requests", path: "pulls", also: ["pull", "queue"] },
  agents: { label: "Agents", path: "agents", also: ["sessions", "memory"] },
  actions: { label: "Workflows", path: "actions", also: [] },
  deployments: { label: "Deployments", path: "deployments", also: [] },
  observability: { label: "Observability", path: "soon/logs", also: [], soon: true },
  security: { label: "Security", path: "security", also: [] },
  insights: { label: "Insights", path: "contributors", also: ["activity", "stargazers"] },
  settings: { label: "Settings", path: "settings", also: [] },
};

/**
 * Which of a project's pages `rest` (the path under the project, no
 * leading slash) is on: "overview" for the project itself. `soon` says
 * which page a roadmap page (`soon/<key>`) sits under.
 */
export function projectPageAt(rest: string, soon: Record<string, ProjectPage> = {}): ProjectPage | "overview" | null {
  const path = rest.replace(/^\/+|\/+$/g, "");
  if (path === "") return "overview";
  const soonKey = /^soon\/([^/]+)/.exec(path)?.[1];
  if (soonKey && soon[soonKey]) return soon[soonKey]!;
  for (const [page, link] of Object.entries(PROJECT_PAGE_LINKS) as [ProjectPage, (typeof PROJECT_PAGE_LINKS)[ProjectPage]][]) {
    if ([link.path, ...link.also].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return page;
  }
  return null;
}
