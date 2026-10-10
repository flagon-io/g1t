import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyCitations, citationHref, citationMarkdown, citationsFromMarkdown, cleanCitation, cleanDescribes, cleanPath, touchedPaths, touches } from "./citations.ts";

test("paths are kept tidy, and unsafe ones refused", () => {
  assert.equal(cleanPath("/src//export.ts/"), "src/export.ts");
  assert.equal(cleanPath("./docs/a.md"), "docs/a.md");
  assert.equal(cleanPath("src/../secrets"), null);
  assert.equal(cleanPath(""), null);
});

test("a citation names a repository and a path; a label only for what it names", () => {
  assert.deepEqual(cleanCitation({ repo: "Acme/Web", path: "src/export.ts", kind: "symbol", label: " exportCsv ", ref: "ABCDEF1" }, "body"), {
    repo: "acme/web",
    path: "src/export.ts",
    kind: "symbol",
    label: "exportCsv",
    ref: "abcdef1",
    source: "body",
  });
  assert.equal(cleanCitation({ repo: "acme/web", path: "src/a.ts", kind: "path", label: "ignored" }, "body")?.label, null);
  assert.equal(cleanCitation({ repo: "nope", path: "src/a.ts" }, "body"), null);
  assert.equal(cleanCitation({ repo: "acme/web", path: "src/a.ts", kind: "weird" as never }, "body")?.kind, "path");
});

test("a change touches a cited file, anything under a cited folder, and what a glob matches", () => {
  assert.ok(touches("src/export.ts", "src/export.ts"));
  assert.ok(!touches("src/export.ts", "src/export.tsx"));
  assert.ok(touches("src/export", "src/export/csv.ts"));
  assert.ok(!touches("src/export", "src/exports/csv.ts"));
  assert.ok(touches("src/*.ts", "src/a.ts"));
  assert.ok(!touches("src/*.ts", "src/deep/a.ts"));
  assert.ok(touches("src/**/*.sql", "src/a.sql"));
  assert.ok(touches("src/**/*.sql", "src/db/migrations/0001.sql"));
  assert.ok(touches("api/**", "api/v1/routes.rs"));
  assert.ok(touches("docs/?.md", "docs/a.md"));
  assert.ok(!touches("docs/?.md", "docs/ab.md"));
  assert.ok(!touches("a.b/*.ts", "aXb/x.ts"));
  assert.deepEqual(touchedPaths([{ path: "src/export" }, { path: "*.toml" }], ["README.md", "src/export/csv.ts", "Cargo.toml"]), ["src/export/csv.ts", "Cargo.toml"]);
});

test("a citation links to the code at the commit it was cited at", () => {
  assert.equal(citationHref({ repo: "acme/web", path: "src/export.ts", ref: "abc1234" }), "/acme/web/blob/abc1234/src/export.ts");
  assert.equal(citationHref({ repo: "acme/web", path: "src/export", ref: null }), "/acme/web/tree/HEAD/src/export");
  assert.equal(citationHref({ repo: "acme/web", path: "src/**/*.sql", ref: null }), "/acme/web/tree/HEAD/src");
  assert.equal(citationMarkdown({ repo: "acme/web", path: "src/export.ts", ref: "abc1234", kind: "env", label: "EXPORT_BUCKET" }), "[`EXPORT_BUCKET`](/acme/web/blob/abc1234/src/export.ts)");
});

test("links to code in a page are citations too, a chip's own link once", () => {
  const md = "See [`exportCsv`](/acme/web/blob/abc1234/src/export.ts) and [the folder](/acme/web/tree/main/src/jobs) and [elsewhere](https://example.com/a/b/blob/x/y.ts) and [on g1t](https://g1t.sh/acme/api/blob/main/src/lib.rs#L10).";
  assert.deepEqual(
    citationsFromMarkdown(md).map((c) => [c.repo, c.path, c.ref]),
    [
      ["acme/web", "src/export.ts", "abc1234"],
      ["acme/web", "src/jobs", "main"],
      ["acme/api", "src/lib.rs", "main"],
    ],
  );
  const chips = [{ repo: "acme/web", path: "src/export.ts", kind: "symbol" as const, label: "exportCsv", ref: "abc1234" }];
  const all = bodyCitations(chips, md);
  assert.deepEqual(
    all.map((c) => [c.path, c.kind]),
    [
      ["src/export.ts", "symbol"],
      ["src/jobs", "path"],
      ["src/lib.rs", "path"],
    ],
  );
});

test("the header's Describes list is tidy and short", () => {
  assert.deepEqual(cleanDescribes([{ repo: "Acme/Web", path: "/src/export/" }, { repo: "acme/web", path: "src/export" }, { repo: "x", path: "y" }, "nope"]), [{ repo: "acme/web", path: "src/export" }]);
  assert.equal(cleanDescribes(Array.from({ length: 40 }, (_, i) => ({ repo: "acme/web", path: `f${i}` }))).length, 20);
});
