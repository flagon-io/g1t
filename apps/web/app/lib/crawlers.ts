/**
 * Crawlers at the front door (workers/app.ts). They are served public pages
 * from this data centre's cache, kept for hours and keyed by the address
 * alone; never with a cookie or token; and the pages that cost the most to
 * draw count against a limit per crawler (CRAWLER_LIMIT) only when they are
 * not in the cache.
 *
 * On 2026-10-20, of about 286k requests in six hours, crawlers made more
 * than 220k: ClaudeBot 147k, GPTBot 34k, Amazonbot 5.6k, and Meta's,
 * Google's, DuckDuckGo's and Exa's. They walked the tree, blob, commit and
 * raw pages of public repositories, each a handful of service calls, and
 * when their volume doubled every shared service got 2–3× slower for the
 * people signed in.
 *
 * A crawler is known by its user agent (`FAMILIES`, kept short) or by
 * Cloudflare's verified bot fields when the zone has them. Link previews
 * (Slack, Discord and the like) are not crawlers: a person shared the link
 * and expects today's title.
 */

/** Crawlers by user agent, the family each counts as. The first that matches wins. */
export const FAMILIES: ReadonlyArray<readonly [family: string, agent: RegExp]> = [
  ["anthropic", /ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai/i],
  ["openai", /GPTBot|OAI-SearchBot|ChatGPT-User/i],
  ["amazon", /Amazonbot/i],
  ["meta", /meta-externalagent|meta-externalfetcher/i],
  ["google", /Googlebot|Google-Extended|GoogleOther|Storebot-Google|AdsBot-Google/i],
  ["bing", /bingbot|msnbot/i],
  ["duckduckgo", /DuckDuckBot|DuckAssistBot/i],
  ["exa", /ExaBot|ExaSearchBot/i],
  ["perplexity", /PerplexityBot|Perplexity-User/i],
  ["bytedance", /Bytespider|TikTokSpider/i],
  ["commoncrawl", /CCBot/i],
  ["apple", /Applebot/i],
  ["yandex", /YandexBot|YandexImages/i],
  ["baidu", /Baiduspider/i],
  ["seo", /AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|BLEXBot|serpstatbot/i],
  ["cohere", /cohere-ai|cohere-training/i],
  ["diffbot", /Diffbot/i],
  // A browser driven by a program says so, unless it hides it.
  ["headless", /HeadlessChrome|PhantomJS/i],
];

/** Fetchers of one link a person shared, for its preview. */
const PREVIEWS = /Slackbot|Discordbot|Twitterbot|LinkedInBot|TelegramBot|WhatsApp|facebookexternalhit|Mastodon|Bluesky|Iframely|Embedly|redditbot/i;

/** Any other agent that says it is a bot: `name-bot/1.0`, or `(compatible; …; +https://…)`. */
const SAYS_BOT = /(?:bot|crawler|spider)\/|\(compatible;[^)]*\+https?:\/\//i;

/** Cloudflare's verified bot categories that fetch for a person or a service, not to crawl. */
const NOT_CRAWLING = new Set(["page preview", "webhooks", "monitoring & analytics", "accessibility"]);

type BotFields = { verifiedBot?: boolean; verifiedBotCategory?: string; botManagement?: { verifiedBot?: boolean } };

/** The crawler family a request comes from, or null for anyone else. */
export function crawlerOf(request: Request): string | null {
  const agent = request.headers.get("user-agent") ?? "";
  if (PREVIEWS.test(agent)) return null;
  for (const [family, pattern] of FAMILIES) if (pattern.test(agent)) return family;
  const cf = (request as Request & { cf?: BotFields }).cf;
  const category = cf?.verifiedBotCategory?.trim().toLowerCase() ?? "";
  if (category && NOT_CRAWLING.has(category)) return null;
  if (cf?.botManagement?.verifiedBot || cf?.verifiedBot || category) return category ? `verified:${category.replace(/[^a-z]+/g, "-")}` : "verified";
  return SAYS_BOT.test(agent) ? "other" : null;
}

/**
 * Pages that cost the most to draw, one per file, commit or pair of
 * commits: a repository's tree, files, commits, raw files, archives,
 * blame and comparisons, and search. A crawler drawing them counts against
 * CRAWLER_LIMIT.
 */
const COSTLY = /^\/(?:search(?:\.data)?$|[^/]+\/[^/]+\/(?:tree|blob|commit|commits|raw|archive|blame|compare)(?:[/.]|$))/;

export function costlyForCrawlers(url: URL): boolean {
  return COSTLY.test(url.pathname) || /(?:^|&)blame=/.test(url.search.slice(1));
}

/**
 * Pages kept for crawlers beyond the signed-out page cache's (workers/app.ts):
 * a repository's raw files, blame and comparisons. Each names its
 * repository, so a kept one is served only while it is public.
 */
const ALSO_KEPT = /^\/[^/]+\/(?!-\/|-$)[^/]+\/(?:raw\/.+|blame\/.+|compare(?:\/.+|\.data)?)$/;

export function alsoKeptForCrawlers(pathname: string): boolean {
  return ALSO_KEPT.test(pathname);
}

/** How long a page is kept for crawlers: six hours, a day for a page of one commit. */
export const CRAWLER_KEEP_SECONDS = 6 * 3600;
export const CRAWLER_KEEP_COMMIT_SECONDS = 24 * 3600;

/** How long a page of this address is kept: a full commit hash names what never changes. */
export function crawlerKeepSeconds(url: URL): number {
  return /^\/[^/]+\/[^/]+\/(?:tree|blob|commit|raw|blame)\/[0-9a-f]{40}(?:[/.]|$)/.test(url.pathname) ? CRAWLER_KEEP_COMMIT_SECONDS : CRAWLER_KEEP_SECONDS;
}

/** Query parameters that only say where a link came from. */
const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i;

/**
 * The cache key of a page kept for crawlers: the address, without its
 * fragment or tracking parameters and with the rest in order, and the
 * representation asked for (HTML or Markdown, app/lib/agent-pages.ts).
 * Nothing about the visitor, and not the build: a kept page from an older
 * build still names its scripts, which the site keeps (app/lib/asset-archive.ts).
 */
export function crawlerCacheKey(url: URL, representation: string): Request {
  const key = new URL(url.origin + url.pathname);
  const kept = [...url.searchParams].filter(([name]) => !TRACKING.test(name) && !name.startsWith("_g1t_"));
  kept.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  for (const [name, value] of kept) key.searchParams.append(name, value);
  key.searchParams.set("_g1t_crawler", representation);
  return new Request(key, { method: "GET" });
}

/** The crawler's request without anything that signs it in: it sees what anyone signed out sees. */
export function signedOut(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  return new Request(request, { headers });
}

/**
 * Whether a crawler's answer may be kept: nothing that sets a cookie; a
 * page or a not-found that does not say it is private; or a redirect, which
 * for a request without a session is the same for everyone (a public raw
 * file's address on the usercontent origin, routes/repo/raw.ts).
 */
export function keptForCrawlers(response: Response): boolean {
  if (response.headers.has("set-cookie")) return false;
  if ([301, 302, 307, 308].includes(response.status)) return response.headers.has("location");
  return (response.status === 200 || response.status === 404) && !/private|no-store/.test(response.headers.get("cache-control") ?? "");
}
