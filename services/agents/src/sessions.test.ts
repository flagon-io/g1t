import assert from "node:assert/strict";
import { test } from "node:test";

import type { User } from "@g1t/contracts";

import { Audience, type AudienceInfo, type AudiencePorts, type RepoRef, WITHHELD } from "./audience.ts";
import { type MemoryViewer, type RecallPlace, changeableBy, cleanFact, memorySection, recallable, scopeFor, visibleTo } from "./memory.ts";
import { alertDue, checkPolicy, DEFAULT_POLICY, policyBlock } from "./policy.ts";
import { checkRoutine, checkSchedule, describeSchedule, nextRun } from "./schedule.ts";
import { type ActionPorts, type ToolPorts, MAX_SESSION_TOOL_CALLS, MAX_TOOL_CALLS, ToolBox } from "./tools.ts";
import { dollars } from "./money.ts";

// ── Memory: where a fact is recalled, who sees it, who changes it ───────

const dmWithAnn: RecallPlace = { channel_id: "chn_dm_ann", kind: "dm", people: ["ann"] };
const groupDm: RecallPlace = { channel_id: "chn_dm_group", kind: "dm", people: ["ann", "bob"] };
const privateOps: RecallPlace = { channel_id: "chn_ops", kind: "private", people: ["ann", "bob"] };
const publicGeneral: RecallPlace = { channel_id: "chn_general", kind: "public", people: ["ann"] };

test("a person's fact is recalled only in a direct message with that one person", () => {
  const fact = { scope: "person", scope_ref: "ann" };
  assert.equal(recallable(fact, dmWithAnn), true);
  assert.equal(recallable(fact, groupDm), false, "not with Bob there too");
  assert.equal(recallable(fact, privateOps), false);
  assert.equal(recallable(fact, publicGeneral), false);
  assert.equal(recallable(fact, { channel_id: "chn_dm_bob", kind: "dm", people: ["bob"] }), false);
});

test("a conversation's fact stays in it; a workspace fact goes anywhere", () => {
  assert.equal(recallable({ scope: "channel", scope_ref: "chn_ops" }, privateOps), true);
  assert.equal(recallable({ scope: "channel", scope_ref: "chn_ops" }, publicGeneral), false);
  assert.equal(recallable({ scope: "workspace", scope_ref: "" }, dmWithAnn), true);
  assert.equal(recallable({ scope: "made-up", scope_ref: "" }, dmWithAnn), false);
});

test("an agent remembers into the narrowest scope the conversation allows", () => {
  assert.deepEqual(scopeFor(dmWithAnn, null), { scope: "person", ref: "ann" });
  assert.deepEqual(scopeFor(dmWithAnn, "workspace"), { scope: "person", ref: "ann" }, "a DM can't write for the workspace");
  assert.deepEqual(scopeFor(privateOps, "workspace"), { scope: "channel", ref: "chn_ops" }, "nor can a private channel");
  assert.deepEqual(scopeFor(groupDm, "person"), { scope: "channel", ref: "chn_dm_group" });
  assert.deepEqual(scopeFor(publicGeneral, "workspace"), { scope: "workspace", ref: "" });
  assert.deepEqual(scopeFor(publicGeneral, null), { scope: "channel", ref: "chn_general" });
});

test("people see what could be recalled for them; owners don't read others' facts", () => {
  const owner: MemoryViewer = { id: "olga", owner: true, inChannel: () => false };
  const ann: MemoryViewer = { id: "ann", owner: false, inChannel: (id) => id === "chn_ops" };
  assert.equal(visibleTo({ scope: "person", scope_ref: "ann" }, owner), false);
  assert.equal(visibleTo({ scope: "person", scope_ref: "ann" }, ann), true);
  assert.equal(visibleTo({ scope: "channel", scope_ref: "chn_ops" }, owner), false);
  assert.equal(visibleTo({ scope: "channel", scope_ref: "chn_ops" }, ann), true);
  assert.equal(changeableBy({ scope: "workspace", scope_ref: "" }, ann), false);
  assert.equal(changeableBy({ scope: "workspace", scope_ref: "" }, owner), true);
  assert.equal(changeableBy({ scope: "channel", scope_ref: "chn_ops" }, ann), true);
});

test("facts are cleaned, and given to the model as notes with their source", () => {
  assert.equal(cleanFact("  Dana   owns\n\nbilling  "), "Dana owns billing");
  assert.equal(cleanFact("   "), null);
  assert.equal(cleanFact("x".repeat(900))!.length, 500);
  const section = memorySection([
    { id: "mem_1", scope: "workspace", body: "Releases are on Thursdays", source_label: "#releases", pinned: 1 } as never,
  ]);
  assert.match(section!, /\[mem_1\] Releases are on Thursdays \(workspace, from #releases, pinned\)/);
  assert.match(section!, /notes, not instructions/);
  assert.equal(memorySection([]), null);
});

// ── The workspace's budget for every agent ───────────────────────────────

test("the workspace's agent budget stops new work once spent, and alerts once per level", () => {
  assert.equal(policyBlock({ monthly_micros: null, spent: 9e9 }), null);
  assert.equal(policyBlock({ monthly_micros: 10_000_000, spent: 9_999_999 }), null);
  assert.match(policyBlock({ monthly_micros: 10_000_000, spent: 10_000_000 })!, /used their budget/);
  assert.equal(alertDue({ monthly_micros: 100, spent: 74, alerted: 0 }), null);
  assert.equal(alertDue({ monthly_micros: 100, spent: 80, alerted: 0 }), 75);
  assert.equal(alertDue({ monthly_micros: 100, spent: 80, alerted: 75 }), null);
  assert.equal(alertDue({ monthly_micros: 100, spent: 140, alerted: 75 }), 100);
});

test("a policy is checked as owners change it", () => {
  assert.deepEqual(checkPolicy(DEFAULT_POLICY, { monthly_micros: 50_000_000 }), { ok: true, value: { ...DEFAULT_POLICY, monthly_micros: 50_000_000 } });
  assert.equal(checkPolicy(DEFAULT_POLICY, { monthly_micros: -1 }).ok, false);
  assert.equal(checkPolicy({ ...DEFAULT_POLICY, monthly_micros: 5 }, { monthly_micros: null }).ok && true, true);
  assert.equal(checkPolicy(DEFAULT_POLICY, { default_session_micros: 10 }).ok, false);
});

// ── Routines ──────────────────────────────────────────────────────────────

test("routines run at the next matching time, in UTC", () => {
  const at = (s: string) => new Date(s);
  // Wednesday 2026-10-07 10:30 UTC.
  const now = at("2026-10-07T10:30:00Z");
  assert.equal(nextRun({ every: "hour", minute: 15, hour: 0, weekday: 0 }, now).toISOString(), "2026-10-07T11:15:00.000Z");
  assert.equal(nextRun({ every: "hour", minute: 45, hour: 0, weekday: 0 }, now).toISOString(), "2026-10-07T10:45:00.000Z");
  assert.equal(nextRun({ every: "day", minute: 0, hour: 9, weekday: 0 }, now).toISOString(), "2026-10-08T09:00:00.000Z");
  assert.equal(nextRun({ every: "day", minute: 0, hour: 12, weekday: 0 }, now).toISOString(), "2026-10-07T12:00:00.000Z");
  // Friday evening: the next weekday is Monday.
  assert.equal(nextRun({ every: "weekday", minute: 0, hour: 9, weekday: 0 }, at("2026-10-09T18:00:00Z")).toISOString(), "2026-10-12T09:00:00.000Z");
  assert.equal(nextRun({ every: "week", minute: 30, hour: 8, weekday: 1 }, now).toISOString(), "2026-10-12T08:30:00.000Z");
  assert.equal(describeSchedule({ every: "weekday", minute: 5, hour: 9, weekday: 0 }), "Every weekday at 09:05 UTC");
});

test("routines and schedules are checked", () => {
  assert.equal(checkSchedule({ every: "fortnight" }).ok, false);
  assert.equal(checkSchedule({ every: "day", hour: 24 }).ok, false);
  assert.deepEqual(checkSchedule({ every: "day" }), { ok: true, value: { every: "day", minute: 0, hour: 9, weekday: 1 } });
  assert.equal(checkRoutine({ name: "", instructions: "Summarise support", schedule: { every: "day", minute: 0, hour: 9, weekday: 1 }, channel_id: "c" }).ok, false);
  assert.equal(checkRoutine({ name: "Digest", instructions: "short", schedule: { every: "day", minute: 0, hour: 9, weekday: 1 }, channel_id: "c" }).ok, false);
  assert.equal(checkRoutine({ name: "Digest", instructions: "Summarise this week's support themes", schedule: { every: "day", minute: 0, hour: 9, weekday: 1 }, channel_id: "c" }).ok, true);
});

test("money reads as people expect", () => {
  assert.equal(dollars(140_000), "$0.14");
  assert.equal(dollars(2_000_000), "$2.00");
  assert.equal(dollars(3_000), "<$0.01");
  assert.equal(dollars(1_204_000_000), "$1,204");
});

// ── Tools that act ────────────────────────────────────────────────────────

const WEB: RepoRef = { id: "rep_web", namespace: "acme", name: "web", isPrivate: true, defaultBranch: "main" };
const readPorts = {
  readFile: async () => null,
  searchCode: async () => [],
  listIssues: async () => [],
  getIssue: async () => null,
  getPull: async () => null,
  recentPulls: async () => [],
  searchMessages: async () => [],
  readThread: async () => null,
  roster: async () => "",
  consult: async () => ({ ok: false as const, message: "no" }),
} satisfies ToolPorts;

function audienceWorld(info: AudienceInfo, people: User[], reads: Record<string, string[]>): AudiencePorts {
  return {
    info: async () => info,
    users: async (ids) => people.filter((u) => ids.includes(u.id)),
    workspaceRepos: async (viewer) => (reads[viewer.id] ?? []).includes(WEB.id) ? [WEB] : [],
    readable: async (ids, viewer) => (ids.includes(WEB.id) && (reads[viewer.id] ?? []).includes(WEB.id) ? [WEB] : []),
  };
}

const member = (id: string, code = true): User => ({ id, username: id, workspaces: [{ slug: "acme", role: "member", code_access: code }] }) as User;

function actions(log: string[]): ActionPorts {
  return {
    remember: async (body) => (log.push(`remember:${body}`), { ok: true, message: "ok" }),
    forget: async () => ({ ok: true, message: "ok" }),
    draftIssue: async (repo, input) => (log.push(`draft:${repo.name}:${input.title}`), { ok: true, message: "drafted" }),
    startSession: async (title) => (log.push(`session:${title}`), { ok: true, message: "started" }),
    postUpdate: async () => ({ ok: true, message: "posted" }),
    useSubagent: async () => ({ ok: true, message: "on it" }),
    bringIn: async () => ({ ok: true, message: "on it" }),
  };
}

const ctx = { agentId: "agt_me", notConsult: ["me"], hops: 0, maxHops: 6 };

test("a reply can spin off a session and draft an issue; a session can't spin off", async () => {
  const log: string[] = [];
  const audience = await Audience.build("acme", "ann", audienceWorld({ kind: "dm", member_user_ids: ["ann"], member_count: 1 }, [member("ann")], { ann: [WEB.id] }));
  const reply = new ToolBox(audience, readPorts, ctx, [], actions(log));
  const names = reply.definitions().map((t) => t.name);
  assert.ok(names.includes("start_session") && names.includes("draft_issue") && names.includes("remember"));
  assert.ok(!names.includes("bring_in") && !names.includes("use_subagent") && !names.includes("post_update"));
  const drafted = await reply.run("draft_issue", { repo: "web", title: "CSV export times out", body: "Over 100k rows." });
  assert.equal(drafted.outcome, "allowed");
  assert.deepEqual(log, ["draft:web:CSV export times out"]);
  // A repository the audience can't read is withheld, never named.
  const hidden = await reply.run("draft_issue", { repo: "acme/secret", title: "x", body: "y" });
  assert.equal(hidden.text, WITHHELD);

  const session = new ToolBox(audience, readPorts, { ...ctx, session: true }, [], actions(log));
  const inSession = session.definitions().map((t) => t.name);
  assert.ok(!inSession.includes("start_session"));
  assert.ok(inSession.includes("bring_in") && inSession.includes("use_subagent") && inSession.includes("post_update"));
  assert.equal((await session.run("start_session", { title: "x", goal: "y" })).outcome, "refused");
  assert.equal(reply.maxCalls, MAX_TOOL_CALLS);
  assert.equal(session.maxCalls, MAX_SESSION_TOOL_CALLS);
});

test("nobody drafts issues for someone who can't read code, and no hand-offs at the hop limit", async () => {
  const log: string[] = [];
  const noCode = await Audience.build("acme", "cal", audienceWorld({ kind: "dm", member_user_ids: ["cal"], member_count: 1 }, [member("cal", false)], { cal: [WEB.id] }));
  const box = new ToolBox(noCode, readPorts, ctx, [], actions(log));
  assert.ok(!box.definitions().some((t) => t.name === "draft_issue"));
  assert.equal((await box.run("draft_issue", { repo: "web", title: "x", body: "y" })).outcome, "refused");
  assert.deepEqual(log, []);
  const audience = await Audience.build("acme", "ann", audienceWorld({ kind: "dm", member_user_ids: ["ann"], member_count: 1 }, [member("ann")], { ann: [WEB.id] }));
  const atLimit = new ToolBox(audience, readPorts, { ...ctx, session: true, hops: 6 }, [], actions(log));
  assert.ok(!atLimit.definitions().some((t) => t.name === "bring_in" || t.name === "use_subagent"));
  // The agent can't bring itself in.
  const session = new ToolBox(audience, readPorts, { ...ctx, session: true }, [], actions(log));
  assert.equal((await session.run("bring_in", { handle: "@me", brief: "help" })).outcome, "refused");
});

test("updates are limited per step", async () => {
  const audience = await Audience.build("acme", "ann", audienceWorld({ kind: "dm", member_user_ids: ["ann"], member_count: 1 }, [member("ann")], { ann: [WEB.id] }));
  const session = new ToolBox(audience, readPorts, { ...ctx, session: true }, [], actions([]));
  for (let i = 0; i < 3; i++) assert.equal((await session.run("post_update", { text: `step ${i}` })).outcome, "allowed");
  assert.equal((await session.run("post_update", { text: "again" })).outcome, "refused");
});

// ── Routines that run when something happens ─────────────────────────────

import { describeEvents, suggestRoutines } from "./suggest.ts";
import { checkRoutine as checkEventRoutine } from "./schedule.ts";

test("Margo's responsibilities suggest the routines that bind to events", () => {
  const margo = ["Reviewing pull requests for risk and test coverage", "Test plans for new features", "Chasing flaky checks"];
  const suggested = suggestRoutines(margo, []);
  assert.deepEqual(
    suggested.map((s) => [s.routine.name, s.routine.events]),
    [
      ["Review pull requests", ["pull_ready"]],
      ["Test plans for new work", ["issue_opened"]],
      ["Chase failing checks", ["checks_failed"]],
    ],
  );
  assert.match(suggested[0].routine.instructions, /risk and test coverage/);
  // What it already runs on isn't suggested again.
  assert.deepEqual(
    suggestRoutines(margo, [{ name: "PR reviews", events: ["pull_ready"] }]).map((s) => s.routine.name),
    ["Test plans for new work", "Chase failing checks"],
  );
  assert.deepEqual(suggestRoutines(["Keep the office plants alive"], []), []);
});

test("an event routine needs no schedule, but a routine needs one or the other", () => {
  const base = { name: "Review", instructions: "Review pull requests for risk", channel_id: "chn_qa" };
  assert.equal(checkEventRoutine({ ...base, schedule: null, events: ["pull_ready"] }).ok, true);
  assert.equal(checkEventRoutine({ ...base, schedule: null, events: [] }).ok, false);
  assert.equal(checkEventRoutine({ ...base, schedule: null, events: ["pull_exploded" as never] }).ok, false);
  assert.equal(checkEventRoutine({ ...base, schedule: null, events: ["pull_ready"], repos: ["not a repo"] }).ok, false);
  const ok = checkEventRoutine({ ...base, schedule: null, events: ["pull_ready", "pull_ready"], repos: ["Acme/Web"] });
  assert.ok(ok.ok && ok.value.events.length === 1 && ok.value.repos[0] === "acme/web");
  assert.equal(describeEvents(["pull_ready", "checks_failed"]), "When a pull request is ready for review or checks fail on a pull request");
});

test("agents comment and review on issues and pull requests only where the asker can read", async () => {
  const log: string[] = [];
  const ports = {
    ...actions(log),
    comment: async (repo: RepoRef, asker: User, number: number) => (log.push(`comment:${repo.name}#${number}:${asker.username}`), { ok: true, message: "ok" }),
    review: async (repo: RepoRef, asker: User, number: number, verdict: string) => (log.push(`review:${repo.name}#${number}:${verdict}:${asker.username}`), { ok: true, message: "ok" }),
  };
  const audience = await Audience.build("acme", "ann", audienceWorld({ kind: "dm", member_user_ids: ["ann"], member_count: 1 }, [member("ann")], { ann: [WEB.id] }));
  const session = new ToolBox(audience, readPorts, { ...ctx, session: true }, [], ports);
  assert.ok(session.definitions().some((t) => t.name === "review_pull"));
  await session.run("review_pull", { repo: "web", number: 12, verdict: "approve", body: "" });
  await session.run("review_pull", { repo: "web", number: 12, verdict: "made-up", body: "Looks risky" });
  await session.run("comment", { repo: "web", number: 3, body: "Test plan: …" });
  assert.equal((await session.run("comment", { repo: "acme/secret", number: 3, body: "x" })).text, WITHHELD);
  assert.deepEqual(log, ["review:web#12:approve:ann", "review:web#12:comment:ann", "comment:web#3:ann"]);
  const noCode = await Audience.build("acme", "cal", audienceWorld({ kind: "dm", member_user_ids: ["cal"], member_count: 1 }, [member("cal", false)], { cal: [WEB.id] }));
  assert.ok(!new ToolBox(noCode, readPorts, { ...ctx, session: true }, [], ports).definitions().some((t) => t.name === "comment" || t.name === "review_pull"));
});

// ── Docs, for everyone ───────────────────────────────────────────────────

import { pageId } from "./tools.ts";

test("someone without Code still gets Docs; what they can't read is withheld, never named", async () => {
  const asked: string[] = [];
  const docs = {
    spaces: async () => "- General (id spc_1, workspace; you can suggest edits)",
    search: async (_v: User, audience: unknown, query: string) => (asked.push(`search:${query}:${JSON.stringify(audience)}`), "- Refunds policy (/acme/-/docs/general/refunds-pag_1, id pag_1)"),
    read: async (_v: User, _a: unknown, page: string) => (page === "pag_secret" ? null : "# Refunds policy"),
    edit: async () => ({ ok: true, message: "Suggested" }),
    create: async () => ({ ok: true, message: "Wrote" }),
  };
  const rep = await Audience.build("acme", "cal", audienceWorld({ kind: "dm", member_user_ids: ["cal"], member_count: 1 }, [member("cal", false)], {}));
  const box = new ToolBox(rep, { ...readPorts, docs }, ctx, [], actions([]));
  const names = box.definitions().map((t) => t.name);
  assert.ok(names.includes("search_docs") && names.includes("read_page") && names.includes("edit_page") && names.includes("create_page"));
  assert.ok(!names.includes("read_file"), "still no code");
  await box.run("search_docs", { query: "refund window" });
  assert.deepEqual(asked, ['search:refund window:{"kind":"people","user_ids":["cal"]}']);
  assert.equal((await box.run("read_page", { page: "pag_secret" })).text, WITHHELD);
  assert.match((await box.run("read_page", { page: "/acme/-/docs/general/refunds-pag_1" })).text, /Refunds policy/);
  assert.equal((await box.run("edit_page", { page: "pag_1", target: "section", markdown: "x" })).outcome, "refused", "a section edit names its heading");
  // Without a docs service, no docs tools.
  assert.ok(!new ToolBox(rep, readPorts, ctx, [], actions([])).definitions().some((t) => t.name === "search_docs"));
});

test("page ids come from ids or links", () => {
  assert.equal(pageId("pag_01jabc"), "pag_01jabc");
  assert.equal(pageId("/acme/-/docs/general/refunds-policy-pag_01jabc"), "pag_01jabc");
  assert.equal(pageId("https://g1t.sh/acme/-/docs/general/refunds-pag_01jabc?x=1"), "pag_01jabc");
  assert.equal(pageId("   "), null);
});

test("a technical writer's duties suggest keeping the docs current when a pull request merges", () => {
  const inky = ["Update the docs after every change that makes them wrong", "Turn decisions made in chat into pages", "Write release notes and the weekly summary"];
  const names = suggestRoutines(inky, []).map((s) => [s.routine.name, s.routine.events]);
  assert.deepEqual(names[0], ["Keep the docs current", ["pull_merged"]]);
  assert.ok(names.some(([name]) => name === "Weekly summary"));
});
