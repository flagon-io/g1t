/**
 * The signed-out page cache (workers/app.ts) keeps a repository's pages for
 * visitors who are not signed in. Before a kept page is served, the
 * repository is asked for again: one that was made private, or deleted,
 * since the page was kept is never served from the cache, wherever it was
 * kept. This says which repository a kept page belongs to.
 */

/** `<workspace>/<repository>` of a project page's path, or null for any other page. */
export function repositoryOfPage(pathname: string): string | null {
  const [, workspace, rest] = /^\/([^/]+)\/([^/]+)/.exec(pathname) ?? [];
  if (!workspace || !rest || rest === "-") return null;
  const name = rest.replace(/\.data$/, "");
  if (!name) return null;
  return `${decodeURIComponent(workspace).toLowerCase()}/${decodeURIComponent(name).toLowerCase()}`;
}

/** Whether repos' `visibility` answer says the repository is still there and public. */
export function stillPublic(answer: unknown, path: string): boolean {
  if (!Array.isArray(answer)) return false;
  const found = answer.find((v): v is { path: string; is_private: boolean } => {
    return typeof v === "object" && v !== null && (v as { path?: unknown }).path === path;
  });
  return found !== undefined && found.is_private === false;
}
