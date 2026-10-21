/**
 * How the site's keyboard shortcuts are written on this computer. Search
 * (the palette) is `/`, as on GitHub; the keyboard's shortcuts are the
 * Command key and K on a Mac, an iPhone or an iPad, and Ctrl K everywhere
 * else.
 */
export function modKeyLabel(platform: string | null | undefined, key: string): string {
  return isApple(platform) ? `⌘${key}` : `Ctrl ${key}`;
}

function isApple(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

/** Search's key: `/`, outside a text field, on every computer. */
export const PALETTE_KEY = "/";

/** The keyboard's shortcuts' key: ⌘K or Ctrl K. */
export function shortcutsKeyLabel(platform: string | null | undefined): string {
  return modKeyLabel(platform, "K");
}

/**
 * New chat's key in Chat, as claude.ai and chatgpt.com have it: Shift and
 * Command O on a Mac (⇧⌘O), Ctrl Shift O everywhere else. It works in a
 * text field too, since nothing types it.
 */
export function newChatKeyLabel(platform: string | null | undefined): string {
  return isApple(platform) ? "⇧⌘O" : "Ctrl Shift O";
}

/** Whether a key press is New chat's: Ctrl (or Command), Shift and O, without Alt. */
export function isNewChatKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o";
}
