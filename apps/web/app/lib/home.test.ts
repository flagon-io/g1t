import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSession, Deployment, InboxItem, InstallRequest, Memory } from "@g1t/contracts";

import {
  type AttentionRow,
  type CodeNeed,
  type CodePull,
  acceptance,
  agentRow,
  attention,
  chatRow,
  codeRow,
  dayIn,
  decisionsIn,
  deploysIn,
  duration,
  installRequestRow,
  landedIn,
  limitRow,
  notificationRow,
  parseWindow,
  pullOutcome,
  rankAttention,
  running,
  runningDeploys,
  runningSessions,
  sessionOutcome,
  sinceWords,
  spanFor,
  spanMonths,
  spanSentence,
  spanWork,
  spendIn,
  startHere,
  trendLabel,
  waitingSentence,
} from "./home.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 2026-10-09, 18:00 UTC; 11:00 in Los Angeles.
const NOW = Date.parse("2026-10-09T18:00:00Z");
const LA = "America/Los_Angeles";
const repo = { namespace: "acme", name: "web" };
const iso = (ms: number) => new Date(ms).toISOString();

function pull(over: Partial<CodePull> = {}): CodePull {
  return {
    repo,
    number: 1,
    title: "Fix the flaky test",
    status: "merged",
    mergedAt: iso(NOW - HOUR),
    createdAt: iso(NOW - 3 * HOUR),
    updatedAt: iso(NOW - HOUR),
    author: { username: "g1t", kind: "agent" },
    ...over,
  };
}

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "s1",
    workspace_id: "w",
    agent_id: "a",
    agent_handle: "margo",
    agent_name: "Margo",
    agent_avatar_seed: "margo",
    subagent: null,
    kind: "chat",
    parent_id: null,
    root_id: "s1",
    payer_agent_id: "a",
    title: "Draft the launch notes",
    goal: "",
    status: "done",
    status_note: null,
    summary: null,
    channel_id: "c",
    channel_kind: "channel",
    channel_name: "launch",
    card_message_id: null,
    asked_by: null,
    asked_by_username: "bo",
    routine_id: null,
    steps: 3,
    tool_calls: 2,
    input_tokens: 0,
    output_tokens: 0,
    charged_micros: 400_000,
    cap_micros: 2_000_000,
    model: null,
    outputs: [],
    created_at: iso(NOW - 2 * HOUR),
    updated_at: iso(NOW - HOUR),
    finished_at: iso(NOW - HOUR),
    visible: true,
    ...over,
  };
}
const need = (over: Partial<CodeNeed>): CodeNeed => ({
  key: "pull:p1",
  reason: "ready_to_merge",
  repo,
  ref: "#12",
  title: "Add retries",
  ask: "Waiting for you to merge it.",
  by: { name: "g1t", agent: true },
  for: "bo",
  at: NOW - 2 * HOUR,
  to: "/acme/web/pull/12",
  facts: [{ label: "Files changed", value: "4", tone: null }],
  ...over,
});

test("Code's needs become rows with what is at stake", () => {
  const ready = codeRow(need({}));
  assert.equal(ready.kind, "ready");
  assert.equal(ready.stake?.text, "4 files to land");
  assert.equal(ready.action.label, "Merge");
  const deploy = codeRow(need({ key: "deploy:site", reason: "blocking", facts: [{ label: "Production", value: "Serving the build before", tone: "good" }] }));
  assert.equal(deploy.kind, "deploy");
  assert.equal(deploy.stake?.text, "Production on an older build");
  assert.equal(codeRow(need({ reason: "checks_failing" })).kind, "pull_blocked");
  assert.equal(codeRow(need({ key: "run:r1", reason: "stalled", facts: [{ label: "Cost so far", value: "$1.20", tone: null }] })).stake?.text, "$1.20 so far");
});

const row = (over: Partial<AttentionRow>): AttentionRow => ({
  key: "k",
  kind: "chat",
  title: "t",
  detail: "d",
  stake: null,
  action: { label: "Open", to: "/x" },
  owner: null,
  at: NOW,
  from: "chat",
  ...over,
});

test("Start here: the most pressing tier first, then what has waited longest", () => {
  const rows = [
    row({ key: "chat:old", kind: "chat", at: NOW - 5 * DAY, action: { label: "Reply", to: "/acme/-/chat/general" } }),
    row({ key: "ready:new", kind: "ready", at: NOW - HOUR, action: { label: "Merge", to: "/acme/web/pull/2" } }),
    row({ key: "ready:old", kind: "ready", at: NOW - 3 * HOUR, action: { label: "Merge", to: "/acme/web/pull/1" } }),
    row({ key: "session:s", kind: "session_cap", at: NOW - 10 * 60_000, action: { label: "Approve more", to: "/acme/-/agents/margo/sessions/s" } }),
  ];
  const ranked = rankAttention(rows);
  assert.deepEqual(ranked.map((r) => r.key), ["session:s", "ready:old", "ready:new", "chat:old"]);
  const start = startHere(ranked);
  assert.equal(start?.row.key, "session:s");
  assert.match(start?.why ?? "", /spend cap/);
  // A failed production deploy beats everything.
  const withDeploy = rankAttention([...rows, row({ key: "deploy:site", kind: "deploy", at: NOW, action: { label: "See the build", to: "/acme/site/deployments/1" } })]);
  assert.equal(startHere(withDeploy)?.row.key, "deploy:site");
  // Ties in tier say so.
  const two = startHere(rankAttention(rows.filter((r) => r.kind === "ready")));
  assert.equal(two?.row.key, "ready:old");
  assert.match(two?.why ?? "", /Of the 2 like it, it has waited longest/);
  assert.equal(startHere([]), null);
});

test("the same order whatever order the rows came in", () => {
  const rows = [row({ key: "b", kind: "review", at: NOW }), row({ key: "a", kind: "review", at: NOW, action: { label: "Review", to: "/y" } })];
  assert.deepEqual(rankAttention(rows).map((r) => r.key), ["a", "b"]);
  assert.deepEqual(rankAttention([...rows].reverse()).map((r) => r.key), ["a", "b"]);
});

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "n1",
  reason: "ci_activity",
  severity: "error",
  title: "Checks failed on #12",
  body: "Add retries",
  event: "check.failed",
  repo: "acme/web",
  workspace: "acme",
  subject: "pull",
  number: 12,
  url: "/acme/web/pull/12",
  actor: "g1t",
  count: 1,
  createdAt: iso(NOW - HOUR),
  updatedAt: iso(NOW - HOUR),
  readAt: null,
  doneAt: null,
  saved: false,
  snoozedUntil: null,
  ...over,
});

test("notifications: warnings and failures in this workspace; none about repositories without Code", () => {
  assert.equal(notificationRow(item({}), "acme", true)?.kind, "notification");
  assert.equal(notificationRow(item({}), "acme", false), null);
  assert.equal(notificationRow(item({ repo: null, url: "/acme/-/agents/margo" }), "acme", false)?.kind, "notification");
  assert.equal(notificationRow(item({ severity: "info" }), "acme", true), null);
  assert.equal(notificationRow(item({ workspace: "other", repo: "other/web" }), "acme", true), null);
  assert.equal(notificationRow(item({ readAt: iso(NOW) }), "acme", true), null);
});

test("a notification about something already listed is left out", () => {
  const out = attention({
    slug: "acme",
    code: true,
    codeNeeds: [need({})],
    capped: [],
    agents: [],
    canManage: false,
    notifications: [item({})],
    chat: [],
  });
  assert.deepEqual(out.rows.map((r) => r.key), ["pull:p1"]);
  assert.deepEqual(out.missing, []);
});

test("without Code access no Code row is asked for or shown, and a silent source is named", () => {
  const out = attention({
    slug: "acme",
    code: false,
    codeNeeds: [need({})],
    capped: null,
    agents: null,
    canManage: false,
    notifications: [item({}), item({ id: "n2", repo: null, reason: "agent", severity: "warning", url: "/acme/-/agents/margo" })],
    chat: null,
  });
  assert.deepEqual(out.rows.map((r) => r.key), ["notification:n2"]);
  assert.equal(out.rows.some((r) => r.from === "code"), false);
  assert.deepEqual(out.missing, ["Agents", "Chat"]);
});

test("an agent out of budget is listed only for those who may raise it", () => {
  const agent = { id: "a1", handle: "margo", display_name: "Margo", status: "out_of_budget", spent_month_micros: 52_000_000, budget: { monthly_micros: 50_000_000 }, updated_at: iso(NOW) };
  assert.equal(agentRow(agent, "acme")?.stake?.text, "$0.00 left");
  const base = { slug: "acme", code: true, codeNeeds: [], capped: [], notifications: [], chat: [] };
  assert.equal(attention({ ...base, agents: [agent], canManage: false }).rows.length, 0);
  assert.equal(attention({ ...base, agents: [agent], canManage: true }).rows[0]?.kind, "agent_budget");
});

test("chat: mentions anywhere and unread direct messages, never muted", () => {
  const channel = { id: "c1", kind: "channel" as const, name: "general", last_message_at: iso(NOW) };
  assert.equal(chatRow({ channel, title: "general", muted: false, unread: 4, mentions: 0 }, "acme"), null);
  assert.equal(chatRow({ channel, title: "general", muted: false, unread: 4, mentions: 2 }, "acme")?.stake?.text, "2 mentions");
  assert.equal(chatRow({ channel, title: "general", muted: true, unread: 4, mentions: 2 }, "acme"), null);
  const dm = chatRow({ channel: { ...channel, kind: "dm", name: null }, title: "Bo Reed", muted: false, unread: 1, mentions: 0 }, "acme");
  assert.equal(dm?.action.to, "/acme/-/chat/dm/c1");
});

// The span is NOW back to 3 days ago unless a test says otherwise.
const SPAN = { from: NOW - 3 * DAY, now: NOW };

test("a day is the reader's day", () => {
  assert.equal(dayIn(NOW, LA), "2026-10-09");
  assert.equal(dayIn(Date.parse("2026-10-10T02:00:00Z"), LA), "2026-10-09");
  assert.equal(dayIn(Date.parse("2026-10-10T02:00:00Z"), null), "2026-10-10");
  assert.equal(dayIn(NOW, "Not/AZone"), "2026-10-09");
});

test("since your last visit, in words, in the reader's time zone", () => {
  // NOW is Friday 11:00 in Los Angeles.
  assert.equal(sinceWords(NOW - 20_000, NOW, LA), "a moment ago");
  assert.equal(sinceWords(NOW - 40 * 60_000, NOW, LA), "40 minutes ago");
  assert.equal(sinceWords(NOW - HOUR - 60_000, NOW, LA), "an hour ago");
  assert.equal(sinceWords(NOW - 2 * HOUR, NOW, LA), "2 hours ago");
  // 07:00 Friday.
  assert.equal(sinceWords(NOW - 4 * HOUR, NOW, LA), "this morning");
  // 02:00 Friday is Thursday night.
  assert.equal(sinceWords(NOW - 9 * HOUR, NOW, LA), "last night");
  // 19:00 Thursday.
  assert.equal(sinceWords(NOW - 16 * HOUR, NOW, LA), "yesterday evening");
  // 19:00 Tuesday.
  assert.equal(sinceWords(NOW - 2 * DAY - 16 * HOUR, NOW, LA), "Tuesday evening");
  // 02:00 Wednesday is Tuesday night.
  assert.equal(sinceWords(NOW - 2 * DAY - 9 * HOUR, NOW, LA), "Tuesday night");
  assert.equal(sinceWords(NOW - 9 * DAY, NOW, LA), "Sep 30");
});

test("how long a span is", () => {
  assert.equal(duration(30_000), "a moment");
  assert.equal(duration(45 * 60_000), "45 minutes");
  assert.equal(duration(HOUR), "1 hour");
  assert.equal(duration(3 * DAY + HOUR), "3 days");
  assert.equal(duration(15 * DAY), "2 weeks");
});

test("the span: since your last visit, capped, or a fixed window", () => {
  assert.equal(parseWindow("24h"), "24h");
  assert.equal(parseWindow("7d"), "7d");
  assert.equal(parseWindow("nonsense"), "last");
  assert.equal(parseWindow(null), "last");
  const away = spanFor("last", NOW, NOW - 2 * DAY - 16 * HOUR, LA);
  assert.equal(away.from, NOW - 2 * DAY - 16 * HOUR);
  assert.equal(away.words, "Since Tuesday evening");
  assert.equal(away.length, "2 days");
  assert.equal(away.note, null);
  // Never visited: the last 24 hours, and it says why.
  const first = spanFor("last", NOW, null, LA);
  assert.equal(first.from, NOW - DAY);
  assert.equal(first.note, "first");
  assert.equal(spanFor("last", NOW, undefined, LA).note, "unknown");
  // Away a month: 14 days at most.
  const capped = spanFor("last", NOW, NOW - 30 * DAY, LA);
  assert.equal(capped.from, NOW - 14 * DAY);
  assert.equal(capped.note, "capped");
  assert.equal(capped.words, "In the last 14 days");
  // The fixed windows ignore the last visit.
  assert.equal(spanFor("24h", NOW, NOW - 3 * DAY, LA).from, NOW - DAY);
  assert.deepEqual([spanFor("7d", NOW, NOW - HOUR, LA).from, spanFor("7d", NOW, NOW - HOUR, LA).words], [NOW - 7 * DAY, "In the last 7 days"]);
});

test("an agent's pull request is accepted first time when it merged in the span with no revision", () => {
  assert.equal(pullOutcome(pull(), 0, SPAN), "accepted");
  assert.equal(pullOutcome(pull(), 2, SPAN), "fixed");
  assert.equal(pullOutcome(pull({ mergedAt: iso(NOW - 4 * DAY) }), 0, SPAN), null);
  assert.equal(pullOutcome(pull({ status: "closed", mergedAt: null }), 0, SPAN), "dropped");
  // Still open is not settled: it is under Running now.
  assert.equal(pullOutcome(pull({ status: "open", mergedAt: null }), 1, SPAN), null);
});

test("a session counts once, at the root of its tree, when it settled in the span", () => {
  assert.equal(sessionOutcome(session(), SPAN), "finished");
  assert.equal(sessionOutcome(session({ parent_id: "s0" }), SPAN), null);
  assert.equal(sessionOutcome(session({ status: "failed" }), SPAN), "dropped");
  assert.equal(sessionOutcome(session({ status: "stopped" }), SPAN), "dropped");
  assert.equal(sessionOutcome(session({ status: "working", finished_at: null }), SPAN), null);
  assert.equal(sessionOutcome(session({ finished_at: iso(NOW - 4 * DAY) }), SPAN), null);
});

test("accepted first time is accepted over every agent pull request that settled", () => {
  assert.deepEqual(acceptance(["accepted", "accepted", "fixed", "dropped", "finished"]), { value: 0.5, of: 4 });
  assert.equal(acceptance(["finished"]), null);
});

test("the span's work: pull requests and sessions, sources, and the 7 days before", () => {
  const work = spanWork({
    span: SPAN,
    slug: "acme",
    code: {
      pulls: [
        pull({ number: 1 }),
        pull({ number: 2 }),
        pull({ number: 3, status: "open", mergedAt: null }),
        // A person's pull request is not agent work.
        pull({ number: 4, author: { username: "bo", kind: "user" } }),
        // The 7 days before the span: one accepted, one fixed.
        pull({ number: 5, mergedAt: iso(NOW - 4 * DAY), updatedAt: iso(NOW - 4 * DAY) }),
        pull({ number: 6, mergedAt: iso(NOW - 5 * DAY), updatedAt: iso(NOW - 5 * DAY) }),
        // Older than that: not counted.
        pull({ number: 7, mergedAt: iso(NOW - 11 * DAY), updatedAt: iso(NOW - 11 * DAY) }),
      ],
      revisions: { "acme/web#2": 1, "acme/web#6": 2 },
      complete: true,
    },
    sessions: { sessions: [session(), session({ id: "s2", kind: "routine", status: "working", finished_at: null }), session({ id: "s3", parent_id: "s1" })], complete: true },
  });
  assert.equal(work.tasks.length, 3);
  assert.deepEqual(work.counts, { accepted: 1, fixed: 1, finished: 1, dropped: 0 });
  assert.deepEqual(work.rate, { value: 0.5, of: 2 });
  assert.deepEqual(work.before, { value: 0.5, of: 2 });
  assert.deepEqual(work.sources, [
    { source: "code", count: 2 },
    { source: "chat", count: 1 },
  ]);
  assert.equal(work.code, "read");
  assert.equal(work.partial, false);
  assert.equal(
    spanSentence({ words: "Since Tuesday evening" }, work, 3),
    "Since Tuesday evening, agents finished 3 tasks and 3 changes landed. 1 needed a fix after review.",
  );
});

test("no trend when the 7 days before could not all be read, and none without Code", () => {
  const partial = spanWork({ span: SPAN, slug: "acme", code: { pulls: [pull()], revisions: {}, complete: false }, sessions: null });
  assert.equal(partial.before, null);
  assert.equal(partial.partial, true);
  assert.equal(partial.sessions, "unavailable");
  const member = spanWork({ span: SPAN, slug: "acme", code: "no_access", sessions: { sessions: [session()], complete: true } });
  assert.equal(member.code, "no_access");
  assert.equal(member.rate, null);
  assert.equal(member.tasks.every((t) => t.source !== "code"), true);
});

test("the trend is in whole points", () => {
  assert.equal(trendLabel({ value: 0.89 }, { value: 0.83 }), "+6 pts vs the 7 days before");
  assert.equal(trendLabel({ value: 0.5 }, { value: 0.75 }), "−25 pts vs the 7 days before");
  assert.equal(trendLabel({ value: 0.5 }, { value: 0.5 }), "Same as the 7 days before");
  assert.equal(trendLabel(null, { value: 0.5 }), null);
});

test("the sentence for a quiet span, and for what needs you", () => {
  const quiet = spanWork({ span: SPAN, slug: "acme", code: { pulls: [], revisions: {}, complete: true }, sessions: { sessions: [], complete: true } });
  assert.equal(spanSentence({ words: "Since an hour ago" }, quiet, 0), "Since an hour ago, nothing new has settled.");
  assert.equal(spanSentence({ words: "In the last 24 hours" }, quiet, 2), "In the last 24 hours, 2 changes landed.");
  assert.equal(spanSentence({ words: "Since this morning" }, null, null), "Since this morning, agent work couldn't be read.");
  assert.equal(waitingSentence(0), "Nothing needs you right now.");
  assert.equal(waitingSentence(1), "1 thing needs you.");
  assert.equal(waitingSentence(8), "8 things need you.");
});

test("what landed: every merge in the span, a person's or an agent's, newest first", () => {
  const landed = landedIn(
    [
      pull({ number: 1, mergedAt: iso(NOW - 2 * DAY), mergedBy: "bo" }),
      pull({ number: 2, author: { username: "bo", kind: "user" }, mergedAt: iso(NOW - HOUR) }),
      pull({ number: 3, mergedAt: iso(NOW - 5 * DAY) }),
      pull({ number: 4, status: "open", mergedAt: null }),
    ],
    SPAN,
  );
  assert.deepEqual(landed.map((change) => [change.number, change.agent]), [
    [2, false],
    [1, true],
  ]);
  assert.equal(landed[1]!.mergedBy, "bo");
});

const deploy = (over: Partial<Deployment>): Deployment => ({
  id: "d1",
  kind: "production",
  branch: null,
  number: null,
  commit: "abcdef1234",
  status: "ready",
  url: "https://site.g1t.page",
  error: null,
  warnings: [],
  buildSeconds: 40,
  createdBy: "bo",
  createdAt: iso(NOW - 2 * HOUR),
  finishedAt: iso(NOW - HOUR),
  ...over,
});

test("builds that finished in the span: live or failed, never skipped", () => {
  const rows = deploysIn(
    [
      {
        slug: "site",
        deployments: [
          deploy({}),
          deploy({ id: "d2", status: "replaced", finishedAt: iso(NOW - DAY) }),
          deploy({ id: "d3", status: "failed", finishedAt: iso(NOW - 2 * DAY) }),
          deploy({ id: "d4", status: "skipped", finishedAt: iso(NOW - HOUR) }),
          deploy({ id: "d5", status: "building", finishedAt: null }),
          deploy({ id: "d6", finishedAt: iso(NOW - 5 * DAY) }),
        ],
      },
    ],
    "acme",
    SPAN,
  );
  assert.deepEqual(rows.map((row) => [row.key, row.outcome]), [
    ["deploy:site:d1", "live"],
    ["deploy:site:d2", "live"],
    ["deploy:site:d3", "failed"],
  ]);
  assert.equal(rows[0]!.to, "/acme/site/deployments/d1");
  assert.equal(rows[0]!.commit, "abcdef1");
});

const request = (over: Partial<InstallRequest>): InstallRequest => ({
  id: "r1",
  listing: "integration:sentry",
  kind: "integration",
  name: "Sentry",
  note: "For the error alerts",
  requested_by: "bo",
  requested_at: iso(NOW - 2 * DAY),
  status: "open",
  resolved_by: null,
  resolved_at: null,
  ...over,
});

const memory = (over: Partial<Memory>): Memory => ({
  id: "m1",
  scope: "workspace",
  workspace: "acme",
  repo: null,
  text: "Use Postgres for the ledger",
  kind: "decision",
  source: { kind: "person" } as Memory["source"],
  createdBy: "ada",
  pinned: false,
  createdAt: iso(NOW - DAY),
  updatedAt: iso(NOW - DAY),
  lastUsedAt: null,
  ...over,
});

test("decisions: kept decisions in memory and requests answered, in the span", () => {
  const rows = decisionsIn(
    {
      memories: [memory({}), memory({ id: "m2", kind: "fact" }), memory({ id: "m3", status: "candidate" }), memory({ id: "m4", createdAt: iso(NOW - 6 * DAY) })],
      requests: [request({}), request({ id: "r2", status: "declined", resolved_by: "ada", resolved_at: iso(NOW - HOUR) })],
    },
    "acme",
    SPAN,
  );
  assert.deepEqual(rows.map((row) => row.key), ["request:r2", "memory:m1"]);
  assert.equal(rows[0]!.text, "Turned down Sentry, which bo asked for");
});

test("an open install request needs an owner; answered ones don't", () => {
  assert.equal(installRequestRow(request({}), "acme")?.action.to, "/acme/-/marketplace/requests");
  assert.equal(installRequestRow(request({ status: "done" }), "acme"), null);
  const base = { slug: "acme", code: true, codeNeeds: [], capped: [], agents: [], canManage: true, notifications: [], chat: [] };
  assert.equal(attention({ ...base, requests: [request({})] }).rows[0]?.kind, "install_request");
  assert.equal(attention({ ...base, requests: null }).rows.length, 0);
});

test("the workspace's agent budget used up comes first, for those who may raise it", () => {
  assert.equal(limitRow({ alert: 90, spentMicros: 1, since: NOW }, "acme"), null);
  const limit = { alert: 100, spentMicros: 500_000_000, since: NOW - DAY };
  assert.equal(limitRow(limit, "acme")?.action.to, "/acme/-/spend");
  const base = { slug: "acme", code: true, codeNeeds: [need({})], capped: [], agents: [], notifications: [], chat: [], limit };
  assert.equal(attention({ ...base, canManage: true }).start?.row.kind, "limit");
  assert.equal(attention({ ...base, canManage: false }).rows.some((r) => r.kind === "limit"), false);
});

test("running now: live root sessions, agents' changes and builds going; a capped session is under Needs you", () => {
  const sessions = runningSessions(
    [
      session({ id: "a", status: "working", finished_at: null, created_at: iso(NOW - HOUR) }),
      session({ id: "b", status: "needs_approval", finished_at: null }),
      session({ id: "c", status: "queued", finished_at: null, parent_id: "a" }),
      session({ id: "d", status: "done" }),
      session({ id: "e", status: "queued", finished_at: null, visible: false, created_at: iso(NOW - 2 * HOUR) }),
    ],
    "acme",
  );
  assert.deepEqual(sessions.map((row) => [row.key, row.status]), [
    ["session:a", "Working"],
    ["session:e", "Queued"],
  ]);
  assert.equal(sessions[1]!.title, "A session in a conversation you're not in");
  const builds = runningDeploys(
    [
      { slug: "site", enabled: true, production: null, previews: 0, latest: deploy({ status: "building", finishedAt: null }) },
      { slug: "docs", enabled: true, production: null, previews: 0, latest: deploy({}) },
    ],
    "acme",
  );
  assert.deepEqual(builds.map((row) => row.status), ["Building"]);
  // Longest-going first within a kind.
  assert.deepEqual(running([builds, sessions]).map((row) => row.key), ["session:e", "session:a", "deploy:site:d1"]);
});


test("the span's months: one, or the ones it crosses", () => {
  assert.deepEqual(spanMonths(SPAN), ["2026-10"]);
  assert.deepEqual(spanMonths({ from: Date.parse("2026-09-28T00:00:00Z"), now: NOW }), ["2026-09", "2026-10"]);
  assert.deepEqual(spanMonths({ from: Date.parse("2025-12-30T00:00:00Z"), now: Date.parse("2026-01-02T00:00:00Z") }), ["2025-12", "2026-01"]);
});

test("spend in the span: the UTC days it covers across months, at price, without money in", () => {
  const september = {
    groups: [
      { key: "2026-09-29", label: "", chargedMicros: 0, lines: [{ kind: "Agent runs", count: 2, chargedMicros: 1_000_000, costMicros: 0 }] },
      { key: "2026-09-20", label: "", chargedMicros: 0, lines: [{ kind: "Agent runs", count: 9, chargedMicros: 9_000_000, costMicros: 0 }] },
    ],
    totals: { chargedMicros: 10_000_000, paidMicros: 0, costMicros: 0, entries: 2 },
  };
  const october = {
    groups: [
      {
        key: "2026-10-09",
        label: "2026-10-09",
        chargedMicros: 0,
        lines: [
          { kind: "Agent runs", count: 12, chargedMicros: 3_000_000, costMicros: 2_500_000, priceMicros: 4_000_000 },
          { kind: "Sandbox time", count: 12, chargedMicros: 600_000, costMicros: 500_000 },
          { kind: "Payments", count: 1, chargedMicros: -50_000_000, costMicros: 0, priceMicros: 0 },
        ],
      },
    ],
    totals: { chargedMicros: 12_600_000, paidMicros: 50_000_000, costMicros: 0, entries: 4, priceMicros: 13_600_000 },
  };
  const spend = spendIn([september, october], { from: Date.parse("2026-09-29T15:00:00Z"), now: NOW }, 13_609_000);
  assert.deepEqual([spend.from, spend.to], ["2026-09-29", "2026-10-09"]);
  assert.equal(spend.totalMicros, 5_600_000);
  assert.deepEqual(spend.lines.map((l) => [l.kind, l.micros, l.count]), [
    ["Agent runs", 5_000_000, 14],
    ["Sandbox time", 600_000, 12],
  ]);
  // The month so far is billing's usage report, the top bar's figure, not the statement: it carries what is not yet closed.
  assert.equal(spend.monthMicros, 13_609_000);
  assert.equal(spendIn([september, october], { from: Date.parse("2026-09-29T15:00:00Z"), now: NOW }, null).monthMicros, null);
});
