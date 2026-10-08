import assert from "node:assert/strict";
import { test } from "node:test";

import { components } from "./components.ts";
import {
  type DayRow,
  barFor,
  buildPage,
  classify,
  dayState,
  effectiveState,
  lastDays,
  maintenanceState,
  openOn,
  percent,
  recentIncidents,
  summarize,
  uptimeOf,
  uptimeOver,
} from "./model.ts";

const VARS = {
  SITE_URL: "https://g1t.sh",
  API_URL: "https://api.g1t.sh",
  MCP_URL: "https://mcp.g1t.sh",
  DOCS_URL: "https://docs.g1t.sh",
  PAGES_URL: "https://g1t.page",
  MODELS_URL: "https://models.g1t.sh",
  PROBE_REPO: "flagon-io/g1t",
};

const row = (component: string, day: string, up: number, degraded = 0, down = 0): DayRow => ({
  component,
  day,
  checks: up + degraded + down,
  up,
  degraded,
  down,
  latency_total: (up + degraded) * 100,
  latency_count: up + degraded,
});

test("classify: fast is up, slow is degraded, failed is down, none is unmonitored", () => {
  assert.equal(classify({ ok: true, ms: 84.4 }).state, "up");
  assert.equal(classify({ ok: true, ms: 84.4 }).detail, "Answered in 84 ms");
  assert.equal(classify({ ok: true, ms: 2000 }).state, "degraded");
  assert.deepEqual(classify({ ok: false, ms: 5000, error: "timed out" }), { state: "down", detail: "Failed: timed out" });
  assert.equal(classify(null).state, "unmonitored");
});

test("uptime rounds down, so one failure never reads as 100%", () => {
  assert.equal(uptimeOf(1439, 1440), 99.93);
  assert.equal(uptimeOf(99999, 100000), 99.99);
  assert.equal(uptimeOf(10, 10), 100);
  assert.equal(uptimeOf(0, 0), null);
  assert.equal(percent(100), "100%");
  assert.equal(percent(99.5), "99.50%");
  assert.equal(percent(null), "No data");
});

test("a day's colour: a blip stays green, a bad hour is degraded, worse is down", () => {
  assert.equal(dayState(null), "none");
  assert.equal(dayState({ checks: 1440, up: 1439, degraded: 0, down: 1 }), "up");
  assert.equal(dayState({ checks: 1440, up: 1380, degraded: 0, down: 60 }), "degraded");
  assert.equal(dayState({ checks: 1440, up: 1000, degraded: 0, down: 440 }), "down");
  // Answering, but slow much of the day.
  assert.equal(dayState({ checks: 100, up: 60, degraded: 40, down: 0 }), "degraded");
  // An incident colours the day at least as badly as its impact.
  assert.equal(dayState({ checks: 1440, up: 1440, degraded: 0, down: 0 }, "down"), "down");
  assert.equal(dayState(null, "degraded"), "degraded");
});

test("lastDays ends today, oldest first", () => {
  const days = lastDays(new Date("2026-10-05T12:00:00Z"));
  assert.equal(days.length, 90);
  assert.equal(days.at(-1), "2026-10-05");
  assert.equal(days[0], "2026-07-08");
});

test("an incident is on every day it was open", () => {
  const incident = { started_at: "2026-10-03T23:30:00Z", resolved_at: "2026-10-04T00:10:00Z" };
  assert.equal(openOn(incident, "2026-10-02"), false);
  assert.equal(openOn(incident, "2026-10-03"), true);
  assert.equal(openOn(incident, "2026-10-04"), true);
  assert.equal(openOn(incident, "2026-10-05"), false);
  assert.equal(openOn({ started_at: "2026-10-01T00:00:00Z", resolved_at: null }, "2026-10-05"), true);
});

test("bars and 90-day uptime come from the daily tally", () => {
  const days = ["2026-10-03", "2026-10-04", "2026-10-05"];
  const rows = [row("api", "2026-10-04", 1439, 0, 1), row("api", "2026-10-05", 600), row("git", "2026-10-05", 10)];
  const bar = barFor("api", rows, [], days);
  assert.deepEqual(
    bar.map((d) => d.state),
    ["none", "up", "up"],
  );
  assert.equal(bar[1]!.failed, 1);
  assert.equal(bar[1]!.avg_ms, 100);
  assert.equal(uptimeOver("api", rows), uptimeOf(2039, 2040));
  assert.equal(uptimeOver("docs", rows), null);
});

test("a bar marks the days an incident on its part was open", () => {
  const incident = {
    id: "1",
    title: "Clones failing",
    impact: "down" as const,
    status: "resolved" as const,
    components: ["git"],
    component_impacts: [{ key: "git", impact: "major_outage" as const }],
    started_at: "2026-10-04T10:00:00Z",
    resolved_at: "2026-10-04T11:00:00Z",
    url: "https://status.g1t.sh/incidents/1",
    postmortem_published_at: null,
    updates: [],
  };
  const days = ["2026-10-04", "2026-10-05"];
  const git = barFor("git", [row("git", "2026-10-04", 1440)], [incident], days);
  assert.equal(git[0]!.state, "down");
  assert.deepEqual(git[0]!.incidents, ["Clones failing"]);
  assert.equal(barFor("api", [row("api", "2026-10-04", 1440)], [incident], days)[0]!.state, "up");
});

test("summarize: core down is a major outage, others partial, slow is degraded performance", () => {
  const core = new Set(["site", "api"]);
  const up = { key: "api", name: "API", state: "up" as const };
  assert.equal(summarize([up], core).title, "All systems normal");
  assert.equal(summarize([{ ...up, state: "down" }], core).title, "Major outage");
  assert.equal(summarize([up, { key: "docs", name: "Documentation", state: "down" }], core).title, "Partial outage");
  const slow = summarize([up, { key: "docs", name: "Documentation", state: "degraded" }], core);
  assert.equal(slow.title, "Degraded performance");
  assert.match(slow.line, /Documentation/);
  assert.equal(summarize([{ key: "sandboxes", name: "Sandboxes", state: "unmonitored" }], core).state, "unknown");
  const incident = summarize([up], core, [{ title: "Pushes failing", impact: "degraded", status: "identified" }]);
  assert.equal(incident.title, "Partial outage");
  assert.equal(incident.line, "Identified: Pushes failing.");
});

test("recent incidents: open ones and those resolved in 90 days, newest first", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  const list = recentIncidents(
    [
      { id: "old", started_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-01T01:00:00Z" },
      { id: "open", started_at: "2026-01-02T00:00:00Z", resolved_at: null },
      { id: "new", started_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-01T01:00:00Z" },
    ],
    now,
  );
  assert.deepEqual(
    list.map((i) => i.id),
    ["new", "open"],
  );
});

test("buildPage: parts with no check are unmonitored and have no uptime; staleness is noticed", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const parts = components(VARS, true);
  const current = new Map(parts.map((p) => [p.key, { state: "up" as const, detail: "Answered in 80 ms", latency_ms: 80 }]));
  const page = buildPage({
    parts,
    current,
    checkedAt: "2026-10-05T11:59:30Z",
    days: [row("api", "2026-10-05", 700)],
    incidents: [],
    now,
  });
  const sandboxes = page.report.components.find((c) => c.key === "sandboxes")!;
  assert.equal(sandboxes.state, "unmonitored");
  assert.equal(sandboxes.uptime_90d, null);
  assert.equal(page.report.components.find((c) => c.key === "api")!.uptime_90d, 100);
  assert.equal(page.report.overall.title, "All systems normal");
  assert.equal(page.stale, false);
  assert.equal(page.bars.api!.length, 90);
  assert.equal(buildPage({ parts, current, checkedAt: "2026-10-05T11:00:00Z", days: [], incidents: [], now }).stale, true);
});

test("components: an installation without a host leaves that part off", () => {
  const keys = components({ SITE_URL: "http://localhost:8787", API_URL: "http://localhost:8787/api", PROBE_REPO: "me/demo" }, false).map(
    (c) => c.key,
  );
  assert.deepEqual(keys, ["site", "api", "git", "speed"]);
  const bare = components({ SITE_URL: "http://g1t:8787" }, false);
  assert.deepEqual(
    bare.map((c) => c.key),
    ["site"],
  );
  assert.equal(bare[0]!.check.kind === "http" && bare[0]!.check.steps.length, 1);
  const all = components(VARS, true);
  assert.deepEqual(
    all.map((c) => c.key),
    ["site", "api", "git", "speed", "mcp", "docs", "deployments", "agents", "sandboxes", "billing"],
  );
  const speed = all.find((c) => c.key === "speed")!;
  assert.deepEqual(speed.check, { kind: "http", steps: [{ url: "https://g1t.sh/flagon-io/g1t", browser: true }, { url: "https://g1t.sh/explore", browser: true }] });
  assert.equal(classify({ ok: true, ms: 900 }, speed.slowMs).state, "degraded");
  assert.equal(classify({ ok: true, ms: 300 }, speed.slowMs).state, "up");
  const git = all.find((c) => c.key === "git")!;
  assert.deepEqual(git.check, { kind: "http", steps: [{ url: "https://g1t.sh/flagon-io/g1t.git/info/refs?service=git-upload-pack" }] });
});

test("a part's state: the worse of its check and open incidents; maintenance unless an incident says worse", () => {
  assert.equal(effectiveState("up", [], false), "up");
  assert.equal(effectiveState("up", ["partial_outage"], false), "partial");
  assert.equal(effectiveState("down", ["degraded"], false), "down", "a failing check beats a milder report");
  assert.equal(effectiveState("degraded", ["major_outage", "degraded"], false), "down", "the worst impact wins");
  assert.equal(effectiveState("up", ["operational"], false), "up");
  assert.equal(effectiveState("unmonitored", ["degraded"], false), "degraded", "an incident speaks for a part with no check");
  assert.equal(effectiveState("down", [], true), "maintenance", "failing checks in a window are expected");
  assert.equal(effectiveState("up", ["major_outage"], true), "down", "an incident during maintenance still shows");
});

test("maintenance moves with its window, and cancelled or completed stays put", () => {
  const m = { state: "scheduled" as const, starts_at: "2026-10-05T12:00:00Z", ends_at: "2026-10-05T13:00:00Z" };
  assert.equal(maintenanceState(m, new Date("2026-10-05T11:59:00Z")), "scheduled");
  assert.equal(maintenanceState(m, new Date("2026-10-05T12:00:00Z")), "in_progress");
  assert.equal(maintenanceState(m, new Date("2026-10-05T13:00:00Z")), "completed");
  assert.equal(maintenanceState({ ...m, state: "in_progress" }, new Date("2026-10-05T11:00:00Z")), "in_progress", "started early by hand");
  assert.equal(maintenanceState({ ...m, state: "cancelled" }, new Date("2026-10-05T12:30:00Z")), "cancelled");
  assert.equal(maintenanceState({ ...m, state: "completed" }, new Date("2026-10-05T12:30:00Z")), "completed", "finished early by hand");
});

test("buildPage: incident impacts and maintenance reach the parts and the banner", () => {
  const now = new Date("2026-10-05T12:30:00Z");
  const parts = components(VARS, false);
  const current = new Map(parts.map((p) => [p.key, { state: "up" as const, detail: "Answered in 80 ms", latency_ms: 80 }]));
  current.set("docs", { state: "down", detail: "Failed: HTTP 502", latency_ms: null });
  const maintenance = [
    { id: "m1", title: "Docs move", message: "Moving docs.", components: ["docs"], starts_at: "2026-10-05T12:00:00Z", ends_at: "2026-10-05T13:00:00Z", state: "scheduled" as const, url: "", updates: [] },
    { id: "m2", title: "Later", message: "Later.", components: ["api"], starts_at: "2026-10-06T12:00:00Z", ends_at: "2026-10-06T13:00:00Z", state: "scheduled" as const, url: "", updates: [] },
    { id: "m3", title: "Called off", message: "No.", components: ["api"], starts_at: "2026-10-05T12:00:00Z", ends_at: "2026-10-05T13:00:00Z", state: "cancelled" as const, url: "", updates: [] },
  ];
  const quiet = buildPage({ parts, current, checkedAt: "2026-10-05T12:29:30Z", days: [], incidents: [], maintenance, now });
  const docs = quiet.report.components.find((c) => c.key === "docs")!;
  assert.equal(docs.state, "maintenance");
  assert.equal(docs.check_state, "down");
  assert.equal(quiet.report.overall.state, "maintenance");
  assert.equal(quiet.report.overall.title, "Under maintenance");
  assert.deepEqual(quiet.report.maintenance.map((m) => [m.id, m.state]), [["m1", "in_progress"], ["m2", "scheduled"]]);

  const incident = {
    id: "i1",
    title: "API errors",
    impact: "degraded" as const,
    status: "identified" as const,
    components: ["api"],
    component_impacts: [{ key: "api", impact: "partial_outage" as const }],
    started_at: "2026-10-05T12:10:00Z",
    resolved_at: null,
    url: "",
    postmortem_published_at: null,
    updates: [],
  };
  const busy = buildPage({ parts, current, checkedAt: "2026-10-05T12:29:30Z", days: [], incidents: [incident], maintenance, now });
  assert.equal(busy.report.components.find((c) => c.key === "api")!.state, "partial");
  assert.equal(busy.report.overall.title, "Partial outage");
  assert.equal(busy.report.overall.line, "Identified: API errors.");
  const resolved = buildPage({ parts, current, checkedAt: "2026-10-05T12:29:30Z", days: [], incidents: [{ ...incident, resolved_at: "2026-10-05T12:20:00Z" }], now });
  assert.equal(resolved.report.components.find((c) => c.key === "api")!.state, "up", "a resolved incident no longer colours its part");
});

test("git storage is listed only with the repos service, and degraded says why", () => {
  assert.equal(components(VARS, true).some((part) => part.key === "storage"), false);
  const storage = components(VARS, true, true).find((part) => part.key === "storage");
  assert.equal(storage?.check.kind, "storage");
  assert.equal(storage?.core, false);
  assert.deepEqual(classify({ ok: true, ms: 40, degraded: "Rate limited 2 times in 5 minutes" }), {
    state: "degraded",
    detail: "Rate limited 2 times in 5 minutes",
  });
});
