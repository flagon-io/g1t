import assert from "node:assert/strict";
import { test } from "node:test";

import { robotsTxt } from "./robots.ts";

test("everything may be crawled but blame, raw files, archives, comparisons, search and reference cards", () => {
  const text = robotsTxt("https://g1t.example");
  assert.match(text, /^User-agent: \*\nAllow: \/\n/);
  assert.match(text, /^Disallow: \/\*\?blame=$/m);
  assert.match(text, /^Disallow: \/\*&blame=$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/blame\/$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/ref\/$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/raw\/$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/archive\/$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/compare\$$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/compare\/$/m);
  assert.match(text, /^Disallow: \/search\$$/m);
  assert.match(text, /^Sitemap: https:\/\/g1t\.example\/sitemap\.xml$/m);
  assert.doesNotMatch(text, /docs\.g1t\.sh/, "a self-hosted g1t has no docs site");
  assert.ok(text.endsWith("\n"));
});

test("files, trees and commits stay open, and no rule shuts a whole repository", () => {
  const rules = robotsTxt("https://g1t.example")
    .split("\n")
    .filter((line) => line.startsWith("Disallow: "));
  for (const rule of rules) assert.doesNotMatch(rule, /\/(?:blob|tree|commit)\b/, rule);
  assert.ok(!rules.includes("Disallow: /*/*/"));
});

test("crawlers are asked to wait between requests", () => {
  assert.match(robotsTxt("https://g1t.example"), /^Crawl-delay: 5$/m);
});

test("g1t.sh names its docs' map too", () => {
  assert.match(robotsTxt("https://g1t.sh"), /^Sitemap: https:\/\/docs\.g1t\.sh\/sitemap-index\.xml$/m);
});
