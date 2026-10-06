import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type IncidentFacts,
  applyChange,
  applyRoles,
  checkChange,
  checkDeclare,
  checkMaintenance,
  checkMaintenanceChange,
  checkPostmortem,
  duration,
  durations,
  notifyByDefault,
  postmortemReady,
  shortId,
} from "./incidents.ts";
import { postmortemDraft, timelineText } from "./postmortem.ts";

const NOW = new Date("2026-10-05T12:00:00Z");
const KNOWN = ["git", "api", "docs"];
const base = {
  title: "  Pushes   failing ",
  severity: "sev2",
  message: "We are looking into it.\r\n\r\n\r\nMore soon.",
  components: [
    { key: "git", impact: "major_outage" },
    { key: "api", impact: "operational" },
  ],
  commander: " Ana@G1T.sh ",
  notify: true,
  by: "staff@g1t.sh",
};

test("declaring: cleaned and checked; operational parts are left out", () => {
  const checked = checkDeclare(base, KNOWN, NOW);
  assert.ok(checked.ok);
  assert.equal(checked.value.title, "Pushes failing");
  assert.equal(checked.value.status, "investigating");
  assert.equal(checked.value.message, "We are looking into it.\n\nMore soon.");
  assert.deepEqual(checked.value.components, [{ key: "git", impact: "major_outage" }]);
  assert.equal(checked.value.commander, "ana@g1t.sh");
  assert.equal(checked.value.started_at, null);
  assert.equal(checked.value.notify, true);
});

test("declaring is refused without what it needs", () => {
  assert.equal(checkDeclare({ ...base, title: "" }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, severity: "sev9" }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, status: "resolved" }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, components: [{ key: "git", impact: "operational" }] }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, components: [{ key: "nope", impact: "degraded" }] }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, components: [{ key: "git", impact: "meh" }] }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, commander: "not an email" }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, message: " " }, KNOWN, NOW).ok, false);
  assert.equal(checkDeclare({ ...base, started_at: "2026-10-06T00:00:00Z" }, KNOWN, NOW).ok, false);
  const backdated = checkDeclare({ ...base, started_at: "2026-10-05T11:00:00Z" }, KNOWN, NOW);
  assert.ok(backdated.ok && backdated.value.started_at === "2026-10-05T11:00:00.000Z");
});

test("severities: SEV1 and SEV2 email subscribers by default", () => {
  assert.deepEqual(
    (["sev1", "sev2", "sev3", "sev4"] as const).map(notifyByDefault),
    [true, true, false, false],
  );
});

test("an update needs words when it is public; a note can be just a change", () => {
  assert.equal(checkChange({ public: true, message: " ", by: "x" }, KNOWN).ok, false);
  const note = checkChange({ public: false, message: "", severity: "sev1", by: "x" }, KNOWN);
  assert.ok(note.ok && note.value.severity === "sev1" && note.value.notify === false);
  assert.equal(checkChange({ public: true, message: "ok", status: "panicking", by: "x" }, KNOWN).ok, false);
  assert.equal(checkChange({ public: true, message: "ok", impacts: [{ key: "zzz", impact: "degraded" }], by: "x" }, KNOWN).ok, false);
  const notify = checkChange({ public: false, message: "internal", notify: true, by: "x" }, KNOWN);
  assert.ok(notify.ok && notify.value.notify === false, "a note is never emailed");
});

const open: IncidentFacts = {
  status: "investigating",
  severity: "sev2",
  visibility: "public",
  components: [{ key: "git", impact: "major_outage" }],
  started_at: "2026-10-05T11:30:00.000Z",
  acknowledged_at: "2026-10-05T11:35:00.000Z",
  mitigated_at: null,
  resolved_at: null,
  commander: null,
  communications: null,
};
const names = new Map([["git", "Git and repositories"]]);

function change(input: Record<string, unknown>) {
  const checked = checkChange({ by: "staff@g1t.sh", ...input }, KNOWN);
  assert.ok(checked.ok, checked.ok ? "" : checked.error);
  return checked.value;
}

test("lifecycle: identified, then monitoring marks it mitigated, then resolved", () => {
  const a = applyChange(open, change({ public: true, status: "identified", message: "A bad deploy." }), NOW, names);
  assert.ok(a.ok);
  assert.equal(a.value.next.status, "identified");
  assert.equal(a.value.next.mitigated_at, null);
  assert.deepEqual(a.value.entries.map((e) => [e.kind, e.public]), [["status", false], ["update", true]]);
  assert.equal(a.value.entries[1]!.status, "identified");
  assert.equal(a.value.entries[0]!.text, "Investigating → Identified.");

  const b = applyChange(a.value.next, change({ public: true, status: "monitoring", message: "Rolled back." }), new Date("2026-10-05T12:10:00Z"));
  assert.ok(b.ok && b.value.next.mitigated_at === "2026-10-05T12:10:00.000Z");

  const c = applyChange(b.value.next, change({ public: true, status: "resolved", message: "Fixed." }), new Date("2026-10-05T12:40:00Z"));
  assert.ok(c.ok);
  assert.equal(c.value.next.resolved_at, "2026-10-05T12:40:00.000Z");
  assert.equal(c.value.next.mitigated_at, "2026-10-05T12:10:00.000Z", "mitigated keeps its first time");
  assert.deepEqual(durations(c.value.next), { to_acknowledge: 300, to_mitigate: 2400, to_resolve: 4200 });
});

test("lifecycle: resolving straight away marks it mitigated too; reopening clears resolved", () => {
  const done = applyChange(open, change({ public: true, status: "resolved", message: "It was a blip." }), NOW);
  assert.ok(done.ok && done.value.next.mitigated_at === NOW.toISOString() && done.value.next.resolved_at === NOW.toISOString());
  const again = applyChange(done.value.next, change({ public: true, status: "investigating", message: "It is back." }), NOW);
  assert.ok(again.ok);
  assert.equal(again.value.next.resolved_at, null);
  assert.match(again.value.entries[0]!.text, /^Reopened/);
});

test("lifecycle: a published incident's status changes only with public words", () => {
  const quiet = applyChange(open, change({ public: false, status: "identified", message: "Found it." }), NOW);
  assert.equal(quiet.ok, false);
  const note = applyChange(open, change({ public: false, message: "Paging the storage team." }), NOW);
  assert.ok(note.ok && note.value.entries.length === 1 && note.value.entries[0]!.kind === "note" && !note.value.entries[0]!.public);
  assert.equal(applyChange(open, change({ public: false, message: "" }), NOW).ok, false, "nothing to post");
});

test("lifecycle: severity and impact changes are written on the timeline", () => {
  const r = applyChange(open, change({ public: false, message: "", severity: "sev1", impacts: [{ key: "git", impact: "partial_outage" }, { key: "api", impact: "degraded" }] }), NOW, names);
  assert.ok(r.ok);
  assert.equal(r.value.next.severity, "sev1");
  assert.deepEqual(r.value.next.components, [{ key: "git", impact: "partial_outage" }, { key: "api", impact: "degraded" }]);
  assert.deepEqual(r.value.entries.map((e) => e.text), ["Severity SEV2 → SEV1.", "Git and repositories: Major outage → Partial outage.", "api: Operational → Degraded performance."]);
});

test("lifecycle: drafts take notes but nothing public; dismissed takes nothing; the first touch acknowledges", () => {
  const draft: IncidentFacts = { ...open, visibility: "draft", acknowledged_at: null };
  assert.equal(applyChange(draft, change({ public: true, message: "Hi" }), NOW).ok, false);
  const note = applyChange(draft, change({ public: false, message: "Looking.", status: "identified" }), NOW);
  assert.ok(note.ok);
  assert.equal(note.value.next.acknowledged_at, NOW.toISOString());
  assert.equal(note.value.entries[0]!.kind, "acknowledged");
  assert.equal(note.value.next.status, "identified", "a draft's status can move without words");
  assert.equal(applyChange({ ...open, visibility: "dismissed" }, change({ public: false, message: "x" }), NOW).ok, false);
});

test("roles: each change is a line, and nobody is said plainly", () => {
  const r = applyRoles({ ...open, commander: "ana@g1t.sh" }, { commander: null, communications: "bo@g1t.sh", by: "x" }, NOW);
  assert.deepEqual(r.entries.map((e) => e.text), ["Incident commander: nobody.", "Communications: bo@g1t.sh."]);
  assert.equal(applyRoles(open, { commander: null, communications: null, by: "x" }, NOW).entries.length, 0);
});

test("durations read plainly", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(42), "42s");
  assert.equal(duration(720), "12m");
  assert.equal(duration(7500), "2h 05m");
  assert.equal(duration(3 * 86400 + 4 * 3600), "3d 4h");
});

test("maintenance: a window in the future, under 72 hours, on known parts", () => {
  const m = { title: "Database upgrade", message: "Pushes pause for a few minutes.", components: ["git"], starts_at: "2026-10-06T02:00Z", ends_at: "2026-10-06T03:00Z", by: "x" };
  const checked = checkMaintenance(m, KNOWN, NOW);
  assert.ok(checked.ok && checked.value.ends_at === "2026-10-06T03:00:00.000Z");
  assert.equal(checkMaintenance({ ...m, ends_at: "2026-10-06T01:00Z" }, KNOWN, NOW).ok, false);
  assert.equal(checkMaintenance({ ...m, starts_at: "2026-10-04T01:00Z", ends_at: "2026-10-04T02:00Z" }, KNOWN, NOW).ok, false);
  assert.equal(checkMaintenance({ ...m, ends_at: "2026-10-10T03:00Z" }, KNOWN, NOW).ok, false);
  assert.equal(checkMaintenance({ ...m, components: [] }, KNOWN, NOW).ok, false);
  assert.equal(checkMaintenanceChange({ action: "update", message: "", by: "x" }).ok, false);
  assert.ok(checkMaintenanceChange({ action: "cancel", message: "", by: "x" }).ok);
});

test("postmortems: published only with a summary and a cause; the draft is filled from the incident", () => {
  const pm = checkPostmortem({ summary: "A deploy broke pushes.", impact: "", timeline: "", root_cause: "", went_well: "", went_badly: "", action_items: "", by: "x" });
  assert.ok(pm.ok);
  assert.match(postmortemReady(pm.value) ?? "", /caused/);
  assert.equal(postmortemReady({ ...pm.value, root_cause: "A missing index." }), null);

  const timeline = [
    { id: "1", at: "2026-10-05T11:35:00Z", by: "x", kind: "declared" as const, public: false, status: null, text: "Declared SEV2.", notified: null },
    { id: "2", at: "2026-10-05T11:36:00Z", by: "x", kind: "acknowledged" as const, public: false, status: null, text: "Acknowledged.", notified: null },
    { id: "3", at: "2026-10-05T11:40:00Z", by: "x", kind: "update" as const, public: true, status: "investigating" as const, text: "Pushes fail.\nLooking.", notified: 3 },
  ];
  assert.equal(timelineText(timeline), "- 5 Oct 11:35 UTC: Declared SEV2.\n- 5 Oct 11:40 UTC: Status page: Pushes fail. Looking.");
  const draft = postmortemDraft(
    { started_at: "2026-10-05T11:30:00Z", resolved_at: "2026-10-05T12:40:00Z", components: [{ key: "git", impact: "major_outage" }], durations: { to_acknowledge: 300, to_mitigate: null, to_resolve: 4200 } },
    timeline,
    [{ id: "f", title: "Alert on push errors", owner: "ana@g1t.sh", done_at: null, created_at: "", created_by: "" }],
    names,
  );
  assert.equal(draft.impact, "Git and repositories (major outage) affected for 1h 10m, from 5 Oct 11:30 UTC to 5 Oct 12:40 UTC.");
  assert.equal(draft.action_items, "- Alert on push errors");
});

test("short ids are ten unambiguous characters", () => {
  const id = shortId();
  assert.match(id, /^[a-km-np-z2-9]{10}$/);
  assert.notEqual(shortId(), id);
});
