import assert from "node:assert/strict";
import { test } from "node:test";

import { robotsTxt } from "./robots.ts";

test("everything may be crawled but a file's blame", () => {
  const text = robotsTxt("https://g1t.example");
  assert.match(text, /^User-agent: \*\nAllow: \/\n/);
  assert.match(text, /^Disallow: \/\*\?blame=$/m);
  assert.match(text, /^Disallow: \/\*&blame=$/m);
  assert.match(text, /^Disallow: \/\*\/\*\/blame\/$/m);
  assert.match(text, /^Sitemap: https:\/\/g1t\.example\/sitemap\.xml$/m);
  assert.doesNotMatch(text, /docs\.g1t\.sh/, "a self-hosted g1t has no docs site");
  assert.ok(text.endsWith("\n"));
});

test("g1t.sh names its docs' map too", () => {
  assert.match(robotsTxt("https://g1t.sh"), /^Sitemap: https:\/\/docs\.g1t\.sh\/sitemap-index\.xml$/m);
});
