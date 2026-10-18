// @ts-check
/**
 * Pages that moved, and parts of pages that moved on their own.
 *
 * astro.config.mjs lists them as `'/old/': '/new/'`, and a part of a page
 * as `'/old/#heading': '/new/#heading'`. Astro's redirects take the pages.
 * A redirect never sees a link's #fragment, so the parts are this
 * integration's: once the site is built, it puts a short script at the top
 * of each old address's page (the redirect, or the page itself when it is
 * still there) that sends a link to a moved part on to where it went. On a
 * redirect, a link to any other part keeps its #fragment, since the parts
 * of a moved page keep their names.
 */
import { readFile, writeFile } from "node:fs/promises";
// readFile throws for an old address with no page, so a moved part never
// names a page the build does not make.
import { fileURLToPath } from "node:url";

/** @param {Record<string, string>} moved */
export function pages(moved) {
  return Object.fromEntries(Object.entries(moved).filter(([from]) => !from.includes("#")));
}

/** @param {Record<string, string>} moved @returns {import('astro').AstroIntegration} */
export function movedParts(moved) {
  return {
    name: "g1t-moved-parts",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        /** @type {Map<string, Record<string, string>>} */
        const parts = new Map();
        for (const [from, to] of Object.entries(moved)) {
          const [page, part] = from.split("#");
          if (!part) continue;
          parts.set(page, { ...parts.get(page), [part]: to });
        }
        for (const [page, map] of parts) {
          const file = fileURLToPath(new URL(`.${page}index.html`, dir));
          const html = await readFile(file, "utf8");
          const whole = moved[page] ?? "";
          const script =
            `<script>(function(){var p=${JSON.stringify(map)},w=${JSON.stringify(whole)},h=location.hash,` +
            `t=p[decodeURIComponent(h.slice(1))]||(w&&w+h);if(t)location.replace(t)})()</script>`;
          // First in the page, before a redirect's own refresh. Astro's
          // redirect pages have no <head> tag, Starlight's pages do.
          const at = /<head[^>]*>/i.exec(html) ?? /<!doctype html>/i.exec(html);
          const end = at ? at.index + at[0].length : 0;
          await writeFile(file, html.slice(0, end) + script + html.slice(end));
        }
        logger.info(`${parts.size} pages send links to their moved parts on`);
      },
    },
  };
}
