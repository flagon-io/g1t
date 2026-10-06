import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPONENTS,
  type ComponentStatus,
  type Incident,
  classify,
  componentStatus,
  dotClass,
  recentIncidents,
  report,
  summarize,
} from "./status.ts";

const info = (key: string) => COMPONENTS.find((c) => c.key === key)!;
const row = (key: string, state: ComponentStatus["state"]): ComponentStatus => ({
  ...componentStatus(info(key), null),
  state,
});

test("a quick answer is up, a slow one degraded, a failure down", () => {
  assert.deepEqual(classify({ ok: true, ms: 84.4 }), { state: "up", detail: "Answered in 84 ms" });
  assert.equal(classify({ ok: true, ms: 2400 }).state, "degraded");
  assert.deepEqual(classify({ ok: false, ms: 3000, error: "timed out" }), { state: "down", detail: "Failed: timed out" });
  assert.equal(classify({ ok: false, ms: 10 }).detail, "Failed: no answer");
});

test("a part with no check is never shown as working", () => {
  assert.deepEqual(classify(null), { state: "unmonitored", detail: "Not monitored yet" });
  const sandboxes = componentStatus(info("sandboxes"), null);
  assert.equal(sandboxes.state, "unmonitored");
  assert.equal(sandboxes.latency_ms, null);
});

test("everything checked and answering is all clear, whatever is unmonitored", () => {
  const overall = summarize([row("site", "up"), row("api", "up"), row("sandboxes", "unmonitored")]);
  assert.deepEqual(overall, { state: "up", line: "All monitored systems are working" });
});

test("a core part down is a major outage", () => {
  const overall = summarize([row("site", "up"), row("git", "down"), row("docs", "up")]);
  assert.equal(overall.state, "down");
  assert.equal(overall.line, "Major outage: Git and repositories");
});

test("a non-core part down, or anything slow, is degraded", () => {
  assert.equal(summarize([row("site", "up"), row("docs", "down")]).state, "degraded");
  assert.equal(summarize([row("site", "degraded"), row("docs", "up")]).state, "degraded");
  assert.equal(
    summarize([row("site", "up"), row("docs", "down"), row("billing", "degraded")]).line,
    "Some systems are having trouble: Documentation, Billing",
  );
});

test("down outranks degraded", () => {
  assert.equal(summarize([row("docs", "degraded"), row("api", "down")]).state, "down");
});

const incident = (extra: Partial<Incident>): Incident => ({
  id: "inc_1",
  title: "Pushes are slow",
  impact: "degraded",
  components: ["git"],
  started_at: "2026-10-05T10:00:00Z",
  resolved_at: null,
  updates: [],
  ...extra,
});

test("an open incident lowers the line even when checks pass", () => {
  const overall = summarize([row("site", "up"), row("git", "up")], [incident({})]);
  assert.deepEqual(overall, { state: "degraded", line: "Investigating: Pushes are slow" });
  assert.equal(summarize([row("site", "up")], [incident({ impact: "down" })]).state, "down");
});

test("a resolved incident does not", () => {
  const overall = summarize([row("site", "up")], [incident({ resolved_at: "2026-10-05T11:00:00Z" })]);
  assert.equal(overall.state, "up");
});

test("nothing checked and nothing open is unknown, not green", () => {
  assert.equal(summarize([row("sandboxes", "unmonitored")]).state, "unknown");
  assert.equal(dotClass("unknown"), "bg-faint");
});

test("old resolved incidents fall off the page; open ones never do", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  const list = [
    incident({ id: "old", resolved_at: "2026-06-01T00:00:00Z" }),
    incident({ id: "recent", resolved_at: "2026-09-20T00:00:00Z" }),
    incident({ id: "open", started_at: "2026-01-01T00:00:00Z" }),
  ];
  assert.deepEqual(
    recentIncidents(list, now).map((i) => i.id),
    ["recent", "open"],
  );
});

test("the report covers every part, in order, with the overall line from the same data", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const r = report({ site: { ok: true, ms: 40 }, api: { ok: false, ms: 3000, error: "timed out" } }, now, []);
  assert.deepEqual(
    r.components.map((c) => c.key),
    COMPONENTS.map((c) => c.key),
  );
  assert.equal(r.components.find((c) => c.key === "docs")?.state, "unmonitored");
  assert.equal(r.overall.state, "down");
  assert.equal(r.checked_at, "2026-10-05T12:00:00.000Z");
});

test("each state has its own dot", () => {
  assert.equal(dotClass("up"), "bg-accent");
  assert.equal(dotClass("degraded"), "bg-warn");
  assert.equal(dotClass("down"), "bg-danger");
  assert.equal(dotClass("unmonitored"), "bg-faint");
  assert.equal(dotClass(null), "bg-faint");
});
