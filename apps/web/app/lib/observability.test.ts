import assert from "node:assert/strict";
import test from "node:test";

import type { TelemetrySpan } from "@g1t/contracts";

import { change, count, duration, errorIssue, filterOf, matchesLog, niceTicks, parseView, percent, viewHref } from "./observability.ts";
import { spanTree } from "./observability-trace.ts";

test("a view reads from the address and writes back to it", () => {
  const view = parseView(new URLSearchParams("range=1h&env=production&q=timeout"));
  assert.deepEqual(view, { range: "1h", environment: "production", service: null, deployment: null, q: "timeout" });
  assert.equal(viewHref("/a/b/observability/logs", view), "/a/b/observability/logs?range=1h&env=production&q=timeout");
  assert.equal(viewHref("/x", view, { env: null, q: null, range: "24h" }), "/x?range=24h");
  // The default period is left out of the address.
  assert.equal(viewHref("/x", parseView(new URLSearchParams("range=nonsense"))), "/x");
  const filter = filterOf(view, 3_600_000);
  assert.equal(filter.from_us, 0);
  assert.equal(filter.to_us, 3_600_000_000);
  assert.deepEqual(filter.environments, ["production"]);
});

test("numbers read as people read them", () => {
  assert.equal(duration(0.42), "420 µs");
  assert.equal(duration(4.25), "4.3 ms");
  assert.equal(duration(87), "87 ms");
  assert.equal(duration(1500), "1.5 s");
  assert.equal(duration(125_000), "2m 5s");
  assert.equal(duration(null), "—");
  assert.equal(duration(0), "0");
  assert.equal(count(12_400), "12.4K");
  assert.equal(percent(0.0004), "0.04%");
  assert.equal(percent(0.25), "25%");
  assert.deepEqual(change(110, 100, true), { text: "+10%", good: false });
  assert.deepEqual(change(90, 100, true), { text: "−10%", good: true });
  assert.equal(change(5, 0, true), null);
  assert.deepEqual(niceTicks(0.37), [0, 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(niceTicks(870), [0, 250, 500, 750, 1000]);
});

test("a live line is shown only when the page's search would have found it", () => {
  const log = { severity: "error" as const, body: "Payment timeout for order 7", environment: "production", service: "api", deployment_id: null, attributes: { "user.id": "42" } };
  const view = parseView(new URLSearchParams("env=production"));
  assert.equal(matchesLog(log, view, []), true);
  assert.equal(matchesLog(log, { ...view, q: "timeout" }, []), true);
  assert.equal(matchesLog(log, { ...view, q: "refund" }, []), false);
  assert.equal(matchesLog(log, { ...view, q: "user.id=42" }, []), true);
  assert.equal(matchesLog(log, { ...view, q: "user.id=7" }, []), false);
  assert.equal(matchesLog(log, { ...view, q: "level:warn" }, []), false);
  assert.equal(matchesLog(log, view, ["error", "fatal"]), true);
  assert.equal(matchesLog(log, { ...view, environment: "preview" }, []), false);
});

const span = (id: string, parent: string | null, start: number): TelemetrySpan => ({
  trace_id: "t",
  span_id: id,
  parent_span_id: parent,
  name: id,
  kind: "internal",
  start_us: start,
  duration_us: 1,
  status: "unset",
  status_message: null,
  attributes: {},
  resource: {},
  events: [],
  links: [],
  service: "s",
  environment: null,
  deployment_id: null,
  commit_sha: null,
  source: "otlp",
});

test("spans nest under their parents, and orphans are still shown", () => {
  const rows = spanTree([span("c", "a", 3), span("a", null, 1), span("b", "a", 2), span("x", "missing", 5), span("loop1", "loop2", 9), span("loop2", "loop1", 9)]);
  assert.deepEqual(
    rows.map((r) => [r.span.span_id, r.depth]),
    [["a", 0], ["b", 1], ["c", 1], ["x", 0], ["loop1", 0], ["loop2", 0]],
  );
});

test("an error's issue says what, how often and where to look", () => {
  const issue = errorIssue(
    { name: "TypeError", message: "x is undefined", stack: "TypeError\n  at f (a.ts:1)", count: 3, first_us: 0, last_us: 60_000_000, service: "web", environment: "production", first_deployment_id: "dep_1", last_request_id: "r1", last_trace_id: null },
    "https://g1t.sh/acme/web/observability",
  );
  assert.equal(issue.title, "TypeError: x is undefined");
  assert.match(issue.body, /3 times/);
  assert.match(issue.body, /requests\/r1/);
  assert.match(issue.body, /dep_1/);
  assert.doesNotMatch(issue.body, /traces\//);
});
