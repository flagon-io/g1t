import assert from "node:assert/strict";
import { test } from "node:test";

import type { StatusIncident, StatusMaintenance } from "@g1t/contracts";

import { components } from "./components.ts";
import { type DayRow, buildPage } from "./model.ts";
import { byMonth, dayDetail, escape, prose, renderBadge, renderHistory, renderIncident, renderMaintenance, renderMessage, renderPage, renderSubscribe } from "./render.ts";

const NOW = new Date("2026-10-05T12:00:00Z");
const OPTIONS = { siteUrl: "https://g1t.sh", supportUrl: "https://g1t.sh/support", ogImage: "", selfUrl: "https://status.g1t.sh/", now: NOW, email: true };
const parts = components(
  {
    SITE_URL: "https://g1t.sh",
    API_URL: "https://api.g1t.sh",
    DOCS_URL: "https://docs.g1t.sh",
    MODELS_URL: "https://models.g1t.sh",
    PROBE_REPO: "flagon-io/g1t",
  },
  false,
);

function page(states: Record<string, "up" | "degraded" | "down">, incidents: StatusIncident[] = [], maintenance: StatusMaintenance[] = []) {
  const current = new Map(
    Object.entries(states).map(([k, state]) => [k, { state, detail: state === "down" ? "Failed: HTTP 502" : "Answered in 80 ms", latency_ms: 80 }]),
  );
  const days: DayRow[] = [
    { component: "api", day: "2026-10-05", checks: 720, up: 719, degraded: 0, down: 1, latency_total: 71900, latency_count: 719 },
  ];
  return buildPage({ parts, current, checkedAt: "2026-10-05T11:59:40Z", days, incidents, maintenance, now: NOW });
}

const INCIDENT: StatusIncident = {
  id: "abc",
  title: "Sign-in <failing>",
  impact: "down",
  status: "identified",
  components: ["site"],
  component_impacts: [{ key: "site", impact: "major_outage" }],
  started_at: "2026-10-05T11:40:00Z",
  resolved_at: null,
  url: "https://status.g1t.sh/incidents/abc",
  postmortem_published_at: null,
  updates: [{ id: "u1", at: "2026-10-05T11:45:00Z", status: "identified", text: "A bad deploy.\n\nRolling back." }],
};

const MAINT: StatusMaintenance = {
  id: "m1",
  title: "Database upgrade",
  message: "Pushes pause for up to five minutes.",
  components: ["git"],
  starts_at: "2026-10-06T02:00:00Z",
  ends_at: "2026-10-06T03:00:00Z",
  state: "scheduled",
  url: "https://status.g1t.sh/maintenance/m1",
  updates: [{ id: "mu1", at: "2026-10-05T10:00:00Z", text: "Pushes pause for up to five minutes." }],
};

test("escape covers HTML's specials", () => {
  assert.equal(escape(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("the page: banner, every part with its bar, and no incidents", () => {
  const html = renderPage(page({ site: "up", api: "up", git: "up", docs: "up", agents: "up" }), OPTIONS);
  assert.match(html, /<h1>All systems normal<\/h1>/);
  for (const name of ["Website and sign-in", "API", "Git and repositories", "Documentation", "Sandboxes"]) assert.ok(html.includes(name), name);
  assert.equal((html.match(/<ol class="bar"/g) ?? []).length, 5, "Sandboxes has no bar");
  assert.ok(html.includes("No incidents in the last 14 days"));
  assert.ok(html.includes('action="/subscribe"'), "a subscribe form");
  assert.ok(html.includes('href="/feed.xml"'));
  assert.match(html, /99\.86% uptime/);
  assert.match(html, /aria-label="g1t"/);
  assert.doesNotMatch(html, /Happening now/);
});

test("an outage and an open incident are said at the top, escaped", () => {
  const html = renderPage(
    page({ site: "down", api: "up", git: "up", docs: "up", agents: "up" }, [
      INCIDENT,
    ]),
    OPTIONS,
  );
  assert.match(html, /<h1>Major outage<\/h1>/);
  assert.match(html, /Happening now/);
  assert.ok(html.includes("Sign-in &lt;failing&gt;"));
  assert.ok(!html.includes("<failing>"));
  assert.match(html, /<p>A bad deploy\.<\/p><p>Rolling back\.<\/p>/);
  assert.match(html, /Identified · Major outage/);
  assert.ok(html.includes('href="/incidents/abc"'), "the title links to its page");
});

test("a stale page says the checks stopped", () => {
  const model = page({ api: "up" });
  const html = renderPage({ ...model, stale: true }, OPTIONS);
  assert.match(html, /have not run since/);
});

test("a day's detail names what happened", () => {
  assert.equal(
    dayDetail({ day: "2026-10-05", state: "up", uptime: 99.86, checks: 720, failed: 1, slow: 0, avg_ms: 100, incidents: ["Pushes failing"] }),
    "5 Oct 2026 · 99.86% answered · 1 failed check of 720 · average 100 ms · Incident: Pushes failing",
  );
  assert.equal(
    dayDetail({ day: "2026-10-01", state: "none", uptime: null, checks: 0, failed: 0, slow: 0, avg_ms: null, incidents: [] }),
    "1 Oct 2026 · No data",
  );
});

test("the badge is an SVG coloured by state", () => {
  const svg = renderBadge("degraded", "Partial outage");
  assert.match(svg, /^<svg/);
  assert.match(svg, /#ffbd8c/);
  assert.match(svg, /partial outage/);
});

test("maintenance: upcoming, then in progress with its parts under maintenance", () => {
  const ahead = renderPage(page({ site: "up", api: "up", git: "up" }, [], [MAINT]), OPTIONS);
  assert.ok(ahead.includes("Upcoming maintenance") && ahead.includes("Database upgrade") && !ahead.includes("Maintenance in progress"));
  const during = { ...OPTIONS, now: new Date("2026-10-06T02:30:00Z") };
  const model = buildPage({
    parts,
    current: new Map([["git", { state: "down" as const, detail: "Failed: HTTP 503", latency_ms: null }], ["site", { state: "up" as const, detail: "ok", latency_ms: 1 }]]),
    checkedAt: "2026-10-06T02:29:40Z",
    days: [],
    incidents: [],
    maintenance: [MAINT],
    now: during.now,
  });
  const html = renderPage(model, during);
  assert.ok(html.includes("Maintenance in progress"));
  assert.ok(html.includes("<h1>Under maintenance</h1>"));
  assert.ok(html.includes('class="state s-maintenance"'));
});

test("an incident's page: every update, its parts' impact, and the postmortem once published", () => {
  const names = new Map([["site", "Website and sign-in"]]);
  const resolved = { ...INCIDENT, status: "resolved" as const, resolved_at: "2026-10-05T12:40:00Z", postmortem_published_at: "2026-10-06T09:00:00Z" };
  const pm = { summary: "A deploy broke sign-in.", impact: "", timeline: "- 11:40 declared\n- 12:40 resolved", root_cause: "A <bad> cookie.", went_well: "", went_badly: "", action_items: "- Canary deploys", published_at: "2026-10-06T09:00:00Z" };
  const html = renderIncident(resolved, pm, names, { ...OPTIONS, selfUrl: resolved.url });
  assert.ok(html.includes('id="update-u1"'));
  assert.ok(html.includes("Website and sign-in"));
  assert.ok(html.includes("Major outage"));
  assert.ok(html.includes('id="postmortem"'));
  assert.ok(html.includes("<h3>Root cause</h3>") && html.includes("A &lt;bad&gt; cookie."));
  assert.ok(!html.includes("<h3>Impact</h3>"), "empty sections are left out");
  assert.ok(html.includes("<ul><li>Canary deploys</li></ul>"));
  assert.ok(html.includes("lasted 1h 00m"));
  const draft = renderIncident(resolved, null, names, OPTIONS);
  assert.ok(!draft.includes('id="postmortem"') && draft.includes("If a postmortem is written"));
});

test("prose: paragraphs and lists, escaped", () => {
  assert.equal(prose("One\ntwo\n\n- a\n- <b>"),"<p>One<br>two</p><ul><li>a</li><li>&lt;b&gt;</li></ul>");
});

test("history: months newest first, empty ones said so", () => {
  const old = { ...INCIDENT, id: "old", started_at: "2026-08-10T00:00:00Z", resolved_at: "2026-08-10T01:00:00Z" };
  const groups = byMonth([INCIDENT, old], [MAINT]);
  assert.deepEqual(groups.map((g) => g.month), ["2026-10", "2026-08"]);
  const html = renderHistory([INCIDENT, old], [MAINT], OPTIONS, 3);
  assert.ok(html.includes("October 2026") && html.includes("September 2026") && html.includes("August 2026"));
  assert.ok(html.includes("No incidents or maintenance."));
  assert.ok(html.indexOf("October 2026") < html.indexOf("August 2026"));
  assert.ok(html.includes('href="/maintenance/m1"'));
});

test("subscribe pages: the form, its parts, and a confirm button rather than a link that acts", () => {
  const html = renderSubscribe(OPTIONS, [{ key: "git", name: "Git" }]);
  assert.ok(html.includes('name="components" value="git"') && html.includes('name="website"'));
  assert.ok(renderSubscribe({ ...OPTIONS, email: false }, []).includes("not available"));
  const confirm = renderMessage(OPTIONS, { title: "Confirm", text: "One more step", form: { action: "/subscribe/confirm", fields: { token: 'a"b' }, button: "Confirm subscription" } });
  assert.ok(confirm.includes('method="post" action="/subscribe/confirm"') && confirm.includes('value="a&quot;b"'));
  assert.ok(renderMaintenance(MAINT, new Map([["git", "Git"]]), OPTIONS).includes("Affects Git"));
});
