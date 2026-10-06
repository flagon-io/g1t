/**
 * Which of your workspaces the sidebar and Mission control are about.
 *
 * It changes only when you choose one: from the switcher, or by opening a
 * workspace's own pages. Looking at a project in another workspace, or a
 * public one, leaves it alone, so coming back finds everything as it was.
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
 * yours and the page is the workspace's own (not a project in it), else the
 * chosen one.
 */
export function workspaceFor<M extends Membership>(
  memberships: M[],
  chosen: string | null | undefined,
  params: { owner?: string; repo?: string },
): M | null {
  if (params.owner && !params.repo) {
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
