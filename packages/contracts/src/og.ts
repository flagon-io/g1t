/**
 * Social cards (services/og, at og.g1t.sh), as the site and the docs link
 * to them.
 *
 * Bump `OG_RENDER_VERSION` whenever the cards' design changes: the logo,
 * the layout, the type, the colours or the brand line. It is part of every
 * card's address and of og's cache key, so a new design gets new addresses
 * everywhere at once: og's edge cache, browsers and the caches of every
 * site that has already fetched a card. Without a bump, a redeployed og
 * keeps serving the cards it drew before.
 */
export const OG_RENDER_VERSION = "2";

/**
 * A card's `v` parameter: the render version, then, when the page has one,
 * the version of what the card shows (a fingerprint of its title, counts
 * and so on), so a card is drawn again when either changes.
 */
export function ogVersion(content?: string): string {
  return content ? `${OG_RENDER_VERSION}.${content}` : OG_RENDER_VERSION;
}
