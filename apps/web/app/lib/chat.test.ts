import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage, ChatSidebarEntry } from "@g1t/contracts";

import {
  backoff,
  blocks,
  channelName,
  channelPath,
  dayLabel,
  filterEntries,
  inline,
  mentionQuery,
  mergeMessages,
  safeHref,
  sections,
  timeline,
  unreadTotals,
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
  ];
  const { pinned, channels, agentDms, dms } = sections(all);
  assert.deepEqual(pinned.map((e) => e.title), ["general"]);
  assert.deepEqual(channels.map((e) => e.title), ["noisy", "random"]);
  // A direct message with one agent is the agent's, under Agents.
  assert.deepEqual(dms.map((e) => e.title), ["ana"]);
  assert.equal(agentDms.get("a1")?.title, "reviewer");
  assert.deepEqual(filterEntries(all, "unread", "").map((e) => e.title), ["general", "reviewer", "noisy"]);
  assert.deepEqual(filterEntries(all, "mentions", "").map((e) => e.title), ["reviewer"]);
  assert.deepEqual(filterEntries(all, "all", "@Review").map((e) => e.title), ["reviewer"]);
  assert.deepEqual(unreadTotals(all), { unread: 3, mentions: 1 });
});

test("addresses, names, money and reconnecting", () => {
  assert.equal(channelPath("acme", { id: "c1", kind: "channel", name: "general" }), "/acme/-/chat/general");
  assert.equal(channelPath("acme", { id: "d1", kind: "dm", name: null }), "/acme/-/chat/dm/d1");
  assert.equal(channelName("#Release Train_2!"), "release-train-2");
  assert.equal(backoff(0, () => 0.5), 1000);
  assert.equal(backoff(10, () => 0.5), 30_000);
});
