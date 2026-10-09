import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DATASETS, DATASET_IDS, datasetQueryError, datasetTime, parseDatasetQuery, type DatasetQuery } from "./datasets.ts";

const fixtures = JSON.parse(readFileSync(new URL("./datasets.fixtures.json", import.meta.url), "utf8")) as {
  cases: { query: unknown; error: string | null }[];
};

test("agrees with the Rust validator on every shared case", () => {
  assert.ok(fixtures.cases.length > 20);
  for (const { query, error } of fixtures.cases) {
    const parsed = parseDatasetQuery(query);
    const label = JSON.stringify(query);
    if (error === null) assert.ok("query" in parsed, `${label}: ${"error" in parsed ? parsed.error : ""}`);
    else if (error === "*") assert.ok("error" in parsed, `${label} should be refused`);
    else assert.deepEqual(parsed, { error }, label);
  }
});

test("a parsed query keeps only what the catalog knows", () => {
  const parsed = parseDatasetQuery({ dataset: "issues", measure: { op: "count" }, sql: "DROP TABLE issues", group_by: "repo" });
  assert.ok("query" in parsed);
  assert.equal("sql" in parsed.query, false);
  assert.equal(parsed.query.group_by, "repo");
});

test("every dataset has a time field and fields that are one thing each", () => {
  assert.deepEqual(Object.keys(DATASETS), [...DATASET_IDS]);
  for (const id of DATASET_IDS) {
    const spec = DATASETS[id];
    assert.ok(spec.times.length > 0, id);
    for (const field of spec.dimensions) assert.ok(!spec.measures.includes(field) && !spec.rates.includes(field), `${id}.${field}`);
  }
  assert.equal(DATASETS.spend.needs, "billing");
});

test("a typed query is checked against the catalog", () => {
  const ok: DatasetQuery = { dataset: "workflow_runs", measure: { op: "rate", field: "succeeded" }, interval: "day", range: "30d" };
  assert.equal(datasetQueryError(ok), null);
  assert.equal(datasetQueryError({ ...ok, limit: 2.5 }), "limit is between 1 and 100.");
});

test("range ends are real dates or UTC times", () => {
  assert.equal(datasetTime("1970-01-02"), 86_400_000);
  assert.equal(datasetTime("2026-10-02T05:16:19Z"), 1_790_918_179_000);
  assert.equal(datasetTime("2026-10-02T05:16:19.5Z"), 1_790_918_179_500);
  for (const bad of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-10-02T24:00:00Z", "2026-10-02T05:16:19", "2026-10-02T05:16:19+02:00", "26-10-02", "2026-1-02", "today", ""]) {
    assert.equal(datasetTime(bad), null, bad);
  }
});
