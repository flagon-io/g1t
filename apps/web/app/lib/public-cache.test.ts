import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeSharedPage, encodeSharedPage, repositoryOfPage, sharedPageKey, stillPublic } from "./public-cache.ts";

test("a page kept in the shared cache comes back as it was, without its timings", () => {
  const body = new TextEncoder().encode("<!doctype html>\n<p>hello</p>\n");
  const page = {
    status: 404,
    headers: [
      ["content-type", "text/html; charset=utf-8"],
      ["Server-Timing", 'total;dur=900;desc="web to first byte"'],
    ] as [string, string][],
    keptAt: 1_761_000_000_000,
    body,
  };
  const back = decodeSharedPage(encodeSharedPage(page));
  assert.deepEqual(back, { ...page, headers: [["content-type", "text/html; charset=utf-8"]] });
  assert.equal(decodeSharedPage(new TextEncoder().encode("no line")), null);
  assert.equal(decodeSharedPage(new TextEncoder().encode('{"status":"x"}\nbody')), null);
  assert.equal(decodeSharedPage(new TextEncoder().encode("{not json\nbody")), null);
});

test("a shared key fits Workers KV and follows the colo key", async () => {
  const key = await sharedPageKey("https://g1t.sh/flagon-io/g1t?_g1t_build=abc&_g1t_representation=html");
  assert.match(key, /^page:[0-9a-f]{64}$/);
  assert.notEqual(key, await sharedPageKey("https://g1t.sh/flagon-io/g1t?_g1t_build=abd&_g1t_representation=html"));
});

test("a project page names its repository", () => {
  assert.equal(repositoryOfPage("/flagon-io/hello"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/flagon-io/hello.data"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/Flagon-IO/Hello/issues/4"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/flagon-io/hello/blob/main/src/lib.rs"), "flagon-io/hello");
});

test("pages that are not a repository's name none", () => {
  assert.equal(repositoryOfPage("/"), null);
  assert.equal(repositoryOfPage("/pricing"), null);
  assert.equal(repositoryOfPage("/flagon-io"), null);
  assert.equal(repositoryOfPage("/flagon-io/-"), null);
});

test("only a repository that is there and public is served from the cache", () => {
  assert.equal(stillPublic([{ path: "a/b", is_private: false }], "a/b"), true);
  assert.equal(stillPublic([{ path: "a/b", is_private: true }], "a/b"), false);
  // Deleted or never there: repos leaves it out.
  assert.equal(stillPublic([], "a/b"), false);
  assert.equal(stillPublic(null, "a/b"), false);
  assert.equal(stillPublic([{ path: "a/c", is_private: false }], "a/b"), false);
});
