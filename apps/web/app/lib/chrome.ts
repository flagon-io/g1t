/**
 * Which frame a page is drawn in.
 *
 * - `standalone`: signing in, signing up and choosing a workspace. The
 *   page alone, centred, with the logo and a quiet row of links at the
 *   foot: no header, no sidebar, no dock.
 * - `app`: someone signed in, everywhere else. The dock, the mode's
 *   sidebar and the page in its panel, always about their current
 *   workspace, even on public pages such as Explore, a profile or another
 *   workspace's public project.
 * - `public`: a visitor who is not signed in (or has not confirmed their
 *   address yet), on every other page: a plain header with the logo,
 *   Explore, Docs and signing in, the page at full width, and the footer.
 */

import type { Abilities, Capability } from "@g1t/contracts";

export type Frame = "standalone" | "public" | "app";

/** Pages that are drawn on their own, whoever opens them. */
const STANDALONE = new Set([
  "/login",
  "/login/two-factor",
  "/register",
  "/logout",
  "/verify",
  "/confirm-email",
  "/forgot",
  "/reset",
  "/device",
  "/oauth/authorize",
  "/workspaces/new",
  "/integrations/github/setup",
]);

/** The page's path without a trailing slash or a click's `.data`. */
function framePath(pathname: string): string {
  const path = pathname.replace(/\.data$/, "");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The frame for `pathname`. `viewer` says whether someone is signed in and
 * confirmed (`signedIn`), and whether they belong to a workspace yet: until
 * they do, answering an invitation is part of getting started too.
 */
export function frameOf(pathname: string, viewer: { signedIn: boolean; workspace: boolean }): Frame {
  const path = framePath(pathname);
  if (STANDALONE.has(path)) return "standalone";
  // An invite link, and signing in with GitHub, are the front door.
  if (path.startsWith("/invite/") || path === "/auth/github" || path.startsWith("/auth/github/")) return "standalone";
  if (path === "/invitations" && viewer.signedIn && !viewer.workspace) return "standalone";
  return viewer.signedIn ? "app" : "public";
}

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
