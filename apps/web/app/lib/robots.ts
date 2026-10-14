/**
 * What /robots.txt says: everything may be crawled but a file's blame
 * (`?blame=1`), and where the site's maps are.
 *
 * Blame is the costliest file view to work out, one per file per commit a
 * crawler finds, and adds nothing an index needs that the file itself does
 * not have: on 2026-10-14 crawlers asked for 1,150 blame pages in four
 * hours, against a handful from people. The links to it are `nofollow` too,
 * and its page is `noindex` (routes/repo/blob.tsx).
 */

/** g1t.sh's docs keep their own map; a self-hosted g1t has no docs site. */
const DOCS_SITEMAP = "https://docs.g1t.sh/sitemap-index.xml";

/** Paths crawlers are kept from, wherever the query puts `blame`. */
export const DISALLOWED = ["/*?blame=", "/*&blame="];

export function robotsTxt(site: string): string {
  const lines = ["User-agent: *", "Allow: /", ...DISALLOWED.map((path) => `Disallow: ${path}`), "", `Sitemap: ${site}/sitemap.xml`];
  if (site === "https://g1t.sh") lines.push(`Sitemap: ${DOCS_SITEMAP}`);
  return `${lines.join("\n")}\n`;
}
