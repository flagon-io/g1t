/**
 * Names in URLs: a space's slug, and a page's `<title-slug>-<id>`, which
 * keeps working when the page is renamed (only the id is read). Pure.
 */

/** Words, lowercased, joined by hyphens, at most `max` characters. */
export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

/** A page's last URL segment. */
export function pageSlug(title: string, id: string): string {
  const words = slugify(title, 50);
  return words ? `${words}-${id}` : id;
}

const PAGE_ID = /(pag_[0-9a-hjkmnp-tv-z]{26})$/;

/** The page id at the end of a page's URL segment, or null. */
export function pageIdFrom(segment: string): string | null {
  return PAGE_ID.exec(String(segment ?? ""))?.[1] ?? null;
}

/** Every page id a Markdown text links to, for backlinks. */
export function linkedPageIds(markdown: string): string[] {
  return [...new Set(markdown.match(/pag_[0-9a-hjkmnp-tv-z]{26}/g) ?? [])];
}

/** Space slugs the site's routes use under `-/docs/`. */
export const RESERVED_SPACE_SLUGS = new Set(["new", "search", "trash", "templates", "live", "api", "threads", "upload", "export", "settings", "recent", "favorites", "stale", "repo"]);

/** A space slug that is free: `base`, else `base-2`, `base-3`, ... */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base, 40) || "space";
  const ok = (s: string) => !taken.has(s) && !RESERVED_SPACE_SLUGS.has(s);
  if (ok(root)) return root;
  for (let n = 2; ; n++) if (ok(`${root}-${n}`)) return `${root}-${n}`;
}

/** A space slug someone typed: valid as given, or null. */
export function validSpaceSlug(slug: string): string | null {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s)) return null;
  if (RESERVED_SPACE_SLUGS.has(s)) return null;
  return s;
}
