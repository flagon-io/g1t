import { redirect } from "react-router";

import { isNamespaceShaped } from "@g1t/contracts";

import type { Viewer } from "@g1t/contracts";

import { identity, repos } from "./services.server";
import { underWorkspace } from "./workspace-nav";

/**
 * A workspace that was renamed keeps its old address as a redirect for
 * `SLUG_HOLD_DAYS`, and an alias g1t's staff set (identity's aliases.rs:
 * `g1t` for `flagon-io`) leads to its workspace for good. Call this where a
 * page is about to 404 on its first path segment: if `slug` is an old name
 * or an alias, it throws a 301 to the same page (path and query) under the
 * workspace's slug now. Otherwise it returns, and the caller 404s as
 * before. Only the not-found path pays for the lookup.
 */
export async function redirectIfRenamed(request: Request, slug: string): Promise<void> {
  const old = slug.toLowerCase();
  // Nothing that could never have been a workspace's name or an alias is
  // looked up. Reserved names such as `g1t` can be aliases.
  if (!isNamespaceShaped(old)) return;
  let current: string | null = null;
  try {
    current = await identity.resolveSlug(old);
  } catch {
    // A lookup that fails leaves the page a 404, never a 500.
    return;
  }
  if (!current || current === old) return;
  const url = new URL(request.url);
  throw redirect(underWorkspace(url.pathname, url.search, current), 301);
}

/**
 * A repository transferred to another workspace keeps its old address as a
 * redirect until a repository is made there. Call this where a project page
 * is about to 404: if `owner/repo` is a path a repository left, and the
 * viewer may see it where it is now, it throws a 301 to the same page
 * there. A private repository's new address is never shown to someone who
 * cannot see it; they get the 404 as before.
 */
export async function redirectIfTransferred(
  request: Request,
  owner: string,
  repo: string,
  viewer: Viewer,
): Promise<void> {
  let now: { namespace: string; name: string } | null = null;
  try {
    now = await repos.resolvePath({ namespace: owner, name: repo });
    if (!now || !(await repos.get(now, viewer)).ok) return;
  } catch {
    return;
  }
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  segments[1] = now.namespace;
  segments[2] = now.name;
  throw redirect(segments.join("/") + url.search, 301);
}
