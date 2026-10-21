/**
 * How the site's keyboard shortcuts are written on this computer. Search
 * (the palette) is `/`, as on GitHub; the keyboard's shortcuts are the
 * Command key and K on a Mac, an iPhone or an iPad, and Ctrl K everywhere
 * else.
 */
export function modKeyLabel(platform: string | null | undefined, key: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "") ? `⌘${key}` : `Ctrl ${key}`;
}

/** Search's key: `/`, outside a text field, on every computer. */
export const PALETTE_KEY = "/";

/** The keyboard's shortcuts' key: ⌘K or Ctrl K. */
export function shortcutsKeyLabel(platform: string | null | undefined): string {
  return modKeyLabel(platform, "K");
}
