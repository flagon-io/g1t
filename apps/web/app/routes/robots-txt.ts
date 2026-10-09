/**
 * /robots.txt: everything may be crawled, and where the site's maps are.
 * Served from the request's own origin, so a self-hosted g1t names itself.
 */
import type { Route } from "./+types/robots-txt";

/** g1t.sh's docs keep their own map; a self-hosted g1t has no docs site. */
const DOCS_SITEMAP = "https://docs.g1t.sh/sitemap-index.xml";

export function loader({ request }: Route.LoaderArgs) {
  const site = new URL(request.url).origin;
  const lines = ["User-agent: *", "Allow: /", "", `Sitemap: ${site}/sitemap.xml`];
  if (site === "https://g1t.sh") lines.push(`Sitemap: ${DOCS_SITEMAP}`);
  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
