import { OG_RENDER_VERSION } from "@g1t/contracts/og";

import { cardPath, clean } from "./resolve.ts";

/**
 * The version of the cards' design, part of every cache key. Bump it (in
 * `packages/contracts/src/og.ts`, which the site and the docs read too)
 * whenever the card design changes, so the cards already cached are drawn
 * again and every page links to a new address.
 */
export const RENDER_VERSION = OG_RENDER_VERSION;

/**
 * A `v` as the site and the docs write it (`ogVersion` in
 * packages/contracts): the render version, then, for the site, a
 * fingerprint of what the card shows, at most seven base-36 characters.
 */
const VERSION = new RegExp(`^${RENDER_VERSION.replace(/\./g, "\\.")}(\\.[0-9a-z]{1,7})?$`);

/**
 * The address a card is cached under: the render version, then only the
 * parameters that change the card, in order, so stray ones (trackers,
 * cache busters) cannot fill the cache. A page's address is the page whose
 * card it shows (`cardPath`), the docs' text as the card draws it, and the
 * page's own content version `v` only in the form the site writes it.
 */
export function cacheKey(url: URL): string {
  const key = new URL(url.pathname, url.origin);
  key.searchParams.set("render", RENDER_VERSION);
  const set = (name: string, value: string | null) => {
    if (value !== null) key.searchParams.set(name, value);
  };
  if (url.pathname === "/docs") {
    // As docsCard reads them.
    set("title", clean(url.searchParams.get("title"), 160));
    set("section", clean(url.searchParams.get("section"), 60));
    set("description", clean(url.searchParams.get("description"), 300));
  } else if (url.pathname === "/image") {
    set("path", cardPath(url.searchParams.get("path") ?? "/"));
  } else {
    return key.toString();
  }
  const version = url.searchParams.get("v");
  if (version !== null && VERSION.test(version)) set("v", version);
  return key.toString();
}

/**
 * The address a drawn card is also kept under, by what it shows: two
 * addresses for the same card (an old `v`, a made-up one) share one
 * drawing rather than each being drawn.
 */
export async function drawnKey(origin: string, card: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(card)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = new URL("/drawn", origin);
  key.searchParams.set("render", RENDER_VERSION);
  key.searchParams.set("card", hex);
  return key.toString();
}
