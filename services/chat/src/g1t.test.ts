import assert from "node:assert/strict";
import { test } from "node:test";

import { G1T_KEY, isG1t, parsePrincipalKey } from "@g1t/contracts/chat";
import { ASK_MAX_MESSAGE_CHARS, ASK_MAX_TOTAL_CHARS } from "@g1t/contracts/ai";

import { dmKey, dmMembers } from "./names.ts";
import {
  AnswerReader,
  answerAllowed,
  conversation,
  finalBody,
  g1tDmPerson,
  latestPage,
  latestQuestion,
  metaColumn,
  notSetUpText,
  pageFrom,
  readsNote,
  shownAnswer,
  startsAnswer,
  withProposalState,
  type SaidRow,
} from "./g1t.ts";

const ana = "user:u1";
const bo = "user:u2";

test("g1t is one reserved member, system:g1t, and only that system key parses", () => {
  assert.deepEqual(parsePrincipalKey(G1T_KEY), { kind: "system", id: "g1t" });
  assert.equal(parsePrincipalKey("system:other"), null);
  assert.ok(isG1t({ kind: "system", id: "g1t" }));
  assert.ok(!isG1t({ kind: "user", id: "g1t" }));
});

test("a direct message with g1t is one person and g1t, keyed like any other", () => {
  const members = dmMembers(ana, [G1T_KEY]);
  assert.equal(g1tDmPerson(members), ana);
  // Opening it again, from either side's order, finds the same one.
  assert.equal(dmKey(members), dmKey(dmMembers(ana, [G1T_KEY, G1T_KEY])));
  assert.equal(g1tDmPerson(dmMembers(ana, [G1T_KEY, bo])), null);
  assert.equal(g1tDmPerson(dmMembers(ana, [bo])), null);
  assert.equal(g1tDmPerson([G1T_KEY]), null);
  assert.equal(g1tDmPerson(["agent:a1", G1T_KEY]), null);
});

test("only a person's own top-level words in their direct message with g1t start an answer", () => {
  const members = [G1T_KEY, ana];
  const base = { channelKind: "dm" as const, members, author: ana, threadRoot: null, card: false, body: "What shipped today?" };
  assert.ok(startsAnswer(base));
  assert.ok(!startsAnswer({ ...base, author: G1T_KEY }), "g1t's own messages never do");
  assert.ok(!startsAnswer({ ...base, threadRoot: "msg_1" }), "nor thread replies");
  assert.ok(!startsAnswer({ ...base, card: true }), "nor cards");
  assert.ok(!startsAnswer({ ...base, body: "   " }));
  assert.ok(!startsAnswer({ ...base, members: [ana, bo] }), "a direct message between people");
  assert.ok(!startsAnswer({ ...base, channelKind: "channel" }), "a channel, even one g1t were in");
  assert.ok(!startsAnswer({ ...base, author: bo }), "someone not in it");
});

const row = (id: string, author: string, body: string, meta: object | null = null, extra: Partial<SaidRow> = {}): SaidRow => ({
  id,
  author,
  kind: "text",
  body,
  meta: meta ? JSON.stringify(meta) : null,
  deleted_at: null,
  ...extra,
});
const done = { answer: { state: "done" } };

test("the conversation maps the person to user and g1t's answers to assistant, alternating", () => {
  const rows = [row("m1", ana, "Hi"), row("m2", G1T_KEY, "Hello! What can I do?", done), row("m3", ana, "What shipped?"), row("m4", ana, "Today, I mean.")];
  assert.deepEqual(conversation(rows), [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello! What can I do?" },
    { role: "user", content: "What shipped?\n\nToday, I mean." },
  ]);
});

test("an earlier answer is read back with what it read in g1t, so it is not taken for made up", () => {
  const steps = [
    { type: "tool", id: "t1", name: "repository", action: "list", label: "Listed repositories", status: "done", summary: "9 repositories" },
    { type: "tool", id: "t2", name: "repository", action: "get", label: "Read acme/rocket", status: "failed", summary: "Repository not found" },
    { type: "sources", sources: [] },
  ];
  const rows = [
    row("m1", ana, "Open work items in acme/rocket?"),
    row("m2", G1T_KEY, "There is no acme/rocket.", { answer: { state: "done", steps } }),
    row("m3", ana, "Did you check?"),
  ];
  assert.deepEqual(conversation(rows)[1], {
    role: "assistant",
    content:
      "[g1t's tool reads for this answer: Listed repositories: 9 repositories; Read acme/rocket (failed: Repository not found)]\n\nThere is no acme/rocket.",
  });
  assert.equal(readsNote([]), null);
  assert.equal(readsNote(undefined), null);
  const many = Array.from({ length: 50 }, (_, i) => ({ type: "tool", id: `t${i}`, label: `Read file number ${i}`, status: "done" }));
  const long = readsNote(many)!;
  assert.ok(long.length <= 800 && long.endsWith("…]"));
});

test("the conversation leaves out failed answers, the set-up note, the answer being written, cards and deleted messages", () => {
  const rows = [
    row("m1", ana, "First"),
    row("m2", G1T_KEY, "I couldn't answer that", { answer: { state: "error", error: "x" } }),
    row("m3", G1T_KEY, "Choose a provider", { answer: { state: "done", setup: "missing" } }),
    row("m4", ana, "gone", null, { deleted_at: "2026-10-12T00:00:00Z" }),
    row("m5", ana, "card", null, { kind: "card" }),
    row("m6", ana, "Second"),
    row("m7", G1T_KEY, "", { answer: { state: "thinking" } }),
  ];
  assert.deepEqual(conversation(rows), [{ role: "user", content: "First\n\nSecond" }]);
});

test("the answer being written, read with the conversation, changes nothing the answer reads", () => {
  const page = { path: "/acme" };
  const asked = [row("m1", ana, "Q", { page })];
  const read = [...asked, row("m2", G1T_KEY, "", { answer: { state: "thinking" } })];
  assert.deepEqual(conversation(read, "m2"), conversation(asked));
  assert.equal(latestQuestion(read), "m1");
  assert.deepEqual(latestPage(read), page);
});

test("a stopped answer still counts as what g1t said", () => {
  const rows = [row("m1", ana, "Q"), row("m2", G1T_KEY, "Half an ans", { answer: { state: "stopped" } }), row("m3", ana, "Go on")];
  assert.equal(conversation(rows).length, 3);
});

test("a new conversation reads only what comes after the latest mark", () => {
  const rows = [
    row("m1", ana, "Old question"),
    row("m2", G1T_KEY, "Old answer", done),
    row("m3", G1T_KEY, "New conversation", { reset: true }),
    row("m4", ana, "Fresh question"),
  ];
  assert.deepEqual(conversation(rows), [{ role: "user", content: "Fresh question" }]);
  assert.deepEqual(conversation(rows.slice(0, 3)), [], "nothing to answer right after a mark");
});

test("the conversation ends with the person and keeps within Ask's limits, newest first", () => {
  assert.deepEqual(conversation([row("m1", ana, "Q"), row("m2", G1T_KEY, "A", done)]), []);
  const long = "x".repeat(ASK_MAX_MESSAGE_CHARS + 50);
  const [only] = conversation([row("m1", ana, `start${long}end`)]);
  assert.equal(only!.content.length, ASK_MAX_MESSAGE_CHARS);
  assert.ok(only!.content.endsWith("end"), "a long question keeps its end");
  const many: SaidRow[] = [];
  for (let i = 0; i < 60; i++) many.push(row(`q${i}`, ana, `q${i} ${"y".repeat(3_000)}`), row(`a${i}`, G1T_KEY, `a${i} ${"z".repeat(3_000)}`, done));
  many.push(row("last", ana, "the latest"));
  const kept = conversation(many);
  assert.equal(kept[0]!.role, "user");
  assert.equal(kept.at(-1)!.content, "the latest");
  assert.ok(kept.length <= 40);
  assert.ok(kept.reduce((sum, turn) => sum + turn.content.length, 0) <= ASK_MAX_TOTAL_CHARS);
  for (let i = 1; i < kept.length; i++) assert.notEqual(kept[i]!.role, kept[i - 1]!.role);
});

test("the page an answer is told is the newest question's, as sent from the top bar", () => {
  const page = { path: "/acme/-/work/12", repo: null, workspace: "acme", item: 12, pull: null };
  assert.deepEqual(latestPage([row("m1", ana, "Q", { page }), row("m2", G1T_KEY, "A", done)]), page);
  assert.equal(latestPage([row("m1", ana, "Q", { page }), row("m2", ana, "From chat")]), null);
  assert.deepEqual(pageFrom({ path: "/acme/web", repo: { namespace: "acme", name: "web" }, item: -1, extra: true }), {
    path: "/acme/web",
    repo: { namespace: "acme", name: "web" },
    workspace: null,
    item: null,
    pull: null,
    time_zone: null,
  });
  // The browser's time zone is kept when it is one; anything else is dropped.
  assert.equal(pageFrom({ path: "/acme", time_zone: "America/Denver" })?.time_zone, "America/Denver");
  assert.equal(pageFrom({ path: "/acme", time_zone: "<script>" })?.time_zone, null);
  assert.deepEqual(pageFrom({ time_zone: "Asia/Kolkata" }), { path: null, repo: null, workspace: null, item: null, pull: null, time_zone: "Asia/Kolkata" });
  assert.equal(pageFrom({ path: "https://elsewhere" }), null);
  assert.equal(pageFrom("nope"), null);
  assert.equal(metaColumn({}), null);
});

test("with no provider chosen, g1t says where an owner chooses one", () => {
  const text = notSetUpText("acme");
  assert.match(text, /Settings → AI → Ask g1t/);
  assert.match(text, /\(\/acme\/-\/ai#ask\)/);
  assert.match(text, /ask one of them/);
});

test("an answer is read as it streams, and unknown events are kept as steps, never text", () => {
  const reader = new AnswerReader();
  assert.ok(reader.feed('{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"m"}\n{"type":"te'));
  assert.equal(reader.answer.state, "thinking");
  reader.feed('xt","text":"Hel"}\n{"type":"tool","name":"search","input":{"q":"x"}}\n');
  reader.feed('{"type":"text","text":"lo"}\nnot json\n{"type":"done","stop_reason":"end_turn"}\n{"type":"text","text":"after"}\n');
  assert.equal(reader.body, "Hello");
  assert.equal(reader.answer.state, "done");
  assert.equal(reader.answer.provider_label, "Anthropic");
  assert.deepEqual(reader.answer.steps, [{ type: "tool", name: "search", input: { q: "x" } }]);
});

test("an answer Auto chose a model for says so; a chosen model's does not", () => {
  const auto = new AnswerReader();
  auto.feed('{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"claude-sonnet-5-5","auto":true}\n');
  assert.equal(auto.answer.model, "claude-sonnet-5-5");
  assert.equal(auto.answer.auto, true);
  const chosen = new AnswerReader();
  chosen.feed('{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"claude-haiku-5-5"}\n');
  assert.equal(chosen.answer.auto, undefined);
});

test("a tool step is kept once, as it last was, and sources are kept whole", () => {
  const reader = new AnswerReader();
  const step = { type: "tool", id: "step_0_0", name: "workspace", action: "activity", label: "Read activity", status: "running", summary: null, link: null };
  reader.feed(`${JSON.stringify(step)}\n${JSON.stringify({ ...step, id: "step_0_1" })}\n`);
  reader.feed(`${JSON.stringify({ ...step, status: "done", summary: "12 results" })}\n`);
  reader.feed('{"type":"sources","sources":[{"title":"a","url":"https://g1t.sh/a","cited":true}]}\n');
  reader.feed('{"type":"sources","sources":[{"title":"b","url":"https://g1t.sh/b","cited":true}]}\n');
  const steps = reader.answer.steps ?? [];
  assert.deepEqual(
    steps.map((kept) => [kept.type, kept.id ?? null, kept.status ?? null]),
    [
      ["tool", "step_0_0", "done"],
      ["tool", "step_0_1", "running"],
      ["sources", null, null],
    ],
  );
  assert.equal((steps[2] as { sources: { title: string }[] }).sources[0]!.title, "b");
});

test("an answer that breaks off or fails is never silence", () => {
  const broken = new AnswerReader();
  broken.feed('{"type":"text","text":"Half"}\n');
  broken.finish();
  assert.equal(broken.answer.state, "error");
  assert.equal(finalBody(broken.body, broken.answer), "Half");
  const failed = new AnswerReader();
  failed.feed('{"type":"error","message":"Anthropic said the key is invalid."}');
  failed.finish();
  assert.equal(failed.answer.state, "error");
  assert.equal(finalBody(failed.body, failed.answer), "I couldn't answer that: Anthropic said the key is invalid.");
  const stopped = new AnswerReader();
  stopped.stop();
  assert.equal(finalBody(stopped.body, stopped.answer), "_Stopped before answering._");
});

test("one person's answers are limited to twenty a minute", () => {
  let times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const next = answerAllowed(times, 1_000 + i);
    assert.ok(next.ok);
    times = next.times;
  }
  assert.ok(!answerAllowed(times, 2_000).ok);
  assert.ok(answerAllowed(times, 70_000).ok);
});

test("an answer left mid-stream by a room that went away shows as stopped", () => {
  const at = "2026-10-12T00:00:00Z";
  assert.equal(shownAnswer({ state: "streaming" }, at, Date.parse(at) + 60_000)!.state, "streaming");
  assert.equal(shownAnswer({ state: "streaming" }, at, Date.parse(at) + 3_600_000)!.state, "stopped");
  assert.equal(shownAnswer({ state: "done" }, at, Date.parse(at) + 3_600_000)!.state, "done");
  assert.equal(shownAnswer(undefined, at, 0), null);
});

test("what a proposal's card did is kept on its answer, merged step by step", () => {
  const answer = { state: "done" as const, steps: [{ type: "proposal", id: "proposal_1_0", repo: "acme/hello" }] };
  assert.equal(withProposalState(answer, { id: "proposal_9_9" }), null, "no such proposal");
  const made = withProposalState(answer, { id: "proposal_1_0", starting_at: 5, repo_url: "/acme/hello", production_url: "https://hello-acme.g1t.page" })!;
  assert.deepEqual(made.state, { id: "proposal_1_0", starting_at: 5, repo_url: "/acme/hello", production_url: "https://hello-acme.g1t.page" });
  assert.equal(made.answer.steps!.length, 2);
  // A later step merges into the same one; unknown fields are dropped.
  const started = withProposalState(made.answer, { id: "proposal_1_0", item: 1, started: true, session_url: "/s", evil: "x" } as never)!;
  assert.equal(started.answer.steps!.length, 2);
  assert.deepEqual(started.answer.steps![1], {
    type: "proposal_state",
    id: "proposal_1_0",
    starting_at: 5,
    repo_url: "/acme/hello",
    production_url: "https://hello-acme.g1t.page",
    item: 1,
    started: true,
    session_url: "/s",
  });
  // Only the id: says what is kept, changes nothing.
  assert.deepEqual(withProposalState(started.answer, { id: "proposal_1_0" })!.state, started.state);
});
