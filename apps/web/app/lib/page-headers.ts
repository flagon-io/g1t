/**
 * The headers every answer from the site carries, and the policy its pages
 * run under. No Workers imports, so it can be tested under Node.
 *
 * - Nothing is sniffed: a download or a data request is only the type it says.
 * - A link to another site sends the origin, never the path.
 * - No other site may put g1t's pages in a frame.
 * - A page runs only the scripts the site served it: its own files, and the
 *   inline scripts React and React Router write, each carrying the page's
 *   nonce. Styles may be inline (highlighting and layout set them); images
 *   may come from any HTTPS address (pictures in a README); requests may go
 *   to any HTTPS address (the status page's summary).
 */

/** A fresh nonce for one page: 128 random bits, base64. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The Content-Security-Policy of a page rendered with `nonce`. */
export function pagePolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Cloudflare's Web Analytics beacon, when the zone turns it on.
    `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The answer with the site's headers added. A header the answer already
 * has is kept. An upgrade to a WebSocket is passed on as it is.
 */
export function withSiteHeaders(response: Response): Response {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
  // A redirect's headers cannot be changed, so the answer is copied.
  const answer = new Response(response.body, response);
  const headers = answer.headers;
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (/^text\/html\b/i.test(headers.get("content-type") ?? "") && !headers.has("x-frame-options")) {
    headers.set("x-frame-options", "DENY");
  }
  return answer;
}
