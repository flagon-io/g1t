import assert from "node:assert/strict";
import { test } from "node:test";

import {
  confirmsName,
  daysUntil,
  filterCounts,
  filterRepos,
  longDate,
  parseFilter,
  renamedBranchPath,
  summariseBulk,
  tidyName,
} from "./repo-lifecycle.ts";

test("the typed name confirms only the full name, in any case", () => {
  assert.equal(confirmsName("acme/web", "acme/web"), true);
  assert.equal(confirmsName("  ACME/Web ", "acme/web"), true);
  assert.equal(confirmsName("web", "acme/web"), false);
  assert.equal(confirmsName("", "acme/web"), false);
  assert.equal(confirmsName(null, "acme/web"), false);
});

const repos = [
  { name: "web", description: "The site", topics: ["astro"], isPrivate: false, archivedAt: null },
  { name: "api", description: "Rust service", topics: ["rust", "cli"], isPrivate: true, archivedAt: null },
  { name: "old-site", description: null, topics: [], isPrivate: false, archivedAt: "2026-01-01T00:00:00Z" },
];

test("filters by visibility and archived", () => {
  assert.deepEqual(filterRepos(repos, "all", "").map((r) => r.name), ["web", "api", "old-site"]);
  assert.deepEqual(filterRepos(repos, "public", "").map((r) => r.name), ["web", "old-site"]);
  assert.deepEqual(filterRepos(repos, "private", "").map((r) => r.name), ["api"]);
  assert.deepEqual(filterRepos(repos, "archived", "").map((r) => r.name), ["old-site"]);
});

test("search matches every word in name, description or topics", () => {
  assert.deepEqual(filterRepos(repos, "all", "rust").map((r) => r.name), ["api"]);
  assert.deepEqual(filterRepos(repos, "all", "SITE").map((r) => r.name), ["web", "old-site"]);
  assert.deepEqual(filterRepos(repos, "all", "site astro").map((r) => r.name), ["web"]);
  assert.deepEqual(filterRepos(repos, "private", "site").map((r) => r.name), []);
});

test("counts each filter", () => {
  assert.deepEqual(filterCounts(repos), { all: 3, public: 2, private: 1, archived: 1 });
});

test("an unknown filter is all", () => {
  assert.equal(parseFilter("archived"), "archived");
  assert.equal(parseFilter("nope"), "all");
  assert.equal(parseFilter(null), "all");
});

test("a bulk action is summed up, with each failure and why", () => {
  assert.deepEqual(
    summariseBulk(
      [
        { name: "web", ok: true },
        { name: "api", ok: false, error: "Only owners can archive a repository." },
        { name: "cli", ok: true },
      ],
      "archived",
    ),
    {
      message: "2 repositories archived. 1 repository could not be.",
      failures: ["api: Only owners can archive a repository."],
    },
  );
  assert.equal(summariseBulk([{ name: "web", ok: true }], "unarchived").message, "1 repository unarchived.");
  assert.equal(summariseBulk([], "archived").message, "Nothing was selected.");
});

test("a renamed branch keeps the rest of the address", () => {
  assert.equal(renamedBranchPath("/acme/web/tree/master/src/lib", "?x=1", "main"), "/acme/web/tree/main/src/lib?x=1");
  assert.equal(renamedBranchPath("/acme/web/blob/old/README.md", "", "feature/new"), "/acme/web/blob/feature%2Fnew/README.md");
  assert.equal(renamedBranchPath("/acme/web/tree/master", "", "main"), "/acme/web/tree/main");
  assert.equal(renamedBranchPath("/acme/web/commits", "", "main"), null);
});

test("days until a date, never negative", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.equal(daysUntil("2026-11-04T12:00:00Z", now), 30);
  assert.equal(daysUntil("2026-10-05T13:00:00Z", now), 1);
  assert.equal(daysUntil("2026-10-01T00:00:00Z", now), 0);
  assert.equal(daysUntil("not a date", now), 0);
});

test("dates read the same everywhere", () => {
  assert.equal(longDate("2026-11-04T23:30:00Z"), "4 November 2026");
  assert.equal(longDate("nope"), "nope");
});

test("names are tidied, not judged", () => {
  assert.equal(tidyName("  my new site "), "my-new-site");
});
