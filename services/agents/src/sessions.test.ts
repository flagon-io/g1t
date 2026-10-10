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
  // After reading an artifact the whole workspace can't: the asker's alone, wherever it is.
  assert.deepEqual(scopeFor(publicGeneral, "workspace", "ann"), { scope: "person", ref: "ann" });
  assert.deepEqual(scopeFor(privateOps, null, "ann"), { scope: "person", ref: "ann" });
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

test("hand_off: offered from chat, never in a session or at the hop limit; not to itself or its sender; two per reply", async () => {
  const log: string[] = [];
  const handing: ActionPorts = { ...actions(log), handOff: async (handle, brief) => (log.push(`hand_off:${handle}:${brief}`), { ok: true, message: "handed" }) };
  const audience = await Audience.build("acme", "ann", audienceWorld({ kind: "dm", member_user_ids: ["ann"], member_count: 1 }, [member("ann")], { ann: [WEB.id] }));
  const reply = new ToolBox(audience, readPorts, { ...ctx, notConsult: ["me", "g1t"] }, [], handing);
  const names = reply.definitions().map((t) => t.name);
  assert.ok(names.includes("hand_off") && names.includes("ask_colleague"));
  const descriptions = Object.fromEntries(reply.definitions().map((t) => [t.name, t.description]));
  assert.match(descriptions.hand_off, /only way to get a colleague working: an @mention in your message wakes nobody/);
  assert.match(descriptions.ask_colleague, /quick question, privately/);
  assert.match(descriptions.ask_colleague, /To give them the work itself, use hand_off/);
  assert.equal((await reply.run("hand_off", { handle: "@me", brief: "x" })).outcome, "refused", "not to itself");
  assert.equal((await reply.run("hand_off", { handle: "g1t", brief: "x" })).outcome, "refused", "not back to the one that sent it");
  assert.equal((await reply.run("hand_off", { handle: "mike", brief: "" })).outcome, "refused", "a brief is needed");
  assert.equal((await reply.run("hand_off", { handle: "@Mike", brief: "Draft the role brief." })).outcome, "allowed");
  assert.equal((await reply.run("hand_off", { handle: "dot", brief: "Plan it." })).outcome, "allowed");
  assert.equal((await reply.run("hand_off", { handle: "sam", brief: "Tell them." })).outcome, "refused", "two per reply");
  assert.deepEqual(log, ["hand_off:mike:Draft the role brief.", "hand_off:dot:Plan it."]);
  // Not in a session (bring_in is), and not at the hop limit.
  assert.ok(!new ToolBox(audience, readPorts, { ...ctx, session: true }, [], handing).definitions().some((t) => t.name === "hand_off"));
  assert.ok(!new ToolBox(audience, readPorts, { ...ctx, hops: 6 }, [], handing).definitions().some((t) => t.name === "hand_off"));
  // Without the port (an old chat), it isn't offered.
  assert.ok(!new ToolBox(audience, readPorts, ctx, [], actions(log)).definitions().some((t) => t.name === "hand_off"));
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

/// ── Artifacts, for everyone ──────────────────────────────────────────────

import type { FolioAgentRead, FolioRef } from "@g1t/contracts";

import { type FoliosPorts, folioReadText, folioRef, sourceLink } from "./tools.ts";

const FOL = "fol_01jabcdefghjkmnpqrstvwxyz0";
const SECRET = "fol_01jabcdefghjkmnpqrstvwxyz1";
const NEW = "fol_01jabcdefghjkmnpqrstvwxyz2";

const ref = (id: string, title: string): FolioRef => ({ id, kind: "doc", title, icon: null, slug: `x-${id}`, path: `/acme/-/artifacts/x-${id}` });

const agentRead = (id: string, title: string, content: string, audience_can_read: boolean): FolioAgentRead => ({
  folio: { ...ref(id, title), edited_at: "2026-10-01T10:00:00Z" },
  space: { id: "spc_general", slug: "general", name: "General", agent_mode: "suggest" },
  content,
  blocks: [{ id: "b1", type: "heading", level: 1, markdown: `# ${title}` }],
  can: { read: true, suggest: true, edit: false },
  audience_can_read,
});

/** An artifacts service with one readable doc, one secret one, and whatever is made (readable here unless `hidden` says so). */
function folioWorld(log: string[], options: { hidden?: Set<string>; forbidden?: string } = {}): FoliosPorts {
  const hidden = options.hidden ?? new Set<string>();
  return {
    spaces: async () => [
      { id: "spc_general", slug: "general", name: "General", description: null, kind: "workspace", projects: [], can: { read: true, suggest: true, edit: false } },
      { id: "spc_eng", slug: "engineering", name: "Engineering", description: "How we build", kind: "team", projects: ["acme/web"], can: { read: true, suggest: true, edit: true } },
    ],
    recall: async () => [],
    search: async (_v, audience, input) => (log.push(`search:${input.query}:${JSON.stringify(audience)}:${input.space_id}:${input.kind}`), `- Refunds policy (/acme/-/artifacts/x-${FOL}, id ${FOL})`),
    read: async (_v, _a, id) => {
      if (id === FOL) return { ok: true, value: agentRead(FOL, "Refunds policy", "# Refunds policy\n\n30 days.", true) };
      if (id === SECRET) return { ok: true, value: agentRead(SECRET, "Salary bands", "Bands: 1, 2, 3", false) };
      if (id === NEW) return { ok: true, value: agentRead(NEW, "Made", "x", !hidden.has("new")) };
      return { ok: false, code: "not_found", message: "No such artifact." };
    },
    stale: async () => "No artifacts are marked possibly out of date.",
    async create(_v, input) {
      log.push(`create:${input.kind}:${JSON.stringify(input.where)}:${input.source?.href ?? ""}`);
      const where = input.where;
      if (options.forbidden && typeof where === "object" && "space_id" in where && where.space_id === options.forbidden) return { ok: false, code: "forbidden", message: "ann can't add there." };
      return { ok: true, value: ref(NEW, input.title) };
    },
    edit: async (_v, id, edit) => (log.push(`edit:${id}:${edit.kind}`), { ok: true, value: { mode: "suggested", suggestion: {} as never, folio: id === SECRET ? ref(SECRET, "Salary bands") : ref(id, "Refunds policy") } }),
    share: async (_v, _a, id, users, role) => (log.push(`share:${id}:${users.join(",")}:${role}`), { ok: true, value: null }),
    sendLink: async (asker, link) => (log.push(`dm:${asker.username}:${link.path}`), true),
  };
}

const dmWithCal = () => Audience.build("acme", "cal", audienceWorld({ kind: "dm", member_user_ids: ["cal"], member_count: 1 }, [member("cal", false)], {}));
const annAndBob = () => Audience.build("acme", "ann", audienceWorld({ kind: "private", member_user_ids: ["ann", "bob"], member_count: 2 }, [member("ann"), member("bob")], {}));
const publicChannel = () => Audience.build("acme", "ann", audienceWorld({ kind: "public", member_user_ids: ["ann"], member_count: 30 }, [member("ann")], {}));

test("someone without Code still gets artifacts; what they can't read is withheld, never named", async () => {
  const log: string[] = [];
  const box = new ToolBox(await dmWithCal(), { ...readPorts, folios: folioWorld(log) }, ctx, [], actions([]));
  const names = box.definitions().map((t) => t.name);
  for (const name of ["search_artifacts", "read_artifact", "list_spaces", "stale_artifacts", "create_artifact", "edit_artifact", "share_artifact"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("read_file"), "still no code");
  assert.ok(!names.includes("query_data"), "not until dashboards");
  assert.ok(box.definitions().filter((t) => t.name.endsWith("_artifact") || t.name.endsWith("_artifacts")).every((t) => /not a workflow run's build artifacts/.test(t.description)));
  await box.run("search_artifacts", { query: "refund window", kind: "doc", space: "engineering" });
  assert.deepEqual(log, ['search:refund window:{"kind":"people","user_ids":["cal"]}:spc_eng:doc']);
  assert.equal((await box.run("search_artifacts", { query: "refunds", space: "Secret space" })).text, WITHHELD);
  assert.equal((await box.run("search_artifacts", { query: "refunds", kind: "spreadsheet" })).outcome, "refused");
  assert.equal((await box.run("read_artifact", { id: "fol_01jabcdefghjkmnpqrstvwxyz9" })).text, WITHHELD);
  const read = (await box.run("read_artifact", { id: `https://g1t.sh/acme/-/artifacts/refunds-policy-${FOL}?v=2` })).text;
  assert.match(read, /Refunds policy/);
  assert.match(read, /Top-level blocks: b1 heading 1/);
  assert.match(read, /you can suggest edits/);
  assert.match((await box.run("list_spaces", {})).text, /- Engineering \(id spc_eng, team; you can edit; about acme\/web\): How we build/);
  assert.equal((await box.run("edit_artifact", { id: FOL, target: "section", markdown: "x" })).outcome, "refused", "a section edit names its heading");
  // The old Docs tools are gone.
  assert.equal((await box.run("search_docs", { query: "refunds" })).outcome, "refused");
  // Without an artifacts service, no artifact tools.
  assert.ok(!new ToolBox(await dmWithCal(), readPorts, ctx, [], actions([])).definitions().some((t) => t.name === "search_artifacts"));
});

test("artifact ids come from ids or any artifact link", () => {
  assert.equal(folioRef(FOL), FOL);
  assert.equal(folioRef(`/acme/-/artifacts/refunds-policy-${FOL}`), FOL);
  assert.equal(folioRef(`https://g1t.sh/acme/-/artifacts/refunds-policy-${FOL}?x=1#h`), FOL);
  assert.equal(folioRef(`/acme/-/artifacts/${FOL}/`), FOL);
  assert.equal(folioRef("/acme/-/docs/general/refunds-pag_01jabc"), null, "an old Docs page is not an artifact");
  assert.equal(folioRef("fol_short"), null);
  assert.equal(folioRef("   "), null);
  assert.deepEqual(sourceLink("https://g1t.sh/acme/-/chat/c/general?thread=msg_1"), { title: "A conversation", href: "/acme/-/chat/c/general?thread=msg_1" });
  assert.deepEqual(sourceLink("/acme/-/chat/c/general?thread=msg_1"), { title: "A conversation", href: "/acme/-/chat/c/general?thread=msg_1" });
  assert.equal(sourceLink("//evil.example/x"), null);
  assert.equal(sourceLink("javascript:alert(1)"), null);
  assert.equal(sourceLink(""), null);
});

test("only docs can be made for now: other kinds answer plainly and make nothing", async () => {
  const log: string[] = [];
  const box = new ToolBox(await dmWithCal(), { ...readPorts, folios: folioWorld(log) }, ctx, [], actions([]));
  for (const kind of ["slides", "design", "dashboard"]) {
    const made = await box.run("create_artifact", { kind, title: "Q4 roadmap", content: "# Q4" });
    assert.equal(made.outcome, "refused");
    assert.match(made.text, /Slides, designs and dashboards aren't available yet: only docs can be made for now/);
  }
  assert.equal((await box.run("create_artifact", { kind: "spreadsheet", title: "x", content: "x" })).outcome, "refused");
  assert.deepEqual(log, [], "nothing was made");
  assert.equal((await box.run("create_artifact", { kind: "doc", title: "Q4 roadmap", content: "# Q4" })).outcome, "allowed");
  assert.deepEqual(log, ['create:doc:"private":'], "a DM with one person: their Private");
});

test("where a written-up doc goes: the conversation, a space, Private, or the General space in public", async () => {
  const log: string[] = [];
  const box = new ToolBox(await annAndBob(), { ...readPorts, folios: folioWorld(log) }, ctx, [], actions([]));
  const make = (where: unknown, source?: string) => box.run("create_artifact", { kind: "doc", title: "Decision", content: "We ship Thursday.", where, source });
  assert.match((await make(undefined)).text, new RegExp(`Wrote Decision \\(/acme/-/artifacts/x-${NEW}, id ${NEW}\\)`));
  await make("conversation", "https://g1t.sh/acme/-/chat/c/ops?thread=msg_9");
  await make("private");
  await make({ space: "Engineering" });
  await make("engineering");
  assert.deepEqual(log, [
    'create:doc:{"conversation":["ann","bob"]}:',
    'create:doc:{"conversation":["ann","bob"]}:/acme/-/chat/c/ops?thread=msg_9',
    'create:doc:"private":',
    'create:doc:{"space_id":"spc_eng"}:',
    'create:doc:{"space_id":"spc_eng"}:',
  ]);
  assert.equal((await make({ space: "Nowhere" })).outcome, "refused");

  // In a public channel there is no list of people: the General space, else Private.
  const pub: string[] = [];
  const open = new ToolBox(await publicChannel(), { ...readPorts, folios: folioWorld(pub) }, ctx, [], actions([]));
  await open.run("create_artifact", { kind: "doc", title: "Decision", content: "x" });
  await open.run("create_artifact", { kind: "doc", title: "Decision", content: "x", where: "conversation" });
  assert.deepEqual(pub, ['create:doc:{"space_id":"spc_general"}:', 'create:doc:{"space_id":"spc_general"}:']);
  const barred: string[] = [];
  const noGeneral = new ToolBox(await publicChannel(), { ...readPorts, folios: folioWorld(barred, { forbidden: "spc_general", hidden: new Set(["new"]) }) }, ctx, [], actions([]));
  const made = await noGeneral.run("create_artifact", { kind: "doc", title: "Decision", content: "x" });
  assert.deepEqual(barred, ['create:doc:{"space_id":"spc_general"}:', 'create:doc:"private":', `dm:ann:/acme/-/artifacts/x-${NEW}`]);
  assert.ok(!made.text.includes("Decision"), "a private doc made in public isn't named there");
  assert.match(made.text, /sent the link to @ann directly/);
});

test("an artifact someone here can't read is never quoted: the link goes to the asker, and what is remembered stays theirs", async () => {
  const log: string[] = [];
  const remembered: boolean[] = [];
  const acts: ActionPorts = { ...actions([]), remember: async (_body, _scope, onlyForAsker) => (remembered.push(!!onlyForAsker), { ok: true, message: "ok" }) };
  const box = new ToolBox(await annAndBob(), { ...readPorts, folios: folioWorld(log) }, ctx, [], acts);
  await box.run("remember", { fact: "Before reading anything" });
  const read = await box.run("read_artifact", { id: `/acme/-/artifacts/salary-bands-${SECRET}` });
  assert.equal(read.outcome, "withheld");
  assert.ok(!read.text.includes("Bands") && !read.text.includes("Salary"), "neither its content nor its title");
  assert.match(read.text, /say you found it and that you've sent the link to @ann directly/);
  assert.deepEqual(log, [`dm:ann:/acme/-/artifacts/x-${SECRET}`]);
  await box.run("remember", { fact: "Bands are reviewed in March" });
  assert.deepEqual(remembered, [false, true]);
  const edited = await box.run("edit_artifact", { id: SECRET, target: "append", markdown: "x" });
  assert.equal(edited.text, "Suggested: people accept or reject it there.", "an edit there isn't named here either");

  // In a public channel, even a doc everyone can read counts as the workspace's.
  const pub: boolean[] = [];
  const open = new ToolBox(await publicChannel(), { ...readPorts, folios: folioWorld([]) }, ctx, [], { ...actions([]), remember: async (_b, _s, only) => (pub.push(!!only), { ok: true, message: "ok" }) });
  await open.run("read_artifact", { id: FOL });
  await open.run("remember", { fact: "Refunds are 30 days" });
  assert.deepEqual(pub, [false]);
});

test("an agent shares only in a private conversation, only with people in it, to view or comment", async () => {
  const log: string[] = [];
  const box = new ToolBox(await annAndBob(), { ...readPorts, folios: folioWorld(log) }, ctx, [], actions([]));
  assert.equal((await box.run("share_artifact", { id: FOL, people: ["@bob"], role: "comment" })).outcome, "allowed");
  assert.match((await box.run("share_artifact", { id: FOL, people: ["carol"], role: "view" })).text, /@carol isn't in this conversation/);
  assert.equal((await box.run("share_artifact", { id: FOL, people: ["bob"], role: "edit" })).outcome, "refused");
  assert.deepEqual(log, [`share:${FOL}:bob:comment`]);
  const open = new ToolBox(await publicChannel(), { ...readPorts, folios: folioWorld(log) }, ctx, [], actions([]));
  assert.match((await open.run("share_artifact", { id: FOL, people: ["bob"], role: "view" })).text, /only in a direct message or a private channel/);
});

test("a doc reads as Markdown with where it is, what the agent may do, and its block ids", () => {
  const text = folioReadText(agentRead(FOL, "Refunds policy", "# Refunds policy\n\n30 days.", true));
  assert.equal(
    text,
    `# Refunds policy (/acme/-/artifacts/x-${FOL}, id ${FOL})\nA doc, in the General space; you can suggest edits. Edited 2026-10-01T10:00.\nTop-level blocks: b1 heading 1\n\n# Refunds policy\n\n30 days.`,
  );
});

test("a technical writer's duties suggest keeping the docs current when a pull request merges", () => {
  const inky = ["Update the docs after every change that makes them wrong", "Turn decisions made in chat into pages", "Write release notes and the weekly summary"];
  const names = suggestRoutines(inky, []).map((s) => [s.routine.name, s.routine.events]);
  assert.deepEqual(names[0], ["Keep the docs current", ["pull_merged"]]);
  assert.ok(names.some(([name]) => name === "Weekly summary"));
});
