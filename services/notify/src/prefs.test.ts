import assert from "node:assert/strict";
import { test } from "node:test";

import type { FeedNotification } from "@g1t/contracts";

import { applyCounts, totals } from "./counts.ts";
import { STALE_MS, anyFocused, cleanCard, cleanNotification, decide, levelFor, mergePreferences, pushActions, pushPayload, readPreferences, wants } from "./prefs.ts";

const NOW = 1_800_000_000_000;
const dms = { level: "dms_mentions" as const, workspaces: {} };

test("the default hears of what is said to you or waits on you, not everything", () => {
  assert.deepEqual(readPreferences(null), dms);
  for (const kind of ["dm", "mention", "thread_reply", "agent_waiting", "approval"] as const) assert.ok(wants("dms_mentions", kind), kind);
  assert.ok(!wants("dms_mentions", "inbox"));
  assert.ok(wants("all", "inbox"));
  for (const kind of ["dm", "mention", "inbox"] as const) assert.ok(!wants("none", kind));
});

test("a workspace's own level wins over the general one", () => {
  const prefs = mergePreferences(dms, { workspaces: { Acme: "none", side: "all" } });
  assert.equal(levelFor(prefs, "acme"), "none");
  assert.equal(levelFor(prefs, "side"), "all");
  assert.equal(levelFor(prefs, "other"), "dms_mentions");
});

test("changes are checked: unknown levels ignored, null clears, the same as the general level is no override", () => {
  let prefs = mergePreferences(dms, { level: "loud", workspaces: { a: "all", b: "bogus" } });
  assert.deepEqual(prefs, { level: "dms_mentions", workspaces: { a: "all" } });
  prefs = mergePreferences(prefs, { workspaces: { a: null } });
  assert.deepEqual(prefs.workspaces, {});
  prefs = mergePreferences(mergePreferences(dms, { workspaces: { a: "all" } }), { level: "all" });
  assert.deepEqual(prefs, { level: "all", workspaces: {} });
  assert.deepEqual(readPreferences("not json"), dms);
  assert.deepEqual(mergePreferences(dms, "nonsense"), dms);
});

test("a tab counts as in front of you only while focused and recently heard from", () => {
  assert.ok(anyFocused([{ focused: true, seen_at: NOW - 1000 }], NOW));
  assert.ok(!anyFocused([{ focused: true, seen_at: NOW - STALE_MS - 1 }], NOW));
  assert.ok(!anyFocused([{ focused: false, seen_at: NOW }], NOW));
  assert.ok(!anyFocused([], NOW));
});

test("push only when no tab is focused, there is a browser to push to, and the level wants it", () => {
  const dm = { kind: "dm" as const, workspace: "acme" };
  const away = [{ focused: false, seen_at: NOW }];
  const here = [{ focused: true, seen_at: NOW }];
  assert.deepEqual(decide({ prefs: dms, notification: dm, tabs: away, subscriptions: 1, now: NOW }), { toast: true, push: true });
  assert.deepEqual(decide({ prefs: dms, notification: dm, tabs: here, subscriptions: 1, now: NOW }), { toast: true, push: false });
  assert.deepEqual(decide({ prefs: dms, notification: dm, tabs: [], subscriptions: 0, now: NOW }), { toast: true, push: false });
  // No tab open at all: pushed.
  assert.deepEqual(decide({ prefs: dms, notification: dm, tabs: [], subscriptions: 2, now: NOW }), { toast: true, push: true });
  // A focused tab gone quiet (the laptop slept): pushed.
  assert.equal(decide({ prefs: dms, notification: dm, tabs: [{ focused: true, seen_at: NOW - STALE_MS * 2 }], subscriptions: 1, now: NOW }).push, true);
  const inbox = { kind: "inbox" as const, workspace: "acme" };
  assert.deepEqual(decide({ prefs: dms, notification: inbox, tabs: away, subscriptions: 1, now: NOW }), { toast: false, push: false });
  const muted = mergePreferences(dms, { workspaces: { acme: "none" } });
  assert.deepEqual(decide({ prefs: muted, notification: dm, tabs: away, subscriptions: 1, now: NOW }), { toast: false, push: false });
  // A test goes through whatever the preferences and focus.
  assert.deepEqual(decide({ prefs: muted, notification: dm, tabs: here, subscriptions: 1, now: NOW, test: true }), { toast: true, push: true });
});

test("notifications are cleaned: kinds checked, links kept on the site, text trimmed", () => {
  assert.equal(cleanNotification({ id: "x", kind: "shout", title: "t" }), null);
  assert.equal(cleanNotification({ kind: "dm", title: "t" }), null);
  const n = cleanNotification({
    id: "n1",
    kind: "mention",
    workspace: "Acme",
    title: " Ana in #design ",
    body: "x".repeat(1000),
    href: "//evil.example/",
    actor: { kind: "user", id: "usr_1", name: "Ana", avatar: "abc" },
    channel_id: "chn_1",
  })!;
  assert.equal(n.workspace, "acme");
  assert.equal(n.title, "Ana in #design");
  assert.equal(n.body.length, 300);
  assert.equal(n.href, "/");
  assert.equal(n.actor.avatar, "abc");
  assert.equal(n.actor.avatar_seed, null);
  assert.equal(cleanNotification({ id: "n2", kind: "dm", title: "t", href: "/acme/-/chat/dm/chn_1", actor: { kind: "robot" } })!.actor.kind, "system");
});

test("a push is small and collapses by conversation", () => {
  const n: FeedNotification = {
    id: "msg_1",
    kind: "dm",
    workspace: "acme",
    title: "Ana",
    body: "y".repeat(400),
    href: "/acme/-/chat/dm/chn_1",
    actor: { kind: "user", id: "usr_1", name: "Ana" },
    channel_id: "chn_1",
    created_at: "2026-10-08T00:00:00Z",
  };
  const payload = pushPayload(n);
  assert.equal(payload.tag, "chat:chn_1");
  assert.equal(payload.body.length, 240);
  assert.equal(payload.urgent, true);
  assert.equal(pushPayload({ ...n, kind: "inbox", channel_id: null }).tag, "inbox:msg_1");
});

test("counts add up, replace on set, never go below zero, and keep mute", () => {
  let c = applyCounts(null, { channel_id: "c", unread: 1, mentions: 0 });
  c = applyCounts(c, { channel_id: "c", unread: 1, mentions: 1, muted: true });
  assert.deepEqual(c, { channel_id: "c", unread: 2, mentions: 1, muted: true });
  c = applyCounts(c, { channel_id: "c", unread: -5, mentions: -5 });
  assert.deepEqual(c, { channel_id: "c", unread: 0, mentions: 0, muted: true });
  c = applyCounts(c, { channel_id: "c", unread: 3, mentions: 0, set: true });
  assert.deepEqual(c, { channel_id: "c", unread: 3, mentions: 0, muted: true });
});

test("totals leave muted unread out, as the rail does, but count their mentions", () => {
  const t = totals(
    "acme",
    [
      { channel_id: "a", unread: 3, mentions: 1, muted: false },
      { channel_id: "b", unread: 5, mentions: 2, muted: true },
      { channel_id: "c", unread: 0, mentions: 0, muted: false },
    ],
    4,
    true,
  );
  assert.deepEqual(t, {
    workspace: "acme",
    chat_unread: 3,
    chat_mentions: 3,
    inbox_unread: 4,
    per_channel: [
      { channel_id: "a", unread: 3, mentions: 1 },
      { channel_id: "b", unread: 5, mentions: 2 },
    ],
    complete: true,
  });
});

const capped = {
  channel_id: "chn_1",
  message_id: "msg_card",
  actions: [
    { id: "approve", label: "Approve more", style: "primary", input: { kind: "money", label: "New cap", initial: "4.00" } },
    { id: "stop", label: "Stop", style: "danger", confirm: "Stop this session and everything under it?" },
    { id: "open", label: "Open", href: "/acme/-/agents/g1t/sessions/ses_1" },
  ],
};

test("a notification's card is checked: its place, its actions, links kept on the site", () => {
  const card = cleanCard(capped)!;
  assert.equal(card.message_id, "msg_card");
  assert.deepEqual(
    card.actions.map((a) => [a.id, a.style, a.input?.kind ?? null, a.href ?? null]),
    [
      ["approve", "primary", "money", null],
      ["stop", "danger", null, null],
      ["open", "default", null, "/acme/-/agents/g1t/sessions/ses_1"],
    ],
  );
  assert.equal(card.actions[1].confirm, "Stop this session and everything under it?");
  assert.equal(cleanCard({ ...capped, actions: [{ id: "x", label: "X", href: "https://evil.example/" }] })!.actions[0].href, null);
  assert.equal(cleanCard({ ...capped, message_id: "" }), null);
  assert.equal(cleanCard({ ...capped, actions: [{ id: "", label: "" }] }), null);
  assert.equal(cleanCard("nope"), null);
  // Carried on the notification when it is one; left off otherwise.
  const n = cleanNotification({ id: "approval:ses_1:2000000", kind: "approval", workspace: "acme", title: "g1t needs more budget", card: capped })!;
  assert.equal(n.card?.actions.length, 3);
  assert.equal("card" in cleanNotification({ id: "n", kind: "dm", title: "t" })!, false);
});

test("a push shows only the card's actions that need nothing typed or confirmed, two at most", () => {
  const card = cleanCard(capped)!;
  // Stop asks first in the app; a push can't, so it isn't offered there.
  assert.deepEqual(pushActions(card), [{ id: "open", label: "Open", href: "/acme/-/agents/g1t/sessions/ses_1" }]);
  assert.deepEqual(pushActions(null), []);
  const payload = pushPayload({
    id: "approval:ses_1:2000000",
    kind: "approval",
    workspace: "acme",
    title: "g1t needs more budget",
    body: "",
    href: "/acme/-/agents/g1t/sessions/ses_1",
    actor: { kind: "agent", id: "a1", name: "g1t" },
    channel_id: "chn_1",
    card,
    created_at: "2026-10-08T00:00:00Z",
  });
  assert.deepEqual(payload.card, { channel_id: "chn_1", message_id: "msg_card" });
  assert.equal(payload.workspace, "acme");
  // Its own notification: a later message in the conversation does not replace it.
  assert.equal(payload.tag, "approval:approval:ses_1:2000000");
});
