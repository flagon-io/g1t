/**
 * What /robots.txt says: the site, its repositories' overviews and their
 * files may be crawled, a page every few seconds; a file's blame
 * (`?blame=1`, and the `/<owner>/<repo>/blame/…` data it fetches), raw
 * files, archives, comparisons, search and the cards over references
 * (`/<owner>/<repo>/ref/…`) may not; and where the site's maps are.
 *
 * Blame is the costliest file view to work out, one per file per commit a
 * crawler finds, and adds nothing an index needs that the file itself does
 * not have: on 2026-10-14 crawlers asked for 1,150 blame pages in four
 * hours, against a handful from people. The links to it are `nofollow` too,
 * and its page is `noindex` (routes/repo/blob.tsx). Raw files and archives
 * are the file pages again without the page, and a comparison is one per
 * pair of commits. On 2026-10-20 crawlers made most of 286k requests in
 * six hours; what they are still served comes from the cache
 * (app/lib/crawlers.ts).
 */

/** g1t.sh's docs keep their own map; a self-hosted g1t has no docs site. */
const DOCS_SITEMAP = "https://docs.g1t.sh/sitemap-index.xml";

/**
 * Paths crawlers are kept from, wherever the query puts `blame`. A `*`
 * matches slashes too, so a folder named `raw` or `compare` in a
 * repository is kept from them as well; robots.txt has no way to say one
 * segment.
 */
export const DISALLOWED = [
  "/*?blame=",
  "/*&blame=",
  "/*/*/blame/",
  "/*/*/ref/",
  "/*/*/raw/",
  "/*/*/archive/",
  "/*/*/compare$",
  "/*/*/compare/",
  "/search$",
  "/search?",
];

/** Seconds between a crawler's requests, for the crawlers that read it. */
export const CRAWL_DELAY_SECONDS = 5;

export function robotsTxt(site: string): string {
  const lines = [
    "User-agent: *",
    "Allow: /",
    ...DISALLOWED.map((path) => `Disallow: ${path}`),
    `Crawl-delay: ${CRAWL_DELAY_SECONDS}`,
    "",
    `Sitemap: ${site}/sitemap.xml`,
  ];
  if (site === "https://g1t.sh") lines.push(`Sitemap: ${DOCS_SITEMAP}`);
  return `${lines.join("\n")}\n`;
}
