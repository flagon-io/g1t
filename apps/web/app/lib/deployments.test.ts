import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PER_PAGE,
  SOURCE_LABEL,
  STATE_WORD,
  buildError,
  choices,
  environmentLabel,
  environmentUrl,
  groupBuilds,
  hasPayload,
  isFiltered,
  isNewestStatus,
  isPageBuild,
  orderEnvironments,
  pageRange,
  parseFilter,
  productionEnvironment,
  shortSha,
  withFilter,
} from "./deployments.ts";

const GIT =
  "the commit could not be checked out: git -c failed: fatal: reference is not a tree: d2ca224ba0fea430dcc9933cda14d8aa9fa94b4b";

type Build = Parameters<typeof groupBuilds>[0][number] & { id: string };

let hour = 0;
const build = (over: Partial<Build>): Build => ({
  id: `dep_${hour}`,
  kind: "preview",
  branch: "v2",
  number: 1,
  status: "failed",
  error: GIT,
  createdAt: new Date(Date.parse("2026-10-07T12:00:00Z") - hour++ * 3_600_000).toISOString(),
  ...over,
});

test("a commit that is gone is said plainly, naming the pull request", () => {
  assert.equal(
    buildError({ kind: "preview", number: 1, error: GIT }),
    "This pull request's commit no longer exists. Push again, or close pull request #1.",
  );
  assert.match(buildError({ kind: "production", number: null, error: GIT })!, /default branch/);
  assert.equal(buildError({ kind: "preview", number: 1, error: "npm run build exited 1." }), "npm run build exited 1.");
  assert.equal(buildError({ kind: "preview", number: 1, error: null }), null);
});

test("a run of the same failure of one app is one row, counted, linking to the newest", () => {
  hour = 0;
  const builds = [build({}), build({}), build({}), build({ status: "ready", error: null }), build({})];
  const groups = groupBuilds(builds);
  assert.deepEqual(
    groups.map((g) => [g.build.id, g.count]),
    [
      ["dep_0", 3],
      ["dep_3", 1],
      ["dep_4", 1],
    ],
  );
  assert.equal(groups[0]!.firstAt, builds[2]!.createdAt);
});

test("other apps' builds in between do not break a run; a different error does", () => {
  hour = 0;
  const groups = groupBuilds([
    build({}),
    build({ kind: "production", branch: null, number: null, status: "ready", error: null }),
    build({}),
    build({ branch: "add-ci", number: 2, error: "fatal: reference is not a tree: 213e9095" }),
    build({}),
    build({ error: "npm run build exited 1." }),
    build({ error: "npm run build exited 1." }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.build.id, g.count]),
    [
      ["dep_0", 3],
      ["dep_1", 1],
      ["dep_3", 1],
      ["dep_5", 2],
    ],
  );
});

test("builds that did not fail are never folded", () => {
  hour = 0;
  const ready = groupBuilds([build({ status: "ready", error: null }), build({ status: "ready", error: null })]);
  assert.deepEqual(ready.map((g) => g.count), [1, 1]);
  assert.deepEqual(groupBuilds([]), []);
});

// --- A repository's deployments ------------------------------------------------

type Env = Parameters<typeof productionEnvironment>[0][number];
const env = (name: string, over: Partial<Env> = {}): Env => ({
  name,
  production_environment: false,
  transient_environment: false,
  updated_at: "2026-10-07T12:00:00Z",
  latest: null,
  ...over,
});
const deployed = { id: "dep_1" } as unknown as Env["latest"];

test("environments list production first, then lasting ones, then previews, newest first in each", () => {
  const ordered = orderEnvironments([
    env("preview", { transient_environment: true, updated_at: "2026-10-07T11:00:00Z" }),
    env("staging", { updated_at: "2026-10-01T00:00:00Z" }),
    env("qa", { updated_at: "2026-10-06T00:00:00Z" }),
    env("production-eu", { production_environment: true, updated_at: "2026-10-07T11:59:00Z" }),
    env("production", { production_environment: true, updated_at: "2026-10-01T00:00:00Z" }),
  ]);
  assert.deepEqual(
    ordered.map((e) => e.name),
    ["production", "production-eu", "qa", "staging", "preview"],
  );
});

test("production is the production environment that has had a deployment, named production first", () => {
  assert.equal(productionEnvironment([env("staging", { latest: deployed })]), null);
  assert.equal(productionEnvironment([env("production", { production_environment: true })]), null);
  assert.equal(
    productionEnvironment([
      env("live", { production_environment: true, latest: deployed }),
      env("production", { production_environment: true, latest: deployed }),
    ])?.name,
    "production",
  );
  assert.equal(
    productionEnvironment([env("production", { production_environment: true }), env("live", { production_environment: true, latest: deployed })])
      ?.name,
    "live",
  );
});

test("an environment is served at its own address, else its current deployment's", () => {
  const at = (environment_url: string | null, state = "success") => ({ environment_url, state }) as never;
  assert.equal(environmentUrl({ url: "https://g1t.sh", current: null, latest: null }), "https://g1t.sh");
  assert.equal(
    environmentUrl({ url: null, current: at("https://a.g1t.page"), latest: at("https://b.g1t.page", "failure") }),
    "https://a.g1t.page",
  );
  assert.equal(environmentUrl({ url: null, current: null, latest: at("https://b.g1t.page", "failure") }), null);
});

test("the list's filter is read from the address, ignoring what it cannot be", () => {
  const filter = parseFilter(new URLSearchParams("environment=production&state=failure&source=actions&creator=syntaqx&ref=main&page=3"));
  assert.deepEqual(filter, {
    environment: "production",
    state: "failure",
    source: "actions",
    creator: "syntaqx",
    ref: "main",
    page: 3,
    per_page: PER_PAGE,
  });
  const junk = parseFilter(new URLSearchParams("state=exploded&source=ftp&page=-2&per_page=1000&environment=%20"));
  assert.equal(junk.state, null);
  assert.equal(junk.source, null);
  assert.equal(junk.environment, null);
  assert.equal(junk.page, 1);
  assert.equal(junk.per_page, 100);
  assert.equal(isFiltered(junk), false);
  assert.equal(isFiltered(filter), true);
});

test("changing a filter keeps the others and starts again from the first page", () => {
  const filter = parseFilter(new URLSearchParams("environment=production&state=failure&page=2"));
  assert.equal(withFilter("/a/b/deployments", filter, "state", "success"), "/a/b/deployments?environment=production&state=success#history");
  assert.equal(withFilter("/a/b/deployments", filter, "environment", null), "/a/b/deployments?state=failure#history");
  assert.equal(withFilter("/a/b/deployments", filter, "page", 3), "/a/b/deployments?environment=production&state=failure&page=3#history");
  assert.equal(withFilter("/a/b/deployments", parseFilter(new URLSearchParams()), "page", 1), "/a/b/deployments#history");
});

test("a filter's choices are each value once, sorted, keeping the chosen one", () => {
  const list = [{ creator: "g1t", ref: "main" }, { creator: "syntaqx", ref: "main" }, null, { creator: "g1t", ref: "v2" }];
  assert.deepEqual(choices(list, "creator"), ["g1t", "syntaqx"]);
  assert.deepEqual(choices(list, "ref", "release"), ["main", "release", "v2"]);
});

test("words for states, sources, environments and pages", () => {
  assert.equal(STATE_WORD.in_progress, "Deploying");
  assert.equal(SOURCE_LABEL.g1t_page, "g1t.page");
  assert.equal(environmentLabel("production"), "Production");
  assert.equal(shortSha("d2ca224ba0fea430"), "d2ca224");
  assert.equal(isPageBuild("dpl_123"), true);
  assert.equal(isPageBuild("dep_123"), false);
  assert.equal(pageRange(2, 30, 304), "31–60 of 304");
  assert.equal(pageRange(11, 30, 304), "301–304 of 304");
  assert.equal(pageRange(1, 30, 0), "0 of 0");
  assert.equal(hasPayload({}), false);
  assert.equal(hasPayload({ region: "wnam" }), true);
  assert.equal(hasPayload(null), false);
});

test("only a deployment's newest status can still be under way", () => {
  const statuses = [
    { created_at: "2026-10-08T10:00:00.000Z" }, // Deploying, building
    { created_at: "2026-10-08T10:02:00.000Z" }, // Deployed
  ];
  assert.equal(isNewestStatus(statuses, 0), false);
  assert.equal(isNewestStatus(statuses, 1), true);
  // Listed out of order: the newest is still the latest written.
  assert.equal(isNewestStatus([...statuses].reverse(), 0), true);
  // Written in the same moment: the last listed is the newest.
  const tied = [{ created_at: "2026-10-08T10:00:00.000Z" }, { created_at: "2026-10-08T10:00:00.000Z" }];
  assert.equal(isNewestStatus(tied, 0), false);
  assert.equal(isNewestStatus(tied, 1), true);
  assert.equal(isNewestStatus([], 0), false);
});
