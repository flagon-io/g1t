import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSession, InboxItem } from "@g1t/contracts";

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
  daySentence,
  dayWork,
  daysBefore,
  notificationRow,
  pullOutcome,
  rankAttention,
  sessionOutcome,
  spendToday,
  startHere,
  trendLabel,
  waitingSentence,
} from "./today.ts";

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

test("today is the reader's day, and the seven days before it", () => {
  assert.equal(dayIn(NOW, LA), "2026-10-09");
  assert.equal(dayIn(Date.parse("2026-10-10T02:00:00Z"), LA), "2026-10-09");
  assert.equal(dayIn(Date.parse("2026-10-10T02:00:00Z"), null), "2026-10-10");
  assert.equal(dayIn(NOW, "Not/AZone"), "2026-10-09");
  assert.deepEqual(daysBefore(NOW, LA, 3), ["2026-10-08", "2026-10-07", "2026-10-06"]);
});

test("an agent's pull request is accepted first time when it merged today with no revision", () => {
  assert.equal(pullOutcome(pull(), 0, "2026-10-09", null), "accepted");
  assert.equal(pullOutcome(pull(), 2, "2026-10-09", null), "fixed");
  assert.equal(pullOutcome(pull({ mergedAt: iso(NOW - DAY) }), 0, "2026-10-09", null), null);
  assert.equal(pullOutcome(pull({ status: "closed", mergedAt: null }), 0, "2026-10-09", null), "dropped");
  assert.equal(pullOutcome(pull({ status: "open", mergedAt: null }), 1, "2026-10-09", null), "open");
  assert.equal(pullOutcome(pull({ status: "draft", mergedAt: null, updatedAt: iso(NOW - 2 * DAY) }), 0, "2026-10-09", null), null);
});

test("a session counts once, at the root of its tree, and is never 'accepted'", () => {
  assert.equal(sessionOutcome(session(), "2026-10-09", null), "finished");
  assert.equal(sessionOutcome(session({ parent_id: "s0" }), "2026-10-09", null), null);
  assert.equal(sessionOutcome(session({ status: "failed" }), "2026-10-09", null), "dropped");
  assert.equal(sessionOutcome(session({ status: "stopped" }), "2026-10-09", null), "dropped");
  assert.equal(sessionOutcome(session({ status: "working", finished_at: null }), "2026-10-09", null), "open");
  assert.equal(sessionOutcome(session({ status: "needs_approval", finished_at: null, updated_at: iso(NOW - 3 * DAY) }), "2026-10-09", null), null);
  assert.equal(sessionOutcome(session({ finished_at: iso(NOW - DAY) }), "2026-10-09", null), null);
});

test("accepted first time is accepted over every agent pull request that settled", () => {
  assert.deepEqual(acceptance(["accepted", "accepted", "fixed", "dropped", "open", "finished"]), { value: 0.5, of: 4 });
  assert.equal(acceptance(["open", "finished"]), null);
});

test("the day's work: pull requests and sessions, sources, and the week before", () => {
  const work = dayWork({
    now: NOW,
    timeZone: null,
    slug: "acme",
    code: {
      pulls: [
        pull({ number: 1 }),
        pull({ number: 2 }),
        pull({ number: 3, status: "open", mergedAt: null }),
        // A person's pull request is not agent work.
        pull({ number: 4, author: { username: "bo", kind: "user" } }),
        // The week before: one accepted, one fixed.
        pull({ number: 5, mergedAt: iso(NOW - 2 * DAY), updatedAt: iso(NOW - 2 * DAY) }),
        pull({ number: 6, mergedAt: iso(NOW - 3 * DAY), updatedAt: iso(NOW - 3 * DAY) }),
        // Older than a week: not counted.
        pull({ number: 7, mergedAt: iso(NOW - 9 * DAY), updatedAt: iso(NOW - 9 * DAY) }),
      ],
      revisions: { "acme/web#2": 1, "acme/web#6": 2 },
      complete: true,
    },
    sessions: { sessions: [session(), session({ id: "s2", kind: "routine", status: "working", finished_at: null }), session({ id: "s3", parent_id: "s1" })], complete: true },
  });
  assert.equal(work.tasks.length, 5);
  assert.deepEqual(work.counts, { accepted: 1, fixed: 1, finished: 1, open: 2, dropped: 0 });
  assert.deepEqual(work.rate, { value: 0.5, of: 2 });
  assert.deepEqual(work.lastWeek, { value: 0.5, of: 2 });
  assert.deepEqual(work.sources, [
    { source: "code", count: 3 },
    { source: "chat", count: 1 },
    { source: "schedule", count: 1 },
  ]);
  // Open work goes last on the strip.
  assert.deepEqual(work.tasks.slice(-2).map((t) => t.outcome), ["open", "open"]);
  assert.equal(work.code, "read");
  assert.equal(work.partial, false);
  assert.equal(daySentence(work), "Agents finished 3 tasks. 1 needed a fix after review, and 2 are still open.");
});

test("no trend when the week could not all be read, and none without Code", () => {
  const partial = dayWork({ now: NOW, timeZone: null, slug: "acme", code: { pulls: [pull()], revisions: {}, complete: false }, sessions: null });
  assert.equal(partial.lastWeek, null);
  assert.equal(partial.partial, true);
  assert.equal(partial.sessions, "unavailable");
  const member = dayWork({ now: NOW, timeZone: null, slug: "acme", code: "no_access", sessions: { sessions: [session()], complete: true } });
  assert.equal(member.code, "no_access");
  assert.equal(member.rate, null);
  assert.equal(member.tasks.every((t) => t.source !== "code"), true);
});

test("the trend is in whole points", () => {
  assert.equal(trendLabel({ value: 0.89 }, { value: 0.83 }), "+6 pts vs the last 7 days");
  assert.equal(trendLabel({ value: 0.5 }, { value: 0.75 }), "−25 pts vs the last 7 days");
  assert.equal(trendLabel({ value: 0.5 }, { value: 0.5 }), "Same as the last 7 days");
  assert.equal(trendLabel(null, { value: 0.5 }), null);
});

test("the sentence for a quiet day, and for what waits", () => {
  const quiet = dayWork({ now: NOW, timeZone: null, slug: "acme", code: { pulls: [], revisions: {}, complete: true }, sessions: { sessions: [], complete: true } });
  assert.equal(daySentence(quiet), "No agent work today yet.");
  assert.equal(waitingSentence(0), "Nothing is waiting on you.");
  assert.equal(waitingSentence(1), "1 thing is waiting on you.");
  assert.equal(waitingSentence(8), "8 things are waiting on you.");
});

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

test("spent today: today's UTC group of the statement, at price, without money in", () => {
  const spend = spendToday(
    {
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
        { key: "2026-10-08", label: "2026-10-08", chargedMicros: 0, lines: [{ kind: "Agent runs", count: 3, chargedMicros: 9_000_000, costMicros: 0 }] },
      ],
      totals: { chargedMicros: 12_600_000, paidMicros: 50_000_000, costMicros: 0, entries: 4, priceMicros: 13_600_000 },
    },
    NOW,
  );
  assert.equal(spend.day, "2026-10-09");
  assert.equal(spend.totalMicros, 4_600_000);
  assert.deepEqual(spend.lines.map((l) => l.kind), ["Agent runs", "Sandbox time"]);
  assert.equal(spend.monthMicros, 13_600_000);
});
