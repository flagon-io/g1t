/**
 * The workspace gate: everything on g1t lives in a workspace, so a confirmed
 * person with none is sent to make one or answer an invitation to one
 * (`/workspaces/new`, "Create your workspace or ask to join one"), from
 * every page but the few that needs, and is returned to where they were
 * going afterwards. Mission control is never shown without a workspace.
 * No Workers or React imports, so it can be tested under Node.
 */

/** Where someone without a workspace makes one, or answers an invitation. */
export const NO_WORKSPACE_PATH = "/workspaces/new";

/** Pages a signed-in person can use before they have a workspace. */
const BEFORE_WORKSPACE = new Set([
  NO_WORKSPACE_PATH,
  "/invitations",
  "/settings",
  "/verify",
  "/logout",
  "/auth/github",
  "/auth/github/callback",
  "/inbox",
  "/inbox.json",
  "/settings/menu.json",
  // Who makes g1t and the promises it keeps.
  "/policies",
  "/security",
  "/support",
  "/pricing",
]);

type Someone =
  | {
      verified?: boolean;
      kind?: string;
      workspaces?: unknown[] | null;
      grants?: unknown[] | null;
      held?: unknown[] | null;
    }
  | null
  | undefined;

/** Whether `viewer` is a confirmed person who belongs to no workspace and has nothing else to use. */
export function hasNoWorkspace(viewer: Someone): boolean {
  if (!viewer?.verified) return false;
  if (viewer.kind && viewer.kind !== "user") return false;
  return (
    (viewer.workspaces ?? []).length === 0 &&
    // Someone a repository is shared with can use it without a workspace.
    (viewer.grants ?? []).length === 0 &&
    // Someone held out of their workspaces until they meet its policy is
    // told so, and sent to turn on two-factor authentication, not to make one.
    (viewer.held ?? []).length === 0
  );
}

/**
 * Where to send `viewer` instead of `page` (a page's path; a data request's
 * page, from `pageOf`) + `search`: the page to make a workspace or answer
 * an invitation, with where they were going as `next`. Null when they have
 * a workspace or the page is theirs to open without one.
 */
export function workspaceGate(page: string, search: string, viewer: Someone): string | null {
  if (!hasNoWorkspace(viewer)) return null;
  const path = page.length > 1 ? page.replace(/\/+$/, "") : page;
  if (
    BEFORE_WORKSPACE.has(path) ||
    path.startsWith("/settings/") ||
    path.startsWith("/policies/") ||
    path.startsWith("/-/") ||
    path.startsWith("/u/") ||
    // An invite to a workspace is how someone without one gets one, and an
    // invitation to a repository is answered before anything else.
    path.startsWith("/invite/") ||
    /^\/[^/]+\/[^/]+\/invitations$/.test(path)
  ) {
    return null;
  }
  const params = new URLSearchParams(search);
  params.delete("_routes");
  const query = params.toString();
  const next = path === "/" && !query ? "" : `?next=${encodeURIComponent(path + (query ? `?${query}` : ""))}`;
  return `${NO_WORKSPACE_PATH}${next}`;
}
