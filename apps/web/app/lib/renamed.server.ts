import { redirect } from "react-router";

import { isValidNamespace } from "@g1t/contracts";

import type { Viewer } from "@g1t/contracts";

import { identity, repos } from "./services.server";

/**
 * A workspace that was renamed keeps its old address as a redirect for
 * `SLUG_HOLD_DAYS`. Call this where a page is about to 404 on its first
 * path segment: if `slug` is an old name, it throws a 301 to the same
 * address (path and query) under the current one. Otherwise it returns, and
 * the caller 404s as before. Only the not-found path pays for the lookup.
 */
export async function redirectIfRenamed(request: Request, slug: string): Promise<void> {
  const old = slug.toLowerCase();
  // Nothing that could never have been a workspace's name is looked up.
  if (!isValidNamespace(old)) return;
  let current: string | null = null;
  try {
    current = await identity.resolveSlug(old);
  } catch {
    // A lookup that fails leaves the page a 404, never a 500.
    return;
  }
  if (!current || current === old) return;
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  // segments[0] is the empty string before the leading slash.
  segments[1] = current;
  throw redirect(segments.join("/") + url.search, 301);
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
