// The runner's Durable Object error report, from answers shaped as
// Cloudflare gives them, without the network.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DO_QUERIES,
  KEYS,
  SERVICE_KEYS,
  bucketsOf,
  byStatus,
  classify,
  doQuery,
  format,
  parseArgs,
  parseCalculations,
  parseDoGroups,
  parseEvents,
  telemetryQuestions,
  windowOf,
} from "./runner-errors.mjs";

const answer = (rows) => ({ data: { viewer: { accounts: [{ rows }] } } });
const byNamespace = DO_QUERIES.find((query) => query.key === "by_namespace").variants[1];

test("the command line has defaults and bounds", () => {
  assert.deepEqual(parseArgs([], {}), { help: false, json: false, keys: false, days: 7, samples: 10, script: "g1t-runner", account: "1e6f2cffa3f445920836e8ebe446bb58" });
  const options = parseArgs(["--days", "90", "--samples", "3", "--script", "other", "--json", "--keys"], { CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.equal(options.days, 31);
  assert.equal(options.samples, 3);
  assert.equal(options.script, "other");
  assert.equal(options.account, "acct");
  assert.ok(options.json && options.keys);
  assert.equal(parseArgs(["--days", "soon"], {}).days, 7);
});

test("the window is the last N days", () => {
  assert.deepEqual(windowOf(new Date("2026-10-08T12:00:00Z"), 7), { start: "2026-10-01T12:00:00.000Z", end: "2026-10-08T12:00:00.000Z" });
});

test("the query is for one script, with the variant's sums and dimensions", () => {
  const query = doQuery(byNamespace);
  assert.match(query, /durableObjectsInvocationsAdaptiveGroups\(limit: 10000, filter: \{ datetime_geq: \$start, datetime_leq: \$end, scriptName: \$script \}\)/);
  assert.match(query, /sum \{ requests errors \}/);
  assert.match(query, /dimensions \{ namespaceId status \}/);
  assert.match(query, /\$script: String!/);
});

test("rows are named, summed per status and sorted by requests", () => {
  const body = answer([
    { sum: { requests: 900, errors: 300 }, dimensions: { namespaceId: "ns1", status: "scriptThrewException" } },
    { sum: { requests: 1000, errors: 0 }, dimensions: { namespaceId: "ns1", status: "success" } },
    { sum: { requests: 40, errors: 20 }, dimensions: { namespaceId: "ns2", status: "internalError" } },
    { sum: { requests: 10, errors: 0 }, dimensions: { namespaceId: "ns2", status: "success" } },
  ]);
  const parsed = parseDoGroups(body, byNamespace, { ns1: "g1t-runner_AttemptSandbox" });
  assert.deepEqual(parsed.dims, ["namespace_id", "status"]);
  assert.deepEqual(parsed.rows[0], { namespace_id: "g1t-runner_AttemptSandbox", status: "success", requests: 1000, errors: 0 });
  assert.equal(parsed.rows.at(-1).namespace_id, "ns2");
  assert.deepEqual(parsed.totals, { requests: 1950, errors: 320 });
  assert.deepEqual(byStatus(parsed), [
    { status: "success", requests: 1010, errors: 0 },
    { status: "scriptThrewException", requests: 900, errors: 300 },
    { status: "internalError", requests: 40, errors: 20 },
  ]);
});

test("Cloudflare's refusal becomes the error, so the next variant is tried", () => {
  assert.throws(() => parseDoGroups({ errors: [{ message: "unknown field wallTime" }] }, byNamespace), /unknown field wallTime/);
  assert.throws(() => parseDoGroups({ data: {} }, byNamespace), /no rows/);
});

test("the telemetry questions filter on the script and on failures", () => {
  const questions = telemetryQuestions({ script: "g1t-runner", from: 1, to: 2, samples: 5 });
  assert.deepEqual(questions.map((q) => q.key), ["failed_invocations", "exceptions", "error_logs", "samples"]);
  const failed = questions[0].body;
  assert.equal(failed.view, "calculations");
  assert.deepEqual(failed.timeframe, { from: 1, to: 2 });
  assert.deepEqual(failed.parameters.filters, [
    { key: SERVICE_KEYS[0], operation: "eq", type: "string", value: "g1t-runner" },
    { key: KEYS.outcome, operation: "neq", type: "string", value: "ok" },
  ]);
  assert.deepEqual(failed.parameters.groupBys.map((g) => g.value), [KEYS.entrypoint, KEYS.eventType, KEYS.outcome]);
  assert.equal(questions[3].body.view, "events");
  assert.equal(questions[3].body.limit, 5);
  const other = telemetryQuestions({ script: "g1t-runner", from: 1, to: 2, samples: 5, serviceKey: "$metadata.service" });
  assert.equal(other[1].body.parameters.filters[0].key, "$metadata.service");
});

test("a calculations answer becomes rows with counts, largest first", () => {
  const body = {
    success: true,
    result: {
      calculations: [
        {
          aggregates: [
            { groups: [{ key: KEYS.entrypoint, value: "AttemptSandbox" }, { key: KEYS.eventType, value: "rpc" }], value: 12 },
            { groups: [{ key: KEYS.entrypoint, value: "AttemptSandbox" }, { key: KEYS.eventType, value: "alarm" }], value: 540 },
            { groups: [{ key: KEYS.entrypoint, value: "" }, { key: KEYS.eventType, value: "alarm" }], count: 3 },
          ],
        },
      ],
    },
  };
  assert.deepEqual(parseCalculations(body), [
    { [KEYS.entrypoint]: "AttemptSandbox", [KEYS.eventType]: "alarm", count: 540 },
    { [KEYS.entrypoint]: "AttemptSandbox", [KEYS.eventType]: "rpc", count: 12 },
    { [KEYS.entrypoint]: "(none)", [KEYS.eventType]: "alarm", count: 3 },
  ]);
  assert.throws(() => parseCalculations({ success: false, errors: [{ message: "Unauthorized" }] }), /Unauthorized/);
  assert.throws(() => parseCalculations({ success: true, result: {} }), /no calculations/);
});

test("an events answer becomes plain records, the object id cut short", () => {
  const body = {
    success: true,
    result: {
      events: {
        events: [
          {
            timestamp: Date.UTC(2026, 9, 7, 3, 4, 5),
            $workers: { entrypoint: "AttemptSandbox", eventType: "alarm", outcome: "exception", durableObjectId: "0123456789abcdef0123" },
            $metadata: { error: "Durable Object reset because its code was updated." },
          },
          { $workers: { eventType: "rpc", outcome: "canceled" }, source: { message: "sandbox not started" } },
        ],
      },
    },
  };
  assert.deepEqual(parseEvents(body), [
    { at: "2026-10-07T03:04:05.000Z", entrypoint: "AttemptSandbox", event_type: "alarm", outcome: "exception", object: "0123456789ab", error: "Durable Object reset because its code was updated.", message: null },
    { at: null, entrypoint: null, event_type: "rpc", outcome: "canceled", object: null, error: null, message: "sandbox not started" },
  ]);
});

test("messages fall into buckets, expected or not", () => {
  assert.equal(classify("Durable Object reset because its code was updated.").bucket, "deploy_reset");
  assert.equal(classify("Durable Object reset because its code was updated.").expected, true);
  assert.equal(classify("sandbox stop not reported checks report_checks failed with status 500").bucket, "stop_not_reported");
  assert.equal(classify("sandbox alarm failed abc retry 2 storage overloaded").bucket, "alarm_failed");
  assert.equal(classify("there is no container instance that can be provided to this durable object").bucket, "no_capacity");
  assert.equal(classify("sandbox not started agent g1t could not read this project's guardrails: down").bucket, "not_started");
  assert.equal(classify("container exited with unexpected exit code: 137").bucket, "container_exited");
  assert.equal(classify("Network connection lost.").bucket, "connection_lost");
  assert.equal(classify("", "canceled").bucket, "caller_gone");
  assert.equal(classify("something new").bucket, "other");
  assert.equal(classify("something new").expected, false);
});

test("buckets sum the counts of their messages", () => {
  const rows = [
    { [KEYS.error]: "Durable Object reset because its code was updated.", count: 200 },
    { [KEYS.error]: "Network connection lost.", count: 7 },
    { [KEYS.error]: "Durable Object reset because its code was updated (2).", count: 50 },
  ];
  assert.deepEqual(
    bucketsOf(rows, KEYS.error).map((b) => [b.bucket, b.count]),
    [
      ["deploy_reset", 250],
      ["connection_lost", 7],
    ],
  );
});

test("the text report shows rates, statuses, buckets and what could not be read", () => {
  const parsed = parseDoGroups(
    answer([
      { sum: { requests: 100, errors: 31 }, dimensions: { namespaceId: "ns1", status: "scriptThrewException" } },
      { sum: { requests: 200, errors: 0 }, dimensions: { namespaceId: "ns1", status: "success" } },
    ]),
    byNamespace,
    { ns1: "g1t-runner_AttemptSandbox" },
  );
  const rows = [{ [KEYS.error]: "Durable Object reset because its code was updated.", count: 31 }];
  const text = format({
    account: "acct",
    script: "g1t-runner",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-08T00:00:00.000Z",
    analytics: [
      { key: "by_namespace", label: "By namespace", ...parsed, by_status: byStatus(parsed) },
      { key: "by_day", label: "By day", error: "unknown field date" },
    ],
    telemetry: [
      { key: "exceptions", label: "Exceptions", rows, buckets: bucketsOf(rows, KEYS.error) },
      { key: "samples", label: "Samples", rows: [{ at: "2026-10-07T00:00:00.000Z", entrypoint: "AttemptSandbox", event_type: "alarm", outcome: "exception", object: "abc", error: "boom", message: null }] },
    ],
    keys: null,
    notes: ["Telemetry is filtered on $workers.scriptName."],
  });
  assert.match(text, /g1t-runner_AttemptSandbox\s+scriptThrewException\s+100\s+31\s+31\.0%/);
  assert.match(text, /by status:/);
  assert.match(text, /could not read: unknown field date/);
  assert.match(text, /31\s+deploy_reset \(expected\)/);
  assert.match(text, /AttemptSandbox alarm exception abc/);
  assert.match(text, /\n {4}boom/);
  assert.doesNotMatch(text, /Bearer|authorization/i);
});
