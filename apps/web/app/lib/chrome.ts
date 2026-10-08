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

/** Whether the page is drawn in the app's sidebar frame. */
export function usesAppShell(pathname: string, signedIn: boolean): boolean {
  if (signedIn) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (MARKETING.has(path)) return false;
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
