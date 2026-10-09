/**
 * While rendering is paused across g1t (billing's `platform_pause`,
 * `renders`; docs/SPEND-GUARDRAILS.md), no card is drawn: a request that
 * misses the edge cache gets the brand card the cache already has, or a
 * redirect to g1t's static logo. Either is kept only a minute, so cards
 * come back soon after rendering is resumed.
 */

/** g1t's logo on dark, served by the site as a static file. */
export const STATIC_CARD = "https://g1t.sh/brand/g1t-logo-on-dark.png";

const PAUSED_CACHE_CONTROL = "public, max-age=60";

/** What a cache miss is answered with while renders are paused. */
export function pausedCard(brand: Response | undefined): Response {
  if (brand) {
    const response = new Response(brand.body, brand);
    response.headers.set("cache-control", PAUSED_CACHE_CONTROL);
    return response;
  }
  return new Response(null, {
    status: 302,
    headers: { location: STATIC_CARD, "cache-control": PAUSED_CACHE_CONTROL, "access-control-allow-origin": "*" },
  });
}
