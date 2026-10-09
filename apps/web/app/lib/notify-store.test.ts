import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatSidebarEntry, FeedCounts, FeedNotification } from "@g1t/contracts";

import {
  heldOpen,
  MAX_TOASTS,
  RECENT_KEPT,
  WAITING_MS,
  addRecent,
  addToast,
  cardActionRequest,
  notificationActions,
  waitingCards,
  attentionCount,
  badgesOf,
  canQuickReply,
  dismissToast,
  hiddenToFit,
  isViewing,
  markReadLocally,
  offerPush,
  overlayEntries,
  quickReplyRequest,
  reconnectDelay,
  titleWith,
  unlisted,
} from "./notify-store.ts";

const note = (id: string, over: Partial<FeedNotification> = {}): FeedNotification => ({
  id,
  kind: "dm",
  workspace: "acme",
  title: "Ana Lima",
  body: "ship it?",
  href: "/acme/-/chat/dm/chn_1",
  actor: { kind: "user", id: "u1", name: "Ana Lima" },
  channel_id: "chn_1",
  created_at: "2026-10-08T00:00:00Z",
  ...over,
});
const away = { path: "/acme/api" };

test("toasts: newest last, at most three, never twice", () => {
  let toasts = addToast([], note("1", { channel_id: "a", href: "/acme/-/chat/a" }), away, 1);
  toasts = addToast(toasts, note("1", { channel_id: "a", href: "/acme/-/chat/a" }), away, 2);
  assert.equal(toasts.length, 1);
  for (const id of ["2", "3", "4"]) toasts = addToast(toasts, note(id, { channel_id: `c${id}`, href: `/acme/-/chat/c${id}` }), away, Number(id));
  assert.equal(toasts.length, MAX_TOASTS);
  assert.deepEqual(toasts.map((t) => t.notification.id), ["2", "3", "4"]);
  assert.deepEqual(dismissToast(toasts, "3").map((t) => t.notification.id), ["2", "4"]);
});

test("a newer message in the same conversation replaces its toast", () => {
  let toasts = addToast([], note("1"), away, 1);
  toasts = addToast(toasts, note("2"), away, 2);
  assert.deepEqual(toasts.map((t) => t.notification.id), ["2"]);
});

test("no toast for the conversation on screen, by page or by channel; inbox items always", () => {
  assert.deepEqual(addToast([], note("1"), { path: "/acme/-/chat/dm/chn_1/" }, 1), []);
  assert.deepEqual(addToast([], note("1", { href: "/acme/-/chat/ops?thread=m1", channel_id: "c9" }), { path: "/ACME/-/chat/ops" }, 1), []);
  assert.ok(isViewing(note("1"), { path: "/elsewhere", channel_id: "chn_1" }));
  assert.equal(addToast([], note("1", { kind: "inbox", channel_id: null, href: "/acme/api/pull/4" }), { path: "/acme/api/pull/4" }, 1).length, 1);
});

test("quick replies post to the conversation, in its thread when there is one", () => {
  assert.ok(canQuickReply(note("1")));
  assert.ok(!canQuickReply(note("1", { kind: "inbox" })));
  assert.ok(!canQuickReply(note("1", { channel_id: null })));
  assert.equal(quickReplyRequest(note("1"), "   "), null);
  assert.deepEqual(quickReplyRequest(note("1", { kind: "mention", thread_root: "m1" }), " on it "), {
    url: "/acme/-/chat/api",
    body: { intent: "post", channel_id: "chn_1", body: "on it", thread_root: "m1" },
  });
});

const counts = (over: Partial<FeedCounts> = {}): FeedCounts => ({
  workspace: "acme",
  chat_unread: 4,
  chat_mentions: 1,
  inbox_unread: 2,
  per_channel: [
    { channel_id: "a", unread: 3, mentions: 1 },
    { channel_id: "b", unread: 1, mentions: 0 },
  ],
  complete: true,
  ...over,
});

test("badges: chat only once the feed's counts are complete; the inbox whenever known", () => {
  assert.deepEqual(badgesOf(counts(), null), { chat: 4, mentions: 1, inbox: 2 });
  assert.deepEqual(badgesOf(counts({ complete: false }), null), { inbox: 2 });
  assert.deepEqual(badgesOf(null, 7), { inbox: 7 });
  assert.equal(badgesOf(null, null), null);
  assert.equal(attentionCount({ chat: 4, mentions: 1, inbox: 2 }), 6);
  assert.equal(attentionCount({ chat: 0, mentions: 2 }), 2);
  assert.equal(attentionCount(null), 0);
});

test("reading a conversation here zeroes it at once", () => {
  const after = markReadLocally(counts(), "a");
  assert.equal(after.chat_unread, 1);
  assert.equal(after.chat_mentions, 0);
  assert.deepEqual(after.per_channel.map((c) => c.channel_id), ["b"]);
  assert.equal(markReadLocally(counts(), "zzz").chat_unread, 4);
});

const entry = (id: string, unread: number, mentions = 0): ChatSidebarEntry =>
  ({
    channel: { id, workspace_id: "w", kind: "channel", name: id, topic: null, private: false, created_by: { kind: "user", id: "u" }, created_at: "", archived_at: null, last_message_at: null },
    title: id,
    others: [],
    starred: false,
    muted: false,
    unread,
    mentions,
  }) as ChatSidebarEntry;

test("the sidebar takes the feed's counts once they are complete, and spots conversations it does not list", () => {
  const entries = [entry("a", 0), entry("b", 5), entry("c", 2)];
  const shown = overlayEntries(entries, counts());
  assert.deepEqual(shown.map((e) => [e.unread, e.mentions]), [[3, 1], [1, 0], [0, 0]]);
  assert.equal(overlayEntries(entries, counts({ complete: false })), entries);
  const same = [entry("a", 3, 1), entry("b", 1)];
  assert.equal(overlayEntries(same, counts()), same);
  assert.deepEqual(unlisted([entry("a", 0)], counts()), ["b"]);
});

test("the tab title counts what needs you, once", () => {
  assert.equal(titleWith("Chat · g1t", 3), "(3) Chat · g1t");
  assert.equal(titleWith("(3) Chat · g1t", 5), "(5) Chat · g1t");
  assert.equal(titleWith("(5) Chat · g1t", 0), "Chat · g1t");
  assert.equal(titleWith("Inbox", 250), "(99+) Inbox");
  assert.equal(titleWith("(99+) Inbox", 1), "(1) Inbox");
});

test("browser notifications are offered once, after a DM or mention, never after a no", () => {
  const base = { kind: "dm" as const, supported: true, permission: "default" as const, choice: null, hasKey: true, desktop: false };
  assert.ok(offerPush(base));
  assert.ok(offerPush({ ...base, kind: "mention" }));
  assert.ok(!offerPush({ ...base, kind: "inbox" }));
  assert.ok(!offerPush({ ...base, choice: "declined" }));
  assert.ok(!offerPush({ ...base, choice: "off" }));
  assert.ok(!offerPush({ ...base, permission: "denied" }));
  assert.ok(!offerPush({ ...base, permission: "granted" }));
  assert.ok(!offerPush({ ...base, supported: false }));
  assert.ok(!offerPush({ ...base, hasKey: false }));
  assert.ok(!offerPush({ ...base, desktop: true }));
});

test("reconnecting waits a jittered, growing time, never past half a minute", () => {
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(0, () => 1), 1000);
  assert.equal(reconnectDelay(3, () => 1), 8000);
  assert.equal(reconnectDelay(50, () => 1), 30_000);
  const spread = new Set(Array.from({ length: 20 }, () => reconnectDelay(4)));
  assert.ok(spread.size > 1);
});

test("a stack taller than the screen folds its oldest toasts into a pill, never the newest", () => {
  // 3 toasts of 120 and 2 gaps: 376.
  assert.equal(hiddenToFit([120, 120, 120], 400), 0);
  // Too tall: the oldest folds; 2 toasts, the pill (30) and 2 gaps = 286.
  assert.equal(hiddenToFit([120, 120, 120], 300), 1);
  assert.equal(hiddenToFit([120, 120, 120], 200), 2);
  // However small the screen, the newest stays.
  assert.equal(hiddenToFit([120, 120, 120], 10), 2);
  assert.equal(hiddenToFit([], 10), 0);
  // The offer always shows and takes its room first.
  assert.equal(hiddenToFit([100, 100], 276, 60), 0);
  assert.equal(hiddenToFit([100, 100], 275, 60), 1);
});

const capCard = {
  channel_id: "chn_9",
  message_id: "msg_card",
  actions: [
    { id: "approve", label: "Approve more", style: "primary" as const, input: { kind: "money" as const, label: "New cap" } },
    { id: "stop", label: "Stop", style: "danger" as const, confirm: "Stop this session?" },
    { id: "open", label: "Open", href: "/acme/-/agents/g1t/sessions/ses_1" },
  ],
};

test("a card's notification offers its actions and presses them as the card does", () => {
  const n = note("approval:ses_1:2000000", { kind: "approval", channel_id: null, card: capCard });
  assert.deepEqual(notificationActions(n).map((a) => a.id), ["approve", "stop", "open"]);
  assert.deepEqual(notificationActions(note("m1")), []);
  assert.deepEqual(cardActionRequest(n, capCard.actions[0]!, "5.00"), {
    url: "/acme/-/chat/api",
    body: { intent: "card_action", channel_id: "chn_9", message_id: "msg_card", action_id: "approve", input: "5.00" },
  });
  // A link opens its page; an action the card does not offer is not sent.
  assert.equal(cardActionRequest(n, capCard.actions[2]!, null), null);
  assert.equal(cardActionRequest(n, { id: "merge", label: "Merge" }, null), null);
  assert.equal(cardActionRequest(note("m1"), capCard.actions[1]!, null), null);
});

test("recent notifications are kept newest first, once each", () => {
  const a = note("a", { created_at: "2026-10-08T00:00:01Z" });
  const b = note("b", { created_at: "2026-10-08T00:00:02Z" });
  assert.deepEqual(addRecent([a], [b, a]).map((n) => n.id), ["b", "a"]);
  const many = Array.from({ length: RECENT_KEPT + 5 }, (_, i) => note(`n${i}`, { created_at: new Date(Date.UTC(2026, 9, 8, 0, 0, i)).toISOString() }));
  assert.equal(addRecent([], many).length, RECENT_KEPT);
});

test("the panel waits on the newest notification per card, for a day, until it is acted on", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const older = note("approval:ses_1:1000000", { kind: "approval", card: capCard, created_at: "2026-10-09T10:00:00Z" });
  const newer = note("approval:ses_1:2000000", { kind: "approval", card: capCard, created_at: "2026-10-09T11:00:00Z" });
  const draft = note("msg_d", { kind: "agent_waiting", workspace: "side", card: { ...capCard, message_id: "msg_draft" }, created_at: "2026-10-09T11:30:00Z" });
  const stale = note("msg_s", { kind: "agent_waiting", card: { ...capCard, message_id: "msg_stale" }, created_at: new Date(now - WAITING_MS - 1).toISOString() });
  const recent = addRecent([], [older, newer, draft, stale, note("plain")]);
  assert.deepEqual(waitingCards(recent, new Set(), now).map((n) => n.id), ["msg_d", "approval:ses_1:2000000"]);
  assert.deepEqual(waitingCards(recent, new Set(), now, "Acme").map((n) => n.id), ["approval:ses_1:2000000"]);
  // Acting on the newest puts the card away; the older one about it does not come back.
  assert.deepEqual(waitingCards(recent, new Set(["approval:ses_1:2000000"]), now, "acme"), []);
});

test("the backoff starts over only after a connection held for a while", () => {
  assert.equal(heldOpen(null, 50_000), false);
  assert.equal(heldOpen(45_000, 50_000), false, "dropped within seconds: keep backing off");
  assert.equal(heldOpen(40_000, 50_000), true);
});
