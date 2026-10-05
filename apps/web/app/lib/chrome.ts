/**
 * Which frame a page is drawn in, and what the sidebar offers someone who
 * is not signed in.
 *
 * g1t is a sidebar site: projects, Explore, Search, profiles and
 * not-found pages are drawn in the app's sidebar for everyone, so a
 * visitor browsing public projects finds their way the same as a member.
 * Only the front page and the pages about signing in or paying keep the
 * marketing header and footer.
 */

/** Pages a visitor sees in the marketing frame. */
const MARKETING = new Set([
  "/",
  "/pricing",
  "/login",
  "/register",
  "/logout",
  "/verify",
  "/forgot",
  "/reset",
  "/device",
  // These send a visitor to sign in; the frame matters only for a moment.
  "/new",
  "/settings",
  "/workspaces/new",
]);

/** Whether the page is drawn in the app's sidebar frame. */
export function usesAppShell(pathname: string, signedIn: boolean): boolean {
  if (signedIn) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (MARKETING.has(path)) return false;
  if (path === "/oauth" || path.startsWith("/oauth/")) return false;
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
 * A project's menu, in order. Deployments, Security and Settings are for
 * members only; everyone who can see the project sees the rest.
 */
export function projectPages(member: boolean): ProjectPage[] {
  const pages: (ProjectPage | false)[] = [
    "code",
    "issues",
    "pulls",
    "agents",
    "actions",
    member && "deployments",
    "observability",
    member && "security",
    "insights",
    member && "settings",
  ];
  return pages.filter((page): page is ProjectPage => page !== false);
}
