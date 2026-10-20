import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CRAWLER_KEEP_COMMIT_SECONDS,
  CRAWLER_KEEP_SECONDS,
  alsoKeptForCrawlers,
  costlyForCrawlers,
  crawlerCacheKey,
  crawlerKeepSeconds,
  crawlerOf,
  keptForCrawlers,
  signedOut,
} from "./crawlers.ts";

function from(agent: string, cf?: object): Request {
  const request = new Request("https://g1t.sh/flagon-io/g1t", { headers: { "user-agent": agent } });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

test("the crawlers seen on g1t.sh are known by family", () => {
  const seen: Array<[string, string]> = [
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "anthropic"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", "openai"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Amazonbot/0.1", "amazon"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "meta"],
    ["Googlebot-Image/1.0", "google"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "google"],
    ["DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)", "duckduckgo"],
    ["Mozilla/5.0 (compatible; ExaSearchBot/1.0)", "exa"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36", "headless"],
    ["Mozilla/5.0 (compatible; SomeNewBot/0.3; +https://example.com/bot)", "other"],
  ];
  for (const [agent, family] of seen) assert.equal(crawlerOf(from(agent)), family, agent);
});

test("people, link previews and a phone named like a bot are not crawlers", () => {
  assert.equal(crawlerOf(from(BROWSER)), null);
  assert.equal(crawlerOf(from("")), null);
  assert.equal(crawlerOf(from("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")), null);
  assert.equal(crawlerOf(from("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")), null);
  assert.equal(crawlerOf(from("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")), null);
  assert.equal(crawlerOf(from("Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36")), null);
  assert.equal(crawlerOf(from("git/2.45.0")), null);
});

test("Cloudflare's verified bots are crawlers, unless they fetch for a person", () => {
  assert.equal(crawlerOf(from(BROWSER, { verifiedBotCategory: "Search Engine Crawler" })), "verified:search-engine-crawler");
  assert.equal(crawlerOf(from(BROWSER, { botManagement: { verifiedBot: true } })), "verified");
  assert.equal(crawlerOf(from(BROWSER, { verifiedBotCategory: "Page Preview" })), null);
  assert.equal(crawlerOf(from(BROWSER, { verifiedBotCategory: "" })), null);
  assert.equal(crawlerOf(from("ClaudeBot/1.0", { verifiedBotCategory: "AI Crawler" })), "anthropic", "the agent names the family first");
});

test("what is costly for a crawler: trees, files, commits, raw, archives, blame, comparisons, search", () => {
  for (const path of [
    "/flagon-io/g1t/tree/main/apps",
    "/flagon-io/g1t/tree/main/apps.data",
    "/flagon-io/g1t/blob/main/README.md",
    "/flagon-io/g1t/commit/0a906a41",
    "/flagon-io/g1t/commits",
    "/flagon-io/g1t/commits.data",
    "/flagon-io/g1t/raw/main/README.md",
    "/flagon-io/g1t/archive/main.zip",
    "/flagon-io/g1t/blame/main/README.md",
    "/flagon-io/g1t/compare/main...dev",
    "/search",
  ]) {
    assert.ok(costlyForCrawlers(new URL(`https://g1t.sh${path}`)), path);
  }
  assert.ok(costlyForCrawlers(new URL("https://g1t.sh/flagon-io/g1t/blob/main/README.md?plain=1&blame=1")));
  for (const path of ["/", "/explore", "/flagon-io/g1t", "/flagon-io/g1t.data", "/flagon-io/g1t/pulls", "/flagon-io/treehouse", "/flagon-io/g1t/releases"]) {
    assert.ok(!costlyForCrawlers(new URL(`https://g1t.sh${path}`)), path);
  }
});

test("raw files, blame and comparisons are kept too, and a workspace's own pages are not", () => {
  assert.ok(alsoKeptForCrawlers("/flagon-io/g1t/raw/main/README.md"));
  assert.ok(alsoKeptForCrawlers("/flagon-io/g1t/blame/main/README.md"));
  assert.ok(alsoKeptForCrawlers("/flagon-io/g1t/compare"));
  assert.ok(alsoKeptForCrawlers("/flagon-io/g1t/compare/main...dev"));
  assert.ok(!alsoKeptForCrawlers("/flagon-io/-/work/212"));
  assert.ok(!alsoKeptForCrawlers("/flagon-io/g1t/archive/main.zip"), "an archive is too big to keep");
});

test("a page of one commit is kept a day, anything else six hours", () => {
  const sha = "0a906a41c023e165680352b59fb84862944224b6";
  assert.equal(crawlerKeepSeconds(new URL(`https://g1t.sh/flagon-io/g1t/blob/${sha}/README.md`)), CRAWLER_KEEP_COMMIT_SECONDS);
  assert.equal(crawlerKeepSeconds(new URL(`https://g1t.sh/flagon-io/g1t/commit/${sha}`)), CRAWLER_KEEP_COMMIT_SECONDS);
  assert.equal(crawlerKeepSeconds(new URL("https://g1t.sh/flagon-io/g1t/blob/main/README.md")), CRAWLER_KEEP_SECONDS);
  assert.equal(crawlerKeepSeconds(new URL("https://g1t.sh/flagon-io/g1t/commit/0a906a41")), CRAWLER_KEEP_SECONDS);
});

test("the cache key is the address alone, in order, without tracking or fragment", () => {
  const key = (url: string, representation = "html") => crawlerCacheKey(new URL(url), representation).url;
  assert.equal(
    key("https://g1t.sh/flagon-io/g1t/blob/main/a.ts?plain=1&utm_source=x#L4"),
    "https://g1t.sh/flagon-io/g1t/blob/main/a.ts?plain=1&_g1t_crawler=html",
  );
  assert.equal(key("https://g1t.sh/x/y?b=2&a=1"), key("https://g1t.sh/x/y?a=1&b=2"));
  assert.equal(key("https://g1t.sh/x/y?_g1t_build=old"), "https://g1t.sh/x/y?_g1t_crawler=html");
  assert.notEqual(key("https://g1t.sh/x/y", "markdown"), key("https://g1t.sh/x/y"));
  assert.equal(crawlerCacheKey(new URL("https://g1t.sh/x/y"), "html").method, "GET");
});

test("a crawler's request carries no cookie or token", () => {
  const request = new Request("https://g1t.sh/x/y", {
    headers: { cookie: "g1t_session=abc", authorization: "Bearer t", "user-agent": "GPTBot/1.2", accept: "text/html" },
  });
  const anonymous = signedOut(request);
  assert.equal(anonymous.headers.get("cookie"), null);
  assert.equal(anonymous.headers.get("authorization"), null);
  assert.equal(anonymous.headers.get("user-agent"), "GPTBot/1.2");
  assert.equal(anonymous.headers.get("accept"), "text/html");
});

test("only an answer the same for everyone is kept", () => {
  assert.ok(keptForCrawlers(new Response("page")));
  assert.ok(keptForCrawlers(new Response("gone", { status: 404 })));
  assert.ok(
    keptForCrawlers(new Response(null, { status: 302, headers: { location: "https://g1tusercontent.com/x", "cache-control": "private, max-age=60" } })),
  );
  assert.ok(!keptForCrawlers(new Response("page", { headers: { "set-cookie": "a=b" } })));
  assert.ok(!keptForCrawlers(new Response("page", { headers: { "cache-control": "private" } })));
  assert.ok(!keptForCrawlers(new Response("page", { headers: { "cache-control": "no-store" } })));
  assert.ok(!keptForCrawlers(new Response("busy", { status: 503 })));
  assert.ok(!keptForCrawlers(new Response("slow down", { status: 429 })));
});
