import assert from "node:assert/strict";
import { test } from "node:test";

import type { ActivityDigest, ActorCount, ChatActivity, Deployment, InboxItem, RepoDigest, WorkflowRun } from "@g1t/contracts";

import {
  type AttentionRow,
  type CodeNeed,
  type CodePull,
  actorKind,
  attention,
  chatRow,
  codeRow,
  dayIn,
  deploysIn,
  digestOf,
  duration,
  landed,
  landedDeploys,
  landedFromActivity,
  landedIn,
  notificationRow,
  parseWindow,
  rankAttention,
  running,
  runningDeploys,
  runningWorkflows,
  sinceWords,
  spanFor,
  spanMonths,
  spanSentence,
  spendIn,
  startHere,
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

const need = (over: Partial<CodeNeed>): CodeNeed => ({
  key: "pull:p1",
  reason: "checks_failing",
  repo,
  ref: "#12",
  title: "Add retries",
  ask: "It failed in the merge queue.",
  by: { name: "bo", agent: false },
  at: NOW - 2 * HOUR,
  to: "/acme/web/pull/12",
  facts: [{ label: "Files changed", value: "4", tone: null }],
  ...over,
});

test("Code's needs become rows with what is at stake", () => {
  const failing = codeRow(need({}));
  assert.equal(failing.kind, "pull_blocked");
  assert.equal(failing.stake?.text, "Checks failing");
  assert.equal(failing.action.label, "Look");
  const deploy = codeRow(need({ key: "deploy:site", reason: "blocking", facts: [{ label: "Production", value: "Serving the build before", tone: "good" }] }));
  assert.equal(deploy.kind, "deploy");
  assert.equal(deploy.stake?.text, "Production on an older build");
  assert.equal(codeRow(need({ key: "review:p2", reason: "needs_review", facts: [{ label: "Lines", value: "+10 −2", tone: null }] })).stake?.text, "+10 −2");
  assert.equal(codeRow(need({ key: "runner:j1", reason: "stalled", facts: [{ label: "Waiting", value: "2 h", tone: "warn" }] })).stake?.text, "Waiting 2 h");
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
    row({ key: "review:new", kind: "review", at: NOW - HOUR, action: { label: "Review", to: "/acme/web/pull/2" } }),
    row({ key: "review:old", kind: "review", at: NOW - 3 * HOUR, action: { label: "Review", to: "/acme/web/pull/1" } }),
    row({ key: "pull:p", kind: "pull_blocked", at: NOW - 10 * 60_000, action: { label: "Look", to: "/acme/web/pull/3" } }),
  ];
  const ranked = rankAttention(rows);
  assert.deepEqual(ranked.map((r) => r.key), ["pull:p", "review:old", "review:new", "chat:old"]);
  const start = startHere(ranked);
  assert.equal(start?.row.key, "pull:p");
  assert.match(start?.why ?? "", /can't land/);
  // A failed production deploy beats everything.
  const withDeploy = rankAttention([...rows, row({ key: "deploy:site", kind: "deploy", at: NOW, action: { label: "See the build", to: "/acme/site/deployments/1" } })]);
  assert.equal(startHere(withDeploy)?.row.key, "deploy:site");
  // Ties in tier say so.
  const two = startHere(rankAttention(rows.filter((r) => r.kind === "review")));
  assert.equal(two?.row.key, "review:old");
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
  assert.equal(notificationRow(item({ repo: null, url: "/acme/-/chat/general" }), "acme", false)?.kind, "notification");
  // A reason this page does not know, older ones included, reads as a plain notification.
  assert.equal(notificationRow(item({ reason: "agent" as string as InboxItem["reason"] }), "acme", true)?.stake?.text, "Notification");
  assert.equal(notificationRow(item({ severity: "info" }), "acme", true), null);
  assert.equal(notificationRow(item({ workspace: "other", repo: "other/web" }), "acme", true), null);
  assert.equal(notificationRow(item({ readAt: iso(NOW) }), "acme", true), null);
});

test("a notification about something already listed is left out", () => {
  const out = attention({
    slug: "acme",
    code: true,
    codeNeeds: [need({})],
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
    notifications: [item({}), item({ id: "n2", repo: null, reason: "mention", severity: "warning", url: "/acme/-/chat/general" })],
    chat: null,
  });
  assert.deepEqual(out.rows.map((r) => r.key), ["notification:n2"]);
  assert.equal(out.rows.some((r) => r.from === "code"), false);
  assert.deepEqual(out.missing, ["Chat"]);
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

// --- People ------------------------------------------------------------

const ANA = "user:usr_ana";
const BO = "user:usr_bo";
const CY = "user:usr_cy";
const MARGO = "agent:agt_margo";
const G1T = "user:usr_g1t_agent";
const NAMES = { [ANA]: "ana", [BO]: "bo", [CY]: "cy", [MARGO]: "margo" };
const REPOS = {
  rep_web: { namespace: "acme", name: "web", defaultBranch: "main" },
  rep_api: { namespace: "acme", name: "api", defaultBranch: "main" },
  rep_docs: { namespace: "acme", name: "docs", defaultBranch: "main" },
  rep_cli: { namespace: "acme", name: "cli", defaultBranch: "trunk" },
};

const count = (actor: string, n: number): ActorCount => ({ actor, count: n });
const quietRepo = (repo_id: string): RepoDigest => ({
  repo_id,
  pushes: { count: 0, commits: 0, branches: [], by: [], default_branch: { count: 0, commits: 0, by: [], last_at: null } },
  pulls: { opened: [], merged: [], closed: [] },
  issues: { opened: [], closed: [] },
  reviews: [],
  comments: [],
  deployments: { succeeded: [], failed: [], production: 0 },
  releases: [],
  packages: [],
});

/**
 * A day on a busy workspace: 3 people pushed 41 commits to 4 projects,
 * merged 5 pull requests and opened 2; older agent rows (g1t and Margo)
 * pushed 6, opened 3 pull requests and reviewed 2, and are not people;
 * 2 production deploys went out; 120 messages were sent, 15 of them
 * Margo's; 7 docs were edited.
 */
function busyDay(): ActivityDigest {
  return {
    from: iso(SPAN.from),
    until: iso(SPAN.now),
    complete: true,
    repos: [
      {
        ...quietRepo("rep_web"),
        pushes: {
          count: 14,
          commits: 33,
          branches: ["fix-login", "main"],
          by: [
            { actor: ANA, count: 8, commits: 24 },
            { actor: BO, count: 4, commits: 5 },
            { actor: G1T, count: 2, commits: 4 },
          ],
          default_branch: { count: 3, commits: 9, by: [{ actor: ANA, count: 3, commits: 9 }], last_at: iso(NOW - 2 * HOUR) },
        },
        pulls: { opened: [count(ANA, 1), count(G1T, 2), count(MARGO, 1)], merged: [count(ANA, 3), count(BO, 1)], closed: [] },
        issues: { opened: [count(BO, 2)], closed: [count(ANA, 1), count(G1T, 1)] },
        reviews: [count(BO, 2), count(G1T, 2)],
        comments: [count(ANA, 4), count(MARGO, 3)],
        deployments: { succeeded: [count(ANA, 2)], failed: [], production: 2 },
        releases: [{ tag: "v1.4.0", name: "Autumn", actor: ANA, at: iso(NOW - 3 * HOUR) }],
        packages: [],
      },
      {
        ...quietRepo("rep_api"),
        pushes: { count: 5, commits: 8, branches: ["main"], by: [{ actor: CY, count: 5, commits: 8 }], default_branch: { count: 5, commits: 8, by: [{ actor: CY, count: 5, commits: 8 }], last_at: iso(NOW - 5 * HOUR) } },
        pulls: { opened: [count(CY, 1)], merged: [count(CY, 1)], closed: [] },
        packages: [{ ecosystem: "container", name: "api", version: "1.4.0", actor: G1T, at: iso(NOW - HOUR) }],
      },
      {
        ...quietRepo("rep_docs"),
        pushes: { count: 2, commits: 2, branches: ["typo"], by: [{ actor: BO, count: 2, commits: 2 }], default_branch: { count: 0, commits: 0, by: [], last_at: null } },
      },
      {
        ...quietRepo("rep_cli"),
        pushes: { count: 3, commits: 4, branches: ["trunk"], by: [{ actor: ANA, count: 1, commits: 2 }, { actor: MARGO, count: 2, commits: 2 }], default_branch: { count: 3, commits: 4, by: [{ actor: ANA, count: 1, commits: 2 }, { actor: MARGO, count: 2, commits: 2 }], last_at: iso(NOW - 30 * 60_000) } },
      },
    ],
    folios: {
      created: [count(ANA, 1)],
      edited_count: 7,
      edited: [
        { folio_id: "fol_1", kind: "doc", authors: [ANA, MARGO] },
        { folio_id: "fol_2", kind: "doc", authors: [ANA] },
        { folio_id: "fol_3", kind: "doc", authors: [BO] },
        { folio_id: "fol_4", kind: "doc", authors: [BO] },
        { folio_id: "fol_5", kind: "doc", authors: [CY] },
        { folio_id: "fol_6", kind: "doc", authors: [CY] },
        { folio_id: "fol_7", kind: "doc", authors: [MARGO] },
      ],
    },
  };
}

const busyChat: ChatActivity = {
  from: iso(SPAN.from),
  until: iso(SPAN.now),
  messages: 120,
  channels: 5,
  authors: [
    { key: ANA, messages: 60 },
    { key: BO, messages: 30 },
    { key: CY, messages: 15 },
    { key: MARGO, messages: 15 },
  ],
};

test("an actor is not a person when it is g1t or an agent of older rows; everyone else is", () => {
  assert.equal(actorKind(MARGO), "agent");
  assert.equal(actorKind(G1T), "agent");
  assert.equal(actorKind("user:agt_01abc"), "agent", "an agent named by its own id under user: is still a robot");
  assert.equal(actorKind("user:wsp_01abc"), "agent", "the workspace's own upkeep is g1t's");
  assert.equal(actorKind("user:g1t"), "agent");
  assert.equal(actorKind(ANA), "person");
  assert.equal(actorKind(""), "person");
  assert.equal(actorKind("user:usr_bot", new Set(["user:usr_bot"])), "agent");
});

test("the digest: what people did, in lines with counts, and who", () => {
  const digest = digestOf({ slug: "acme", repos: REPOS, activity: busyDay(), chat: busyChat, names: NAMES, code: true });
  assert.deepEqual(
    digest.people.lines.map((line) => [line.text, line.to]),
    [
      ["3 people pushed 41 commits to 4 projects", "/acme/-/repositories"],
      ["opened 2 pull requests, merged 5", "/acme/-/repositories"],
      ["reviewed 2 pull requests", "/acme/web/pulls"],
      ["opened 2 issues, closed 1", "/acme/web/issues"],
      ["left 4 comments", "/acme/web/issues"],
      ["2 deploys went out", "/acme/web/deployments"],
      ["published 1 release", "/acme/web/releases"],
      ["created 1 doc, edited 6 docs", "/acme/-/artifacts"],
      ["sent 105 messages in 5 conversations", "/acme/-/chat"],
    ],
  );
  // Faces: most active first, by name.
  assert.deepEqual(
    digest.people.actors.map((actor) => actor.name),
    ["ana", "bo", "cy"],
  );
  assert.deepEqual(digest.summary, { people: 3, commits: 41, merged: 5, said: 105, anything: true, peopleRead: true });
  assert.deepEqual(digest.missing, []);
  assert.equal(digest.partial, false);
});

test("the digest says which part didn't answer, and counts what could be read", () => {
  const noChat = digestOf({ slug: "acme", repos: REPOS, activity: busyDay(), chat: null, names: NAMES, code: true });
  assert.deepEqual(noChat.missing, ["Chat"]);
  assert.equal(noChat.people.lines.some((line) => line.key === "chat"), false);
  const noCode = digestOf({ slug: "acme", repos: REPOS, activity: null, chat: busyChat, names: NAMES, code: true });
  assert.deepEqual(noCode.missing, ["Code"]);
  assert.deepEqual(
    noCode.people.lines.map((line) => line.text),
    ["sent 105 messages in 5 conversations"],
  );
  assert.equal(noCode.summary.peopleRead, true);
  // Without Code access, events are read for artifacts only: no repositories, nothing missing.
  const member = digestOf({ slug: "acme", repos: {}, activity: { ...busyDay(), repos: [] }, chat: busyChat, names: NAMES, code: false });
  assert.deepEqual(member.missing, []);
  assert.deepEqual(
    member.people.lines.map((line) => line.key),
    ["docs", "chat"],
  );
  // A digest cut short says so.
  const cut = digestOf({ slug: "acme", repos: REPOS, activity: { ...busyDay(), complete: false }, chat: busyChat, names: NAMES, code: true });
  assert.equal(cut.partial, true);
  // Nobody named: an import's pushes are still commits.
  const imported = digestOf({
    slug: "acme",
    repos: REPOS,
    activity: { ...busyDay(), folios: null, repos: [{ ...quietRepo("rep_web"), pushes: { count: 2, commits: 7, branches: ["main"], by: [{ actor: "", count: 2, commits: 7 }], default_branch: { count: 2, commits: 7, by: [{ actor: "", count: 2, commits: 7 }], last_at: iso(NOW - HOUR) } } }] },
    chat: null,
    names: {},
    code: true,
  });
  assert.deepEqual(
    imported.people.lines.map((line) => [line.text, line.to]),
    [["7 commits pushed to 1 project", "/acme/web/activity"]],
  );
  assert.equal(imported.summary.people, 0);
});

test("the sentence: people first, then what landed; honest when quiet or unread", () => {
  const digest = digestOf({ slug: "acme", repos: REPOS, activity: busyDay(), chat: busyChat, names: NAMES, code: true });
  assert.equal(
    spanSentence({ words: "Since Tuesday evening" }, digest, 12),
    "Since Tuesday evening, 3 people pushed 41 commits and merged 5 changes and 12 changes landed.",
  );
  const quiet = digestOf({ slug: "acme", repos: REPOS, activity: { ...busyDay(), repos: [], folios: { created: [], edited: [], edited_count: 0 } }, chat: { ...busyChat, messages: 0, channels: 0, authors: [] }, names: {}, code: true });
  assert.equal(spanSentence({ words: "Since Tuesday evening" }, quiet, 0), "Quiet since Tuesday evening: nothing pushed, merged, deployed or said.");
  assert.equal(spanSentence({ words: "In the last 24 hours" }, quiet, 0), "Quiet in the last 24 hours: nothing pushed, merged, deployed or said.");
  // Only merges.
  const mergesOnly = digestOf({ slug: "acme", repos: REPOS, activity: { ...busyDay(), repos: [], folios: null }, chat: { ...busyChat, authors: [], messages: 0, channels: 0 }, names: {}, code: true });
  assert.equal(spanSentence({ words: "Since this morning" }, mergesOnly, 5), "Since this morning, 5 changes landed.");
  // People only talked.
  const talked = digestOf({ slug: "acme", repos: REPOS, activity: { ...busyDay(), repos: [], folios: null }, chat: busyChat, names: NAMES, code: true });
  assert.equal(spanSentence({ words: "Since an hour ago" }, talked, 0), "Since an hour ago, 3 people sent 105 messages.");
  // Neither events nor chat answered.
  const unread = digestOf({ slug: "acme", repos: REPOS, activity: null, chat: null, names: {}, code: true });
  assert.equal(spanSentence({ words: "Since this morning" }, unread, 5), "Since this morning, 5 changes landed; what people did couldn't be read.");
  const nothingRead = digestOf({ slug: "acme", repos: REPOS, activity: null, chat: null, names: {}, code: true });
  assert.equal(spanSentence({ words: "Since this morning" }, nothingRead, 0), "Since this morning, what people did couldn't be read.");
  assert.equal(spanSentence({ words: "Since this morning" }, null, null), "Since this morning, what happened couldn't be read.");
  assert.equal(waitingSentence(0), "Nothing needs you right now.");
  assert.equal(waitingSentence(1), "1 thing needs you.");
  assert.equal(waitingSentence(8), "8 things need you.");
});

test("what landed: every merge in the span, newest first, g1t's older ones as @g1t", () => {
  const merged = landedIn(
    [
      pull({ number: 1, mergedAt: iso(NOW - 2 * DAY), mergedBy: "bo" }),
      pull({ number: 2, author: { username: "bo", kind: "user" }, mergedAt: iso(NOW - HOUR) }),
      pull({ number: 3, mergedAt: iso(NOW - 5 * DAY) }),
      pull({ number: 4, status: "open", mergedAt: null }),
    ],
    SPAN,
  );
  assert.deepEqual(merged.map((change) => [change.kind, change.title, change.detail]), [
    ["merge", "Fix the flaky test", "web#2 · by bo"],
    ["merge", "Fix the flaky test", "web#1 · by @g1t, merged by bo"],
  ]);
});

test("what landed, besides merges: direct pushes, releases, packages and production builds, newest first", () => {
  const fromActivity = landedFromActivity(busyDay(), REPOS, NAMES, "acme");
  assert.deepEqual(
    fromActivity.map((change) => [change.kind, change.title, change.detail, change.to]),
    [
      ["push", "9 commits pushed to main", "web · 3 pushes by ana", "/acme/web/activity"],
      ["release", "v1.4.0 · Autumn", "web · released by ana", "/acme/web/releases/tag/v1.4.0"],
      ["push", "8 commits pushed to main", "api · 5 pushes by cy", "/acme/api/activity"],
      ["package", "api 1.4.0", "container package · published by @g1t", "/acme/-/packages"],
      ["push", "4 commits pushed to trunk", "cli · 3 pushes by ana and @margo", "/acme/cli/activity"],
    ],
  );
  const builds = landedDeploys([
    { key: "deploy:site:d1", project: "site", kind: "production", outcome: "live", commit: "abcdef1", branch: null, at: NOW - HOUR, to: "/acme/site/deployments/d1", by: "@g1t" },
    { key: "deploy:site:d2", project: "site", kind: "preview", outcome: "live", commit: "abcdef2", branch: "fix", at: NOW - HOUR, to: "/acme/site/deployments/d2", by: "bo" },
    { key: "deploy:site:d3", project: "site", kind: "production", outcome: "failed", commit: "abcdef3", branch: null, at: NOW - HOUR, to: "/acme/site/deployments/d3", by: "bo" },
  ]);
  assert.deepEqual(builds.map((change) => [change.kind, change.title]), [["deploy", "Production of site went live"]]);
  const all = landed([fromActivity, builds]);
  assert.deepEqual(
    all.map((change) => change.key),
    ["push:rep_cli", "landed:deploy:site:d1", "package:rep_api:container:api:1.4.0", "push:rep_web", "release:rep_web:v1.4.0", "push:rep_api"],
  );
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
    { "user:bo": "bo" },
  );
  assert.deepEqual(rows.map((row) => [row.key, row.outcome]), [
    ["deploy:site:d1", "live"],
    ["deploy:site:d2", "live"],
    ["deploy:site:d3", "failed"],
  ]);
  assert.equal(rows[0]!.to, "/acme/site/deployments/d1");
  assert.equal(rows[0]!.commit, "abcdef1");
  // The maker is named, never shown as an id; an older agent's by its handle; an id identity doesn't know as someone.
  assert.equal(rows[0]!.by, "bo");
  const unknown = deploysIn([{ slug: "site", deployments: [deploy({ createdBy: "usr_zzz" })] }], "acme", SPAN);
  assert.equal(unknown[0]!.by, "someone");
  const robot = deploysIn([{ slug: "site", deployments: [deploy({ createdBy: "agt_01x" })] }], "acme", SPAN, { "user:agt_01x": "otto" });
  assert.equal(robot[0]!.by, "@otto");
});

test("running now: workflow runs and builds going", () => {
  const builds = runningDeploys(
    [
      { slug: "site", enabled: true, production: null, previews: 0, latest: deploy({ status: "building", finishedAt: null }) },
      { slug: "docs", enabled: true, production: null, previews: 0, latest: deploy({}) },
    ],
    "acme",
  );
  assert.deepEqual(builds.map((row) => row.status), ["Building"]);
  const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
    id: "run_1",
    workflowId: "wf_1",
    path: ".g1t/workflows/ci.yml",
    name: "CI",
    title: "Fix the flaky test",
    number: 12,
    attempt: 1,
    event: "push",
    ref: "refs/heads/main",
    sha: "abcdef1",
    pull: null,
    status: "in_progress",
    conclusion: null,
    error: null,
    actor: "ana",
    createdAt: iso(NOW - 10 * 60_000),
    startedAt: iso(NOW - 9 * 60_000),
    finishedAt: null,
    ...over,
  });
  const workflows = runningWorkflows([
    { repo, runs: [run({}), run({ id: "run_2", status: "queued", startedAt: null, title: "" }), run({ id: "run_3", status: "completed", conclusion: "success" }), run({ id: "run_4", status: "action_required" })] },
  ]);
  assert.deepEqual(
    workflows.map((row) => [row.key, row.title, row.detail, row.status, row.to]),
    [
      ["workflow:acme/web:run_1", "CI: Fix the flaky test", "acme/web main · by ana", "Running", "/acme/web/actions/runs/run_1"],
      ["workflow:acme/web:run_2", "CI", "acme/web main · by ana", "Queued", "/acme/web/actions/runs/run_2"],
      ["workflow:acme/web:run_4", "CI: Fix the flaky test", "acme/web main · by ana", "Needs approval", "/acme/web/actions/runs/run_4"],
    ],
  );
  // Longest-going first within a kind: workflow runs, then builds.
  assert.deepEqual(running([builds, workflows.slice(0, 1)]).map((row) => row.key), ["workflow:acme/web:run_1", "deploy:site:d1"]);
});


test("the span's months: one, or the ones it crosses", () => {
  assert.deepEqual(spanMonths(SPAN), ["2026-10"]);
  assert.deepEqual(spanMonths({ from: Date.parse("2026-09-28T00:00:00Z"), now: NOW }), ["2026-09", "2026-10"]);
  assert.deepEqual(spanMonths({ from: Date.parse("2025-12-30T00:00:00Z"), now: Date.parse("2026-01-02T00:00:00Z") }), ["2025-12", "2026-01"]);
});

test("spend in the span: the UTC days it covers across months, at price, without money in", () => {
  const september = {
    groups: [
      { key: "2026-09-29", label: "", chargedMicros: 0, lines: [{ kind: "Workflow minutes", count: 2, chargedMicros: 1_000_000, costMicros: 0 }] },
      { key: "2026-09-20", label: "", chargedMicros: 0, lines: [{ kind: "Workflow minutes", count: 9, chargedMicros: 9_000_000, costMicros: 0 }] },
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
          { kind: "Workflow minutes", count: 12, chargedMicros: 3_000_000, costMicros: 2_500_000, priceMicros: 4_000_000 },
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
    ["Workflow minutes", 5_000_000, 14],
    ["Sandbox time", 600_000, 12],
  ]);
  // The month so far is billing's usage report, the top bar's figure, not the statement: it carries what is not yet closed.
  assert.equal(spend.monthMicros, 13_609_000);
  assert.equal(spendIn([september, october], { from: Date.parse("2026-09-29T15:00:00Z"), now: NOW }, null).monthMicros, null);
});
