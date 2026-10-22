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

/**
 * A kept page as the cache every data centre shares (Workers KV, `PAGES`)
 * holds it: a line of JSON with its status, its headers and when it was
 * kept, then its body. A data centre that has no copy of its own serves
 * this one rather than draw the page afresh (#383): its first visitor in a
 * while waits for one read, not for every service the page asks.
 */
export type SharedPage = { status: number; headers: [string, string][]; keptAt: number; body: Uint8Array<ArrayBuffer> };

/** Where a page is kept in the shared cache: its colo cache key, hashed to fit a KV key. */
export async function sharedPageKey(cacheKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheKey));
  return `page:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function encodeSharedPage(page: SharedPage): Uint8Array {
  // Each try's own timings are not the page's.
  const headers = page.headers.filter(([name]) => name.toLowerCase() !== "server-timing");
  const head = new TextEncoder().encode(`${JSON.stringify({ status: page.status, headers, keptAt: page.keptAt })}\n`);
  const out = new Uint8Array(head.length + page.body.length);
  out.set(head);
  out.set(page.body, head.length);
  return out;
}

/** The page in `bytes`, or null for anything that is not one. */
export function decodeSharedPage(bytes: Uint8Array): SharedPage | null {
  const at = bytes.indexOf(0x0a);
  if (at < 0) return null;
  try {
    const { status, headers, keptAt } = JSON.parse(new TextDecoder().decode(bytes.subarray(0, at))) as Partial<SharedPage>;
    if (typeof status !== "number" || !Array.isArray(headers) || typeof keptAt !== "number") return null;
    return { status, headers, keptAt, body: bytes.slice(at + 1) };
  } catch {
    return null;
  }
}

/** Whether repos' `visibility` answer says the repository is still there and public. */
export function stillPublic(answer: unknown, path: string): boolean {
  if (!Array.isArray(answer)) return false;
  const found = answer.find((v): v is { path: string; is_private: boolean } => {
    return typeof v === "object" && v !== null && (v as { path?: unknown }).path === path;
  });
  return found !== undefined && found.is_private === false;
}
