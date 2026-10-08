/**
 * How the palette's shortcut is written on this computer: the Command key
 * on a Mac, an iPhone or an iPad, Ctrl everywhere else.
 */
export function paletteKeyLabel(platform: string | null | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "") ? "⌘K" : "Ctrl K";
}
