import assert from "node:assert/strict";
import { test } from "node:test";

import { redirectLocation, redirectScript } from "./redirect.ts";

/** The generated Worker, loaded as the dispatch namespace would run it. */
async function load(source: string): Promise<{ fetch(request: Request): Response | Promise<Response> }> {
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return module.default;
}

test("the location keeps the path and query, on the new host", () => {
  assert.equal(redirectLocation("https://web-acme.g1t.page/", "web-zenith.g1t.page"), "https://web-zenith.g1t.page/");
  assert.equal(
    redirectLocation("https://web-git-fix-acme.g1t.page/docs/a%20b?x=1&y=2#top", "web-git-fix-zenith.g1t.page"),
    "https://web-git-fix-zenith.g1t.page/docs/a%20b?x=1&y=2",
  );
});

test("the script answers every request with a 301 to the same place", async () => {
  const worker = await load(redirectScript("web-zenith.g1t.page"));
  for (const [from, method] of [
    ["https://web-acme.g1t.page/", "GET"],
    ["https://web-acme.g1t.page/api/items?page=2", "POST"],
    ["https://web-acme.g1t.page/a/b/", "HEAD"],
  ] as const) {
    const response = await worker.fetch(new Request(from, { method }));
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), redirectLocation(from, "web-zenith.g1t.page"));
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=\d+/);
  }
});

test("the target is lowercased and must be a hostname", () => {
  assert.match(redirectScript("Web-Zenith.g1t.page"), /"web-zenith\.g1t\.page"/);
  assert.throws(() => redirectScript("evil.example/\"; alert(1); \""));
  assert.throws(() => redirectScript("no-dots"));
  assert.throws(() => redirectScript("-bad.g1t.page"));
});
