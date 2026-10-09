import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemberProfile } from "@g1t/contracts";

import { conversationHref, countsAfterRead, messageDeliveries, preview, recipients, type Person } from "./notify.ts";

const person = (id: string, username: string, muted = false): Person => ({ key: `user:${id}`, user_id: id, username, muted });
const ana = person("u1", "ana");
const bo = person("u2", "bo");
const cy = person("u3", "cy", true);

const kinds = (list: ReturnType<typeof recipients>) => Object.fromEntries(list.map((r) => [r.user_id, r.kind]));

test("a direct message notifies everyone else in it, muted or not, never the author", () => {
  const out = recipients({ author: "user:u1", channelKind: "dm", people: [ana, bo, cy], mentioned: [], thread: null });
  assert.deepEqual(kinds(out), { u2: "dm", u3: "dm" });
});

test("in a channel, a mention notifies the person named even when muted; the rest only count", () => {
  const out = recipients({ author: "user:u1", channelKind: "channel", people: [ana, bo, cy], mentioned: ["CY"], thread: null });
  assert.deepEqual(kinds(out), { u2: null, u3: "mention" });
  assert.deepEqual(
    out.map((r) => [r.user_id, r.mentioned, r.muted]),
    [
      ["u2", false, false],
      ["u3", true, true],
    ],
  );
});

test("a reply notifies the people in its thread unless they muted the conversation", () => {
  const out = recipients({ author: "user:u1", channelKind: "channel", people: [ana, bo, cy], mentioned: [], thread: new Set(["user:u1", "user:u2", "user:u3"]) });
  assert.deepEqual(kinds(out), { u2: "thread_reply", u3: null });
});

test("an agent's message notifies the people in its DM and counts for everyone", () => {
  const out = recipients({ author: "agent:a1", channelKind: "dm", people: [ana], mentioned: [], thread: null });
  assert.deepEqual(kinds(out), { u1: "dm" });
});

test("deliveries: counts for everyone, a notification for those it is for, the author's count cleared", () => {
  const author: MemberProfile = { kind: "user", id: "u1", name: "ana", display_name: "Ana Lima", avatar: "abc", role: null, avatar_seed: null };
  const items = messageDeliveries({
    slug: "acme",
    channel: { id: "chn_1", kind: "channel", name: "design" },
    message: { id: "msg_1", author: "user:u1", body: "hey **@bo** look", card_title: null, thread_root: null, created_at: "2026-10-08T00:00:00Z" },
    author,
    recipients: recipients({ author: "user:u1", channelKind: "channel", people: [ana, bo, cy], mentioned: ["bo"], thread: null }),
  });
  assert.equal(items.length, 3);
  const [toBo, toCy, self] = items;
  assert.deepEqual(toBo.counts, { channel_id: "chn_1", unread: 1, mentions: 1, muted: false });
  assert.equal(toBo.notification?.kind, "mention");
  assert.equal(toBo.notification?.title, "Ana Lima in #design");
  assert.equal(toBo.notification?.body, "hey @bo look");
  assert.equal(toBo.notification?.href, "/acme/-/chat/design");
  assert.equal(toBo.notification?.actor.avatar, "abc");
  assert.deepEqual(toCy.counts, { channel_id: "chn_1", unread: 1, mentions: 0, muted: true });
  assert.equal(toCy.notification, null);
  assert.deepEqual(self, { user_id: "u1", workspace: "acme", counts: { channel_id: "chn_1", unread: 0, mentions: 0, set: true }, notification: null });
});

test("a person without a display name is named by their username as they wrote it", () => {
  const author: MemberProfile = { kind: "user", id: "u1", name: "ana", display_username: "Ana", display_name: "", avatar: null, role: null, avatar_seed: null };
  const [toBo] = messageDeliveries({
    slug: "acme",
    channel: { id: "chn_9", kind: "dm", name: null },
    message: { id: "msg_2", author: "user:u1", body: "hi", card_title: null, thread_root: null, created_at: "2026-10-08T00:00:00Z" },
    author,
    recipients: recipients({ author: "user:u1", channelKind: "dm", people: [ana, bo], mentioned: [], thread: null }),
  });
  assert.equal(toBo.notification?.title, "Ana");
  assert.equal(toBo.notification?.actor.name, "Ana");
});

test("a reply links to its thread; a DM to the DM", () => {
  assert.equal(conversationHref("acme", { id: "chn_9", kind: "dm", name: null }, null), "/acme/-/chat/dm/chn_9");
  assert.equal(conversationHref("acme", { id: "chn_1", kind: "channel", name: "ops" }, "msg_1"), "/acme/-/chat/ops?thread=msg_1");
});

test("previews are one short line without markup", () => {
  assert.equal(preview("**bold**  and `code`\n\nnext [link](https://x)"), "bold and code next link");
  assert.equal(preview("```\nlong code\n```"), "[code]");
  assert.equal(preview("x".repeat(300)).length, 140);
});

test("counts after a read: what is left past the mark, mentions included, never your own", () => {
  const rows = [
    { channel_id: "c", id: "m3", author: "user:u2", mentions: " ana " },
    { channel_id: "c", id: "m4", author: "user:u1", mentions: "" },
    { channel_id: "c", id: "m5", author: "agent:a1", mentions: "" },
  ];
  assert.deepEqual(countsAfterRead(rows, "c", "user:u1", "ana", "m2"), { unread: 2, mentions: 1 });
  assert.deepEqual(countsAfterRead([], "c", "user:u1", "ana", "m9"), { unread: 0, mentions: 0 });
});
