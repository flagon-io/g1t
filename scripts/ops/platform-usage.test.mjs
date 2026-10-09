// The platform usage report, from GraphQL answers as Cloudflare gives them,
// without the network.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DATASETS, WATCHER_QUERIES, assemble, buildQuery, format, lastFullHour, logsDataset, parseArgs, parseGroups, snake, verdict, watcherQuery, windows } from "./platform-usage.mjs";

const NOW = new Date("2026-10-08T15:30:00.000Z");
const answer = (rows) => ({ data: { viewer: { accounts: [{ rows }] } } });
const variantOf = (key, at = 0) => DATASETS.find((spec) => spec.key === key).variants[at];

test("the windows are the UTC month so far and the last 24 hours", () => {
  const [month, day] = windows(NOW);
  assert.deepEqual(month, { key: "month_to_date", label: "Month to date (UTC)", start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T15:30:00.000Z" });
  assert.equal(day.key, "last_24h");
  assert.equal(day.start, "2026-10-07T15:30:00.000Z");
  assert.equal(day.end, NOW.toISOString());
  // Just after midnight on the 1st, the month has only begun.
  assert.equal(windows(new Date("2026-11-01T00:05:00Z"))[0].start, "2026-11-01T00:00:00.000Z");
});

test("a query asks for the variant's sums and dimensions under one alias", () => {
  const query = buildQuery("kvOperationsAdaptiveGroups", variantOf("kv"));
  assert.match(query, /rows: kvOperationsAdaptiveGroups\(limit: 10000, filter: \{ datetime_geq: \$start, datetime_leq: \$end \}\)/);
  assert.match(query, /sum \{ requests \}/);
  assert.match(query, /dimensions \{ namespaceId actionType \}/);
  assert.match(query, /accounts\(filter: \{ accountTag: \$accountTag \}\)/);
  const artifacts = buildQuery("artifactsEventsAdaptiveGroups", variantOf("artifacts"));
  assert.match(artifacts, /\bcount\b/);
  const minute = buildQuery("durableObjectsPeriodicGroups", variantOf("durable_objects_periodic", 2));
  assert.match(minute, /datetimeMinute_geq: \$start, datetimeMinute_leq: \$end/);
});

test("Workers Logs are read from whichever dataset the schema has, or skipped", () => {
  assert.equal(logsDataset(["workersInvocationsAdaptive", "workersObservabilityEventsAdaptiveGroups"]), "workersObservabilityEventsAdaptiveGroups");
  assert.equal(logsDataset(["workersLogsSomethingGroups"]), "workersLogsSomethingGroups");
  assert.equal(logsDataset(["workersInvocationsAdaptive", "kvOperationsAdaptiveGroups"]), null);
});

test("groups are summed per name, named from the listing, sorted largest first, with totals", () => {
  const body = answer([
    { sum: { rowsRead: 10, rowsWritten: 1, readQueries: 2, writeQueries: 1 }, dimensions: { databaseId: "aaa" } },
    { sum: { rowsRead: 500, rowsWritten: 20, readQueries: 9, writeQueries: 3 }, dimensions: { databaseId: "bbb" } },
    { sum: { rowsRead: 5, rowsWritten: 0, readQueries: 1, writeQueries: 0 }, dimensions: { databaseId: "aaa" } },
  ]);
  const parsed = parseGroups(body, variantOf("d1"), { bbb: "g1t-repos" });
  assert.deepEqual(parsed.metrics, ["rows_read", "rows_written", "read_queries", "write_queries"]);
  assert.deepEqual(parsed.rows.map((row) => [row.name, row.rows_read]), [["g1t-repos", 500], ["aaa", 15]]);
  assert.deepEqual(parsed.totals, { rows_read: 515, rows_written: 21, read_queries: 12, write_queries: 4 });
  const kv = parseGroups(
    answer([
      { sum: { requests: 3 }, dimensions: { namespaceId: "n1", actionType: "write" } },
      { sum: { requests: 40 }, dimensions: { namespaceId: "n1", actionType: "read" } },
    ]),
    variantOf("kv"),
    { n1: "SESSIONS" },
  );
  assert.deepEqual(kv.rows.map((row) => row.name), ["SESSIONS / read", "SESSIONS / write"]);
  assert.throws(() => parseGroups({ errors: [{ message: "unknown field cpuTimeUs" }] }, variantOf("workers")), /cpuTimeUs/);
  assert.equal(snake("billableOperations"), "billable_operations");
});

test("a dataset that errors or is missing is a note, and the others still report", () => {
  const windowList = windows(NOW);
  const outcomes = {
    month_to_date: {
      workers: { body: answer([{ sum: { requests: 7, errors: 0, cpuTimeUs: 1200 }, dimensions: { scriptName: "web" } }]), variant: variantOf("workers"), dataset: "workersInvocationsAdaptive" },
      d1: { body: { errors: [{ message: "unknown field \"readQueries\"" }] }, variant: variantOf("d1"), dataset: "d1AnalyticsAdaptiveGroups" },
      queues: { skipped: "queueMessageOperationsAdaptiveGroups is not in this account's schema" },
      kv: { error: new Error("fetch failed") },
      artifacts: { body: answer([{ count: 4, sum: { durationMs: 80 }, dimensions: { repositoryNamespace: "g1t", eventType: "pull" } }]), variant: variantOf("artifacts"), dataset: "artifactsEventsAdaptiveGroups" },
    },
    last_24h: {},
  };
  const report = assemble({ account: "acct", now: NOW, windowList, outcomes });
  const month = report.windows[0];
  assert.deepEqual(month.datasets.map((set) => set.key), ["workers", "artifacts"]);
  assert.equal(month.notes.length, 3);
  assert.match(month.notes.join("\n"), /D1 rows.*readQueries/);
  assert.match(month.notes.join("\n"), /not in this account's schema/);
  assert.match(month.notes.join("\n"), /fetch failed/);
  assert.deepEqual(report.windows[1].datasets, []);
  const text = format(report, 10);
  assert.match(text, /Workers invocations, by script/);
  assert.match(text, /web\s+7\s+0\s+1,200/);
  assert.match(text, /Notes:/);
});

test("the JSON report is one snake_case object with every row", () => {
  const windowList = windows(NOW);
  const rows = Array.from({ length: 15 }, (_, at) => ({ sum: { requests: at + 1 }, dimensions: { scriptName: `s${at}` } }));
  const outcomes = { month_to_date: { durable_objects: { body: answer(rows), variant: variantOf("durable_objects", 1), dataset: "durableObjectsInvocationsAdaptiveGroups" } }, last_24h: {} };
  const report = JSON.parse(JSON.stringify(assemble({ account: "acct", now: NOW, windowList, outcomes })));
  assert.deepEqual(Object.keys(report), ["account", "generated_at", "windows"]);
  assert.deepEqual(Object.keys(report.windows[0]), ["key", "label", "start", "end", "datasets", "notes", "errors"]);
  const set = report.windows[0].datasets[0];
  assert.deepEqual(Object.keys(set), ["key", "label", "dataset", "metrics", "rows", "totals"]);
  assert.equal(set.rows.length, 15);
  assert.equal(set.rows[0].name, "s14");
  assert.equal(set.totals.requests, 120);
  const keys = JSON.stringify(report).match(/"([^"]+)":/g).map((key) => key.slice(1, -2));
  for (const key of keys) assert.match(key, /^[a-z0-9_]+$/, key);
  // The tables show only the top.
  assert.match(format(assemble({ account: "acct", now: NOW, windowList, outcomes }), 10), /\.\.\. and 5 more/);
});

test("the command line reads --json, --top and the account", () => {
  assert.deepEqual(parseArgs(["--json", "--top", "3", "--account", "abc"], {}), { help: false, json: true, top: 3, account: "abc" });
  assert.equal(parseArgs([], { CLOUDFLARE_ACCOUNT_ID: "env" }).account, "env");
  assert.equal(parseArgs(["--help"], {}).help, true);
  assert.equal(parseArgs([], {}).top, 10);
});

test("errors, fallbacks, failed watcher queries and an all-empty account fail the check", () => {
  const windowList = windows(NOW);
  const ok = {
    month_to_date: { workers: { body: answer([{ sum: { requests: 7, errors: 0, cpuTimeUs: 1 }, dimensions: { scriptName: "web" } }]), variant: variantOf("workers"), dataset: "workersInvocationsAdaptive" } },
    last_24h: {},
  };
  assert.deepEqual(verdict(assemble({ account: "acct", now: NOW, windowList, outcomes: ok }), { workers: { rows: 3 } }), []);
  const broken = {
    month_to_date: {
      workers: { ...ok.month_to_date.workers, fellBack: 'unknown field "cpuTimeUs"' },
      kv: { error: new Error("fetch failed") },
    },
    last_24h: {},
  };
  const problems = verdict(assemble({ account: "acct", now: NOW, windowList, outcomes: broken }), { do_sql: { error: 'unknown field "rowsWritten"' }, d1: { rows: 2 } });
  assert.equal(problems.length, 3);
  assert.match(problems.join("\n"), /fell back to fewer fields: unknown field "cpuTimeUs"/);
  assert.match(problems.join("\n"), /fetch failed/);
  assert.match(problems.join("\n"), /watcher query do_sql \(durableObjectsPeriodicGroups\): unknown field "rowsWritten"/);
  const empty = { month_to_date: { workers: { body: answer([]), variant: variantOf("workers"), dataset: "workersInvocationsAdaptive" } }, last_24h: {} };
  assert.match(verdict(assemble({ account: "acct", now: NOW, windowList, outcomes: empty }), { kv: { rows: 0 } }).join("\n"), /every dataset answered with no rows/);
});

test("the watcher queries are billing's, field for field, over the last full hour", async () => {
  const { readFile } = await import("node:fs/promises");
  const rust = await readFile(new URL("../../services/billing/src/platform.rs", import.meta.url), "utf8");
  const theirs = [...rust.matchAll(/Query \{ key: "([^"]+)", dataset: "([^"]+)", select: "([^"]+)", dimensions: "([^"]+)", hour_filter: "([^"]+)" \}/g)].map(
    ([, key, dataset, select, dimensions, hourFilter]) => ({ key, dataset, select, dimensions, hourFilter }),
  );
  assert.deepEqual(WATCHER_QUERIES, theirs);
  assert.deepEqual(lastFullHour(NOW), { since: "2026-10-08T14:00:00Z", until: "2026-10-08T15:00:00Z" });
  const d1 = watcherQuery(WATCHER_QUERIES.find((q) => q.key === "d1"));
  assert.match(d1, /rows: d1AnalyticsAdaptiveGroups\(limit: 10000, filter: \{ datetimeHour_geq: \$since, datetimeHour_lt: \$until \}\)/);
  assert.match(d1, /\$since: Time!/);
});
