import { test } from "node:test";
import assert from "node:assert/strict";

import { dmTitle, isUnread, sidebarOrder, tally } from "./unread.ts";

test("unread is what others wrote after your last read", () => {
  assert.equal(isUnread({ id: "msg_2", author: "user:b" }, "user:a", "msg_1"), true);
  assert.equal(isUnread({ id: "msg_1", author: "user:b" }, "user:a", "msg_1"), false);
  assert.equal(isUnread({ id: "msg_2", author: "user:a" }, "user:a", "msg_1"), false);
  assert.equal(isUnread({ id: "msg_0", author: "agent:x" }, "user:a", null), true);
});

test("counts per channel, replies included, with mentions of the viewer", () => {
  const rows = [
    { channel_id: "c1", id: "m1", author: "user:b", mentions: "" },
    { channel_id: "c1", id: "m2", author: "agent:x", mentions: " syntaqx " },
    { channel_id: "c1", id: "m3", author: "user:a", mentions: " syntaqx " },
    { channel_id: "c2", id: "m4", author: "user:b", mentions: " syntaqxx " },
    { channel_id: "c2", id: "m0", author: "user:b", mentions: " syntaqx " },
  ];
  const counts = tally(rows, "user:a", "syntaqx", new Map([["c1", null], ["c2", "m1"]]));
  assert.deepEqual(counts.get("c1"), { unread: 2, mentions: 1 });
  // m0 was read already, and @syntaqxx is someone else.
  assert.deepEqual(counts.get("c2"), { unread: 1, mentions: 0 });
  assert.equal(counts.get("c3"), undefined);
});

test("the sidebar puts starred first, then the most recently active", () => {
  const entry = (title: string, starred: boolean, at: string | null) => ({
    title,
    starred,
    channel: { last_message_at: at, created_at: "2026-10-01T00:00:00.000Z" },
  });
  const ordered = sidebarOrder([
    entry("quiet", false, null),
    entry("busy", false, "2026-10-08T10:00:00.000Z"),
    entry("pinned", true, "2026-10-02T00:00:00.000Z"),
    entry("older", false, "2026-10-05T00:00:00.000Z"),
  ]);
  assert.deepEqual(ordered.map((e) => e.title), ["pinned", "busy", "older", "quiet"]);
});

test("a direct message is titled by the others, or by you for notes", () => {
  const p = (display_name: string) => ({ display_name });
  assert.equal(dmTitle([p("Ada")], p("Me")), "Ada");
  assert.equal(dmTitle([p("Ada"), p("Ship")], p("Me")), "Ada, Ship");
  assert.equal(dmTitle([p("A"), p("B"), p("C"), p("D"), p("E")], p("Me")), "A, B, C and 2 more");
  assert.equal(dmTitle([], p("Chase")), "Chase (you)");
});
