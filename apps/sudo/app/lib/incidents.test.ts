import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeAudit, accountPath, accountName, statusAuditActions } from "./ledgers.ts";
import {
  duration,
  filterIncidents,
  incidentsHref,
  maintenanceList,
  median,
  nextStatus,
  parseFilters,
  phase,
  readImpacts,
  staffSuggestions,
  tabCounts,
  tabOf,
  utc,
  wantsNotify,
} from "./incidents.ts";
import { proseBlocks } from "./postmortem.ts";

const incident = (over: Record<string, unknown> = {}) =>
  ({
    title: "Pushes failing",
    severity: "sev2",
    visibility: "public",
    resolved_at: null,
    components: [{ key: "git", impact: "major_outage" }],
    status: "investigating",
    postmortem_published_at: null,
    ...over,
  }) as Parameters<typeof tabOf>[0] & Parameters<typeof phase>[0] & { title: string; severity: "sev2"; components: { key: string; impact: "major_outage" }[] };

test("filters come from the address; unknown values are dropped", () => {
  assert.deepEqual(parseFilters(new URLSearchParams("tab=drafts&severity=sev1&component=git&q=%20push%20")), { tab: "drafts", severity: "sev1", component: "git", q: "push" });
  assert.deepEqual(parseFilters(new URLSearchParams("tab=nope&severity=sev9&component=%3Cx%3E")), { tab: "open", severity: null, component: null, q: "" });
  assert.equal(incidentsHref({ tab: "open" }), "/incidents");
  assert.equal(incidentsHref({ tab: "resolved", severity: "sev1", q: "a b" }), "/incidents?tab=resolved&severity=sev1&q=a+b");
});

test("tabs: open, drafts, and resolved (dismissed drafts included)", () => {
  assert.equal(tabOf(incident()), "open");
  assert.equal(tabOf(incident({ visibility: "draft" })), "drafts");
  assert.equal(tabOf(incident({ resolved_at: "2026-10-05T00:00:00Z" })), "resolved");
  assert.equal(tabOf(incident({ visibility: "dismissed", resolved_at: "2026-10-05T00:00:00Z" })), "resolved");
  const list = [incident(), incident({ title: "Docs slow", severity: "sev3", components: [{ key: "docs", impact: "degraded" }] }), incident({ visibility: "draft" })];
  const all = { tab: "open" as const, severity: null, component: null, q: "" };
  assert.equal(filterIncidents(list, all).length, 2);
  assert.equal(filterIncidents(list, { ...all, severity: "sev3" }).length, 1);
  assert.equal(filterIncidents(list, { ...all, component: "git" }).length, 1);
  assert.equal(filterIncidents(list, { ...all, q: "DOCS" })[0]!.title, "Docs slow");
  assert.deepEqual(tabCounts(list, [{ state: "scheduled" }, { state: "completed" }]), { open: 2, maintenance: 1, resolved: 0, drafts: 1 });
});

test("maintenance: live first by start, then finished newest first", () => {
  const m = (id: string, state: string, starts_at: string) => ({ id, state, starts_at, components: ["git"] }) as never;
  assert.deepEqual(
    maintenanceList([m("done-old", "completed", "2026-09-01"), m("later", "scheduled", "2026-10-09"), m("done-new", "cancelled", "2026-10-01"), m("soon", "in_progress", "2026-10-05")], null).map((x: { id: string }) => x.id),
    ["soon", "later", "done-new", "done-old"],
  );
});

test("phase chips: draft, dismissed, postmortem, else the status", () => {
  assert.deepEqual(phase(incident({ visibility: "draft" })), { label: "Draft", tone: "lavender" });
  assert.equal(phase(incident({ visibility: "dismissed" })).label, "Dismissed");
  assert.equal(phase(incident({ postmortem_published_at: "x", status: "resolved" })).label, "Postmortem published");
  assert.deepEqual(phase(incident({ status: "monitoring" })), { label: "Monitoring", tone: "info" });
});

test("durations, medians and UTC times", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(59.6), "1m");
  assert.equal(duration(3 * 3600 + 5 * 60), "3h 05m");
  assert.equal(median([300, null, 100, 200]), 200);
  assert.equal(median([100, 200]), 150);
  assert.equal(median([null]), null);
  assert.equal(utc("2026-10-05T14:00"), "2026-10-05T14:00:00.000Z");
  assert.equal(utc(""), null);
  assert.equal(utc("garbage"), null);
});

test("forms: impacts per part, notify by severity, next status, staff suggestions", () => {
  const form = new FormData();
  form.set("impact.git", "partial_outage");
  form.set("impact.api", "");
  form.set("impact.docs", "bogus");
  assert.deepEqual(readImpacts(form, ["git", "api", "docs"]), [{ key: "git", impact: "partial_outage" }]);
  assert.equal(wantsNotify("auto", "sev1"), true);
  assert.equal(wantsNotify("auto", "sev3"), false);
  assert.equal(wantsNotify("yes", "sev4"), true);
  assert.equal(wantsNotify("no", "sev1"), false);
  assert.equal(nextStatus("investigating"), "identified");
  assert.equal(nextStatus("monitoring"), "resolved");
  assert.deepEqual(staffSuggestions("syntaqx@gmail.com, @g1t.sh", ["Ana@g1t.sh", null, "syntaqx@gmail.com"]), ["ana@g1t.sh", "syntaqx@gmail.com"]);
});

test("the status page's audit lines join the Audit log and link to their pages", () => {
  const lines = statusAuditActions([
    { id: "a1", at: "2026-10-05T12:00:00Z", by: "ana@g1t.sh", action: "incident_declared", target: "abc123", detail: "SEV2: Pushes failing" },
    { id: "a2", at: "2026-10-05T10:00:00Z", by: "ana@g1t.sh", action: "maintenance_scheduled", target: "m1", detail: "Upgrade" },
  ]);
  assert.equal(accountPath(lines[0]!.account), "/incidents/abc123");
  assert.equal(accountPath(lines[1]!.account), "/incidents/maintenance/m1");
  assert.equal(accountName(lines[0]!.account), "Incident");
  const billing = [{ id: "b", account: "ws_acme", action: "terms", detail: "", by: "x", createdAt: "2026-10-05T11:00:00Z" }];
  assert.deepEqual(mergeAudit(billing, lines).map((l) => l.id), ["status-a1", "b", "status-a2"]);
  assert.equal(mergeAudit(billing, lines, 2).length, 2);
});

test("the postmortem preview reads text as the status page does", () => {
  assert.deepEqual(proseBlocks("One\ntwo\n\n- a\n- b\n\n\n"), [
    { kind: "paragraph", text: "One\ntwo" },
    { kind: "list", items: ["a", "b"] },
  ]);
  assert.deepEqual(proseBlocks(""), []);
});
