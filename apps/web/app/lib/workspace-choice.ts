/**
 * Which of your workspaces the sidebar and Mission control are about.
 *
 * The page's own workspace wins: a workspace's pages, and a project in one
 * of your workspaces, are about that workspace, so the switcher always
 * names the workspace you are looking at. A project somewhere you do not
 * belong (a public one, or one shared with you) leaves the chosen one, and
 * the choice itself changes only from the switcher or a workspace's pages.
 */

export const WORKSPACE_COOKIE = "g1t_ws";

type Membership = { slug: string };

/** The chosen workspace if you still belong to it, else your first. */
export function chosenWorkspace<M extends Membership>(memberships: M[], chosen: string | null | undefined): M | null {
  const wanted = chosen?.trim().toLowerCase();
  return memberships.find((m) => m.slug.toLowerCase() === wanted) ?? memberships[0] ?? null;
}

/**
 * The workspace a page is about: the one in its address when it is one of
 * yours, whether the page is the workspace's own or a project in it, else
 * the chosen one.
 */
export function workspaceFor<M extends Membership>(
  memberships: M[],
  chosen: string | null | undefined,
  params: { owner?: string; repo?: string },
): M | null {
  if (params.owner) {
    const here = memberships.find((m) => m.slug.toLowerCase() === params.owner!.toLowerCase());
    if (here) return here;
  }
  return chosenWorkspace(memberships, chosen);
}

/** The Set-Cookie header that remembers a choice, for a year. */
export function rememberWorkspace(slug: string, secure: boolean): string {
  return `${WORKSPACE_COOKIE}=${encodeURIComponent(slug.toLowerCase())}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The Set-Cookie header that forgets the choice: after its workspace is deleted. */
export function forgetWorkspace(secure: boolean): string {
  return `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
}
