/**
 * What an app's old address answers once its workspace is renamed: every
 * request is sent, path and query kept, to the same app at its new name.
 * The old script stays in the dispatch namespace as this tiny Worker for as
 * long as the workspace holds its old slug (`SLUG_HOLD_DAYS`), then the
 * sweep removes it.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

/** A hostname under g1t.page: labels of letters, digits and hyphens. */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Where a request to the old address goes: the same path and query on `targetHost`. */
export function redirectLocation(requestUrl: string, targetHost: string): string {
  const url = new URL(requestUrl);
  return `https://${targetHost}${url.pathname}${url.search}`;
}

/**
 * The module Worker that answers every request with a 301 to the same path
 * and query on `targetHost` (such as `web-acme.g1t.page`). Its logic is
 * `redirectLocation`'s, spelled out again so the script needs nothing.
 */
export function redirectScript(targetHost: string): string {
  const host = targetHost.toLowerCase();
  if (!HOST.test(host)) throw new Error(`Not a hostname to redirect to: ${targetHost}`);
  return `const TARGET = ${JSON.stringify(host)};
export default {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(null, {
      status: 301,
      headers: {
        location: "https://" + TARGET + url.pathname + url.search,
        "x-robots-tag": "noindex",
        "cache-control": "public, max-age=3600",
      },
    });
  },
};
`;
}
