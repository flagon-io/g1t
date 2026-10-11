import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage, ChatSidebarEntry } from "@g1t/contracts";

import {
  agentsToTalkTo,
  archivedAgentLine,
  archivedAgentWhen,
  archivedAgentsDm,
  backoff,
  blocks,
  channelName,
  channelPath,
  dayLabel,
  dmPlaceholder,
  filterEntries,
  inline,
  mixedDm,
  mixedNotice,
  mentionNames,
  mentionQuery,
  mergeMessages,
  safeHref,
  sections,
  shownHandle,
  shownName,
  timeline,
  typingLabel,
  unreadTotals,
  WORKING_AFTER_MS,
  agentDoing,
  type ShownMessage,
} from "./chat.ts";

const ana = { kind: "user" as const, id: "u1", name: "ana", display_name: "Ana", avatar: null, role: null };
const bot = { kind: "agent" as const, id: "a1", name: "reviewer", display_name: "Reviewer", avatar: null, role: "Reviews pull requests" };

function message(id: string, at: string, over: Partial<ChatMessage> = {}): ShownMessage {
  return {
    id,
    channel_id: "c1",
    author: ana,
    kind: "text",
    body: "hi",
    card: null,
    thread_root: null,
    reply_count: 0,
    last_reply_at: null,
    created_at: at,
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

test("messages from one author close together share a header; days get a rule", () => {
  const now = new Date("2026-10-08T15:00:00Z");
  const rows = timeline(
    [
      message("01", "2026-10-07T10:00:00Z"),
      message("02", "2026-10-08T10:00:00Z"),
      message("03", "2026-10-08T10:02:00Z"),
      message("04", "2026-10-08T10:03:00Z", { author: bot }),
      message("05", "2026-10-08T10:30:00Z", { author: bot }),
      message("06", "2026-10-08T10:31:00Z", { author: bot, kind: "card" }),
      message("07", "2026-10-08T10:32:00Z", { deleted_at: "2026-10-08T10:33:00Z" }),
    ],
    now,
    "UTC",
  );
  assert.deepEqual(
    rows.map((row) => (row.kind === "day" ? row.label : `${row.message.id}${row.head ? "*" : ""}`)),
    ["Yesterday", "01*", "Today", "02*", "03", "04*", "05*", "06*"],
  );
  assert.equal(dayLabel("2026-09-01T10:00:00Z", now, "UTC"), "Tuesday, September 1");
});

test("merging keeps one copy of each message, and drops the pending one once saved", () => {
  const pending = { ...message("tmp-1", "2026-10-08T10:00:00Z"), pending: true, client_id: "tmp-1" };
  const saved = { ...message("05", "2026-10-08T10:00:01Z"), client_id: "tmp-1" };
  const merged = mergeMessages([message("02", "2026-10-08T09:00:00Z"), pending], [saved, message("02", "2026-10-08T09:00:00Z", { body: "edited" })]);
  assert.deepEqual(merged.map((m) => m.id), ["02", "05"]);
  assert.equal(merged[0]!.body, "edited");
  // Still pending: last, after everything saved.
  assert.deepEqual(mergeMessages([pending], [message("09", "2026-10-08T11:00:00Z")]).map((m) => m.id), ["09", "tmp-1"]);
});

test("an @ being typed suggests people and agents", () => {
  const people = [
    { kind: "user" as const, name: "ana", display_name: "Ana Lima", avatar: null },
    { kind: "agent" as const, name: "reviewer", display_name: "Reviewer", avatar: null },
    { kind: "user" as const, name: "bo", display_name: "Robert Reed", avatar: null },
  ];
  assert.deepEqual(mentionQuery("hey @re", 7, people)?.options.map((p) => p.name), ["reviewer", "bo"]);
  assert.equal(mentionQuery("hey @re", 7, people)?.start, 4);
  assert.equal(mentionQuery("mail me@an", 10, people), null);
  assert.deepEqual(mentionQuery("@", 1, people)?.options.length, 3);
  assert.equal(mentionQuery("@zz", 3, people), null);
});

test("message text: mentions, references, links and code, never HTML", () => {
  assert.deepEqual(inline("ask @reviewer about #12 and g1t#3"), [
    { t: "text", v: "ask " },
    { t: "mention", name: "reviewer" },
    { t: "text", v: " about " },
    { t: "ref", repo: null, number: 12 },
    { t: "text", v: " and " },
    { t: "ref", repo: "g1t", number: 3 },
  ]);
  assert.deepEqual(inline("see #general, `a <b>` **bold**"), [
    { t: "text", v: "see " },
    { t: "channel", name: "general" },
    { t: "text", v: ", " },
    { t: "code", v: "a <b>" },
    { t: "text", v: " " },
    { t: "strong", c: [{ t: "text", v: "bold" }] },
  ]);
  assert.ok(inline("[x](javascript:alert(1))").every((span) => span.t === "text"));
  assert.deepEqual(inline("https://g1t.sh/a."), [{ t: "link", href: "https://g1t.sh/a", c: [{ t: "text", v: "https://g1t.sh/a" }] }, { t: "text", v: "." }]);
  assert.deepEqual(inline("me@example.com"), [{ t: "text", v: "me@example.com" }]);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("/acme/web/pull/3"), "/acme/web/pull/3");
});

test("message blocks: fenced code, lists, quotes and paragraphs", () => {
  const parsed = blocks("Plan:\n- one\n- two\n\n```ts\nconst a = 1;\n```\n> quoted\nlast");
  assert.deepEqual(parsed.map((block) => block.t), ["p", "list", "code", "quote", "p"]);
  assert.deepEqual(parsed[2], { t: "code", lang: "ts", v: "const a = 1;" });
});

function entry(id: string, over: Partial<ChatSidebarEntry> & { kind?: "channel" | "dm"; last?: string } = {}): ChatSidebarEntry {
  return {
    channel: {
      id,
      workspace_id: "w",
      kind: over.kind ?? "channel",
      name: over.kind === "dm" ? null : id,
      topic: null,
      private: false,
      created_by: { kind: "user", id: "u1" },
      created_at: "2026-10-01T00:00:00Z",
      archived_at: null,
      last_message_at: over.last ?? null,
    },
    title: over.title ?? id,
    others: over.others ?? [],
    starred: over.starred ?? false,
    muted: over.muted ?? false,
    unread: over.unread ?? 0,
    mentions: over.mentions ?? 0,
  };
}

test("the sidebar: sections, filters and the rail's count", () => {
  const all = [
    entry("random"),
    entry("general", { starred: true, unread: 2 }),
    entry("d1", { kind: "dm", title: "reviewer", others: [bot], last: "2026-10-02T00:00:00Z", mentions: 1, unread: 1 }),
    entry("d2", { kind: "dm", title: "ana", others: [ana], last: "2026-10-05T00:00:00Z" }),
    entry("noisy", { muted: true, unread: 9 }),
    // Ana and the reviewer together: a person is in it, so it lists under People, marked as mixed.
    entry("d3", { kind: "dm", title: "ana, reviewer", others: [ana, bot], last: "2026-10-03T00:00:00Z" }),
    entry("d4", { kind: "dm", title: "notes", others: [], last: "2026-10-01T00:00:00Z" }),
  ];
  const { pinned, channels, agentDms, people, agents } = sections(all);
  assert.deepEqual(pinned.map((e) => e.title), ["general"]);
  assert.deepEqual(channels.map((e) => e.title), ["noisy", "random"]);
  // Direct messages in two buckets, each the latest first: people (mixed ones and your notes among them), and agents alone.
  assert.deepEqual(people.map((e) => e.title), ["ana", "ana, reviewer", "notes"]);
  assert.deepEqual(agents.map((e) => e.title), ["reviewer"]);
  assert.equal(agentDms.get("a1")?.title, "reviewer", "the agent's own conversation, not the mixed one");
  assert.deepEqual(all.map(mixedDm), [false, false, false, false, false, true, false]);
  assert.deepEqual(filterEntries(all, "unread", "").map((e) => e.title), ["general", "reviewer", "noisy"]);
  assert.deepEqual(filterEntries(all, "mentions", "").map((e) => e.title), ["reviewer"]);
  // Jump to finds the agent's own conversation and the mixed one it is in.
  assert.deepEqual(filterEntries(all, "all", "@Review").map((e) => e.title), ["reviewer", "ana, reviewer"]);
  assert.deepEqual(unreadTotals(all), { unread: 3, mentions: 1 });
});

test("an archived agent's conversation leaves the list until searched for or open; the agent itself is no longer offered", () => {
  const archived = { ...bot, id: "a2", name: "scribe", display_name: "Scribe", archived_at: "2026-10-08T09:00:00Z", archived_by: "ana" };
  const all = [
    entry("d1", { kind: "dm", title: "reviewer", others: [bot], last: "2026-10-02T00:00:00Z" }),
    entry("d2", { kind: "dm", title: "scribe", others: [archived], last: "2026-10-05T00:00:00Z" }),
    // With a person in it, the conversation is theirs to go on with: not an archived one.
    entry("d3", { kind: "dm", title: "ana, scribe", others: [ana, archived], last: "2026-10-03T00:00:00Z" }),
    // Two agents, one archived: the live one still answers.
    entry("d4", { kind: "dm", title: "reviewer, scribe", others: [bot, archived], last: "2026-10-04T00:00:00Z" }),
    // Deleted for good: the conversation stays readable, under the name it had.
    entry("d5", { kind: "dm", title: "triage", others: [{ ...bot, id: "a9", name: "triage", display_name: "Triage", deleted: true }], last: "2026-10-01T00:00:00Z" }),
  ];
  const { agents, agentDms } = sections(all);
  assert.deepEqual(agents.map((e) => e.title), ["scribe", "reviewer, scribe", "reviewer", "triage"]);
  assert.deepEqual(all.map((e) => archivedAgentsDm(e)?.name ?? null), [null, "scribe", null, null, "triage"]);
  assert.equal(archivedAgentsDm(all[4]!)?.deleted, true);
  // Not listed on their own; found by name; kept while open.
  assert.deepEqual(filterEntries(all, "all", "").map((e) => e.title), ["reviewer", "ana, scribe", "reviewer, scribe"]);
  assert.deepEqual(filterEntries(all, "all", "scri").map((e) => e.title), ["scribe", "ana, scribe", "reviewer, scribe"]);
  assert.deepEqual(filterEntries(all, "all", "", "d5").map((e) => e.title), ["reviewer", "ana, scribe", "reviewer, scribe", "triage"]);
  // The agents you haven't talked to yet: live ones without a conversation, g1t first; never an archived one.
  const roster = [
    { id: "a1", handle: "reviewer", display_name: "Reviewer", role: "Reviews", builtin: false, archived_at: null },
    { id: "a2", handle: "scribe", display_name: "Scribe", role: "Writes", builtin: false, archived_at: "2026-10-08T09:00:00Z" },
    { id: "a3", handle: "zed", display_name: "Zed", role: "Ships", builtin: false, archived_at: null },
    { id: "a4", handle: "g1t", display_name: "g1t", role: "Orchestrates", builtin: true, archived_at: null },
    { id: "a5", handle: "old", display_name: "Old", role: "Nothing", builtin: false, archived_at: "2026-09-01T00:00:00Z" },
  ];
  assert.deepEqual(agentsToTalkTo(roster, agentDms).map((a) => a.handle), ["g1t", "zed"]);
  assert.deepEqual(agentsToTalkTo(roster, agentDms, "@ship").map((a) => a.handle), ["zed"]);
  assert.deepEqual(agentsToTalkTo(roster, new Map()).map((a) => a.handle), ["g1t", "reviewer", "zed"]);
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(archivedAgentLine(archived, now), "Scribe was archived 2 days ago by @ana. It no longer answers here.");
  assert.equal(archivedAgentLine({ ...archived, archived_by: null, archived_at: "2026-10-10T11:30:00Z" }, now), "Scribe was archived 30 minutes ago. It no longer answers here.");
  assert.equal(archivedAgentLine({ ...archived, archived_by: null, archived_at: null }, now), "Scribe was archived. It no longer answers here.");
  assert.equal(archivedAgentWhen(archived, now), "Archived 2 days ago by @ana");
  assert.equal(archivedAgentWhen({ archived_at: "2026-10-10T11:00:00Z", archived_by: null }, now), "Archived 1 hour ago");
});

test("a mixed conversation says who the agents are, in the composer and above its first message", () => {
  assert.equal(dmPlaceholder([ana, bot]), "Message @ana and @reviewer (agent)");
  assert.equal(dmPlaceholder([{ ...ana, display_username: "Ana" }, bot, { ...bot, id: "a2", name: "scribe", display_name: "Scribe" }]), "Message @Ana, @reviewer (agent) and @scribe (agent)");
  assert.equal(dmPlaceholder([]), "Message yourself");
  assert.equal(mixedNotice([ana, bot]), "Reviewer is an agent and reads everything here; it can act on what you say.");
  assert.equal(mixedNotice([ana, bot, { ...bot, id: "a2", name: "scribe", display_name: "Scribe" }]), "Reviewer and Scribe are agents and read everything here; they can act on what you say.");
  assert.equal(mixedNotice([ana]), "");
});

test("addresses, names, money and reconnecting", () => {
  assert.equal(channelPath("acme", { id: "c1", kind: "channel", name: "general" }), "/acme/-/chat/general");
  assert.equal(channelPath("acme", { id: "d1", kind: "dm", name: null }), "/acme/-/chat/dm/d1");
  assert.equal(channelName("#Release Train_2!"), "release-train-2");
  assert.equal(backoff(0, () => 0.5), 1000);
  assert.equal(backoff(10, () => 0.5), 30_000);
});

test("a member shows by display name, else by their username as they wrote it", () => {
  assert.equal(shownName({ name: "ana", display_name: "Ana Lima", display_username: "Ana" }), "Ana Lima");
  assert.equal(shownName({ name: "ana", display_name: " ", display_username: "Ana" }), "Ana");
  assert.equal(shownName({ name: "ana", display_name: "" }), "ana");
  assert.equal(shownHandle({ name: "ana", display_username: "Ana" }), "Ana");
  assert.equal(shownHandle({ name: "ana", display_username: "Bo" }), "ana");
});

test("mentions read as the names people know, found by the lowercased handle", () => {
  const names = mentionNames([
    { kind: "user", name: "ana", display_username: "Ana", display_name: "Ana Lima", avatar: null },
    { kind: "user", name: "bo", display_username: "Bo", display_name: "", avatar: null },
    { kind: "agent", name: "reviewer", display_name: "Reviewer", avatar: null },
  ]);
  assert.equal(names.get("ana"), "Ana Lima");
  assert.equal(names.get("bo"), "Bo");
  assert.equal(names.get("reviewer"), "Reviewer");
  assert.equal(names.get("cy"), undefined);
});

test("the typing line: people type, an agent does what its phrase says, then is still working on it", () => {
  const now = 100_000;
  const mike = { kind: "agent" as const, id: "a2", name: "mike", display_name: "Mike", avatar: null, role: null };
  assert.equal(typingLabel([], now), null);
  assert.deepEqual(typingLabel([{ member: ana, since: now - 60_000 }], now), { who: "Ana", doing: "is typing" }, "a person is never 'working'");
  assert.deepEqual(typingLabel([{ member: bot, since: now - 2_000 }], now), { who: "Reviewer", doing: agentDoing("a1") });
  assert.match(agentDoing("a1"), /^is /);
  assert.deepEqual(typingLabel([{ member: bot, since: now - WORKING_AFTER_MS }], now), { who: "Reviewer", doing: "is still working on it" });
  // Mike and @g1t on one reply each: on it, then still working, as the user saw them vanish after eight seconds before.
  assert.deepEqual(typingLabel([{ member: mike, since: now - 3_000 }, { member: bot, since: now - 1_000 }], now), { who: "Mike and Reviewer", doing: "are on it" });
  assert.deepEqual(typingLabel([{ member: mike, since: now - 30_000 }, { member: bot, since: now - 1_000 }], now), { who: "Mike and Reviewer", doing: "are still working on it" });
  assert.deepEqual(typingLabel([{ member: ana, since: now }, { member: bot, since: now - 30_000 }], now), { who: "Ana and Reviewer", doing: "are typing" }, "people and agents together");
  const third = { ...ana, id: "u3", name: "bo", display_name: "Bo" };
  assert.deepEqual(typingLabel([{ member: ana, since: now }, { member: bot, since: now }, { member: third, since: now }], now), { who: "Several people", doing: "are typing" });
  assert.deepEqual(typingLabel([{ member: mike, since: now }, { member: bot, since: now }, { member: { ...mike, id: "a3", name: "sam", display_name: "Sam" }, since: now }], now), { who: "Several agents", doing: "are on it" });
});
