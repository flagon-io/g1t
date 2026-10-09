/**
 * /sitemap.xml: the public pages, then the public projects Explore lists,
 * newest first. Explore being unreachable leaves just the pages.
 */
import type { Route } from "./+types/sitemap-xml";
import { search } from "../lib/services.server";

/** Pages anyone can read, signed in or not. */
const PAGES = ["/", "/pricing", "/explore", "/support", "/security", "/policies", "/policies/privacy"];

/** How many of Explore's pages to list; each holds one page of projects. */
const EXPLORE_PAGES = 10;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function loader({ request }: Route.LoaderArgs) {
  const site = new URL(request.url).origin;
  const entries: { loc: string; lastmod?: string }[] = PAGES.map((path) => ({ loc: `${site}${path}` }));
  for (let pageNumber = 1; pageNumber <= EXPLORE_PAGES; pageNumber++) {
    const explore = await search.explore(null, { sort: "new", page: pageNumber }).catch(() => null);
    if (!explore) break;
    for (const repo of explore.repos) {
      const lastmod = (repo.pushedAt ?? repo.createdAt)?.slice(0, 10);
      entries.push({ loc: `${site}/${repo.namespace}/${repo.name}`, lastmod });
    }
    if (!explore.more) break;
  }
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(
      (entry) => `  <url><loc>${escape(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ""}</url>`,
    ),
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
