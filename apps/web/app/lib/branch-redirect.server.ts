import { redirect } from "react-router";

import type { RepoPath, Viewer } from "@g1t/contracts";

import { renamedBranchPath } from "./repo-lifecycle";
import { repos } from "./services.server";

/**
 * A renamed branch keeps its old name as a redirect. Call this where a
 * tree or blob page is about to 404 on `ref`: if the branch was renamed
 * away from it, it throws a 301 to the same page on the new name.
 * Otherwise it returns, and the caller 404s as before. Only the not-found
 * path pays for the lookup.
 */
export async function redirectIfBranchRenamed(
  request: Request,
  path: RepoPath,
  viewer: Viewer,
  ref: string,
): Promise<void> {
  let to: string | null = null;
  try {
    const repo = await repos.get(path, viewer);
    if (!repo.ok) return;
    const now = await repos.resolveBranch(repo.value.id, ref);
    if (!now || now === ref) return;
    const url = new URL(request.url);
    to = renamedBranchPath(url.pathname, url.search, now);
  } catch {
    // A lookup that fails leaves the page a 404, never a 500.
    return;
  }
  if (to) throw redirect(to, 301);
}
