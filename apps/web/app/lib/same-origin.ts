/**
 * Whether a request came from another site: its `Origin` names an origin
 * other than the site's own. Form posts from g1t's pages carry the site's
 * origin; a request without the header (not from a browser's form) is not
 * cross-site. lib/session.server.ts's `assertSameOrigin` refuses these on
 * every action, for a session cookie and an access token alike
 * (lib/website-token.ts).
 */
export function crossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin !== new URL(request.url).origin);
}
