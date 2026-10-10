import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage, FeedNotification } from "@g1t/contracts";
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from "@g1t/contracts/sounds";

import {
  type Arrival,
  SAME_MESSAGE_MS,
  SOUND_GAP_MS,
  type SoundContext,
  SoundGate,
  arrivalKey,
  cueFor,
  cueForNotificationKind,
  finishedCard,
  lookingAt,
  mentionsMe,
  wantsDesktopToast,
} from "./chat-sounds.ts";

const ana = { kind: "user" as const, id: "u1", name: "ana", display_name: "Ana", avatar: null, role: null };
const bea = { kind: "user" as const, id: "u2", name: "bea", display_name: "Bea", avatar: null, role: null };
const margo = { kind: "agent" as const, id: "a1", name: "margo", display_name: "Margo", avatar: null, role: "Reviews pull requests" };

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: over.id ?? "msg_1",
    channel_id: "chn_general",
    author: bea,
    kind: "text",
    body: "hello there",
    card: null,
    thread_root: null,
    reply_count: 0,
    last_reply_at: null,
    created_at: "2026-10-10T10:00:00.000Z",
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function notification(over: Partial<FeedNotification> = {}): FeedNotification {
  return {
    id: "msg_9",
    kind: "dm",
    workspace: "acme",
    title: "Bea",
    body: "hi",
    href: "/acme/-/chat/dm/chn_dm",
    actor: { kind: "user", id: "u2", name: "Bea" },
    channel_id: "chn_dm",
    created_at: "2026-10-10T10:00:00.000Z",
    ...over,
  };
}

/** Ana, in #general, window in front: the quiet case every rule starts from. */
function ctx(over: Partial<SoundContext> = {}, settings: Partial<SoundSettings> = {}): SoundContext {
  return {
    me: { id: "u1", username: "ana" },
    focus: { visible: true, focused: true, viewingChannel: "chn_general" },
    muted: new Set(),
    dnd: false,
    settings: { ...DEFAULT_SOUND_SETTINGS, ...settings, sound_cues: { ...DEFAULT_SOUND_SETTINGS.sound_cues, ...settings.sound_cues } },
    ...over,
  };
}

const chat = (m: ChatMessage, channelKind: "channel" | "dm" = "channel"): Arrival => ({ source: "chat", message: m, channelKind });
const feed = (n: FeedNotification): Arrival => ({ source: "feed", notification: n });

test("a message in the conversation on screen, in a window in front, is silent", () => {
  assert.equal(cueFor(chat(message()), ctx()), null);
  assert.ok(lookingAt("chn_general", ctx().focus));
});

test("the same message plays `message` once the window is not in front, or the tab is hidden", () => {
  assert.equal(cueFor(chat(message()), ctx({ focus: { visible: true, focused: false, viewingChannel: "chn_general" } })), "message");
  assert.equal(cueFor(chat(message()), ctx({ focus: { visible: false, focused: false, viewingChannel: "chn_general" } })), "message");
});

test("a message in another conversation you have open plays `message`", () => {
  assert.equal(cueFor(chat(message({ channel_id: "chn_other" })), ctx()), "message");
  assert.equal(cueFor(feed(notification({ kind: "thread_reply", channel_id: "chn_other" })), ctx()), "message");
});

test("a direct message not from you plays `direct`; one from you plays nothing", () => {
  const dm = message({ channel_id: "chn_dm" });
  assert.equal(cueFor(chat(dm, "dm"), ctx()), "direct");
  assert.equal(cueFor(chat({ ...dm, author: ana }, "dm"), ctx()), null);
  assert.equal(cueFor(feed(notification()), ctx()), "direct");
  assert.equal(cueFor(feed(notification({ actor: { kind: "user", id: "u1", name: "Ana" } })), ctx()), null);
});

test("a mention of you plays `mention`, over `direct` and `message`", () => {
  assert.equal(cueFor(chat(message({ channel_id: "chn_other", body: "hey @ana look" })), ctx()), "mention");
  assert.equal(cueFor(chat(message({ channel_id: "chn_dm", body: "@ana?" }), "dm"), ctx()), "mention");
  assert.equal(cueFor(feed(notification({ kind: "mention", channel_id: "chn_other" })), ctx()), "mention");
  // Looking at it, in front: still silent.
  assert.equal(cueFor(chat(message({ body: "@ana" })), ctx()), null);
});

test("@you is a whole handle, outside code", () => {
  assert.ok(mentionsMe("thanks @ana", "ana"));
  assert.ok(mentionsMe("@Ana: see this", "ana"));
  assert.ok(mentionsMe("(@ana)", "ana"));
  assert.ok(!mentionsMe("@ana-marie did it", "ana"));
  assert.ok(!mentionsMe("@anatole", "ana"));
  assert.ok(!mentionsMe("mail me@ana.example", "ana"));
  assert.ok(!mentionsMe("run `@ana` in code", "ana"));
  assert.ok(!mentionsMe("```\n@ana\n```", "ana"));
  assert.ok(!mentionsMe("@ana", ""));
});

test("your own messages never sound, whichever way they arrive", () => {
  const unfocused = ctx({ focus: { visible: true, focused: false, viewingChannel: "chn_general" } });
  assert.equal(cueFor(chat(message({ author: ana })), unfocused), null);
  assert.equal(cueFor(chat(message({ author: ana, body: "@ana" })), unfocused), null);
  assert.equal(cueFor(feed(notification({ kind: "mention", actor: { kind: "user", id: "u1", name: "Ana" } })), unfocused), null);
});

test("a muted conversation is silent, even for a mention or a DM", () => {
  const muted = ctx({ muted: new Set(["chn_other", "chn_dm"]) });
  assert.equal(cueFor(chat(message({ channel_id: "chn_other", body: "@ana" })), muted), null);
  assert.equal(cueFor(chat(message({ channel_id: "chn_dm" }), "dm"), muted), null);
  assert.equal(cueFor(feed(notification()), muted), null);
  assert.equal(cueFor(chat(message({ channel_id: "chn_third" })), muted), "message");
});

test("Do not disturb silences everything", () => {
  const quiet = ctx({ dnd: true, focus: { visible: false, focused: false, viewingChannel: null } });
  assert.equal(cueFor(chat(message({ body: "@ana" })), quiet), null);
  assert.equal(cueFor(chat(message({ channel_id: "chn_dm" }), "dm"), quiet), null);
  assert.equal(cueFor(feed(notification({ kind: "agent_waiting" })), quiet), null);
});

test("sounds off, or one cue off, is silent for that", () => {
  const away = { visible: false, focused: false, viewingChannel: null };
  assert.equal(cueFor(chat(message()), ctx({ focus: away }, { sounds_enabled: false })), null);
  assert.equal(cueFor(chat(message()), ctx({ focus: away }, { sound_cues: { message: false } })), null);
  assert.equal(cueFor(chat(message({ body: "@ana" })), ctx({ focus: away }, { sound_cues: { message: false } })), "mention");
  assert.equal(cueFor(chat(message({ body: "@ana" })), ctx({ focus: away }, { sound_cues: { mention: false } })), null);
});

test("agents' messages count like people's, and a finished card plays `agent_done`", () => {
  const away = ctx({ focus: { visible: true, focused: false, viewingChannel: "chn_general" } });
  assert.equal(cueFor(chat(message({ author: margo })), away), "message");
  assert.equal(cueFor(chat(message({ author: margo, channel_id: "chn_dm" }), "dm"), away), "direct");
  assert.equal(cueFor(chat(message({ author: margo, body: "@ana done?" })), away), "mention");
  const card = message({
    author: margo,
    kind: "card",
    body: "",
    card: { kind: "session", title: "Fix the flaky test", detail: "2 files changed", state: "Done", href: "/acme/web/pull/4" },
  });
  assert.ok(finishedCard(card));
  assert.equal(cueFor(chat(card), away), "agent_done");
  assert.equal(cueFor(chat(card), ctx()), null, "looking at it: silent");
  assert.equal(cueFor(chat(card), ctx({ focus: away.focus }, { sound_cues: { agent_done: false } })), null);
  // A card still running, or a person's card, is a message.
  assert.ok(!finishedCard({ ...card, card: { ...card.card!, state: "Running" } }));
  assert.ok(!finishedCard({ ...card, author: bea }));
  assert.equal(cueFor(chat({ ...card, card: { ...card.card!, state: "Running" } }), away), "message");
  // An agent waiting on you, over the feed, is the same cue.
  assert.equal(cueFor(feed(notification({ kind: "agent_waiting", actor: { kind: "agent", id: "a1", name: "Margo" } })), away), "agent_done");
});

test("a deleted message, and an inbox notification, make no sound", () => {
  const away = ctx({ focus: { visible: false, focused: false, viewingChannel: null } });
  assert.equal(cueFor(chat(message({ deleted_at: "2026-10-10T10:01:00.000Z" })), away), null);
  assert.equal(cueFor(feed(notification({ kind: "inbox", channel_id: null })), away), null);
  assert.equal(cueForNotificationKind("inbox"), null);
  assert.equal(cueForNotificationKind("approval"), "mention");
});

test("sounds come at most one every 1.5 s, and one message sounds once however it arrives", () => {
  const gate = new SoundGate();
  const t0 = 1_000_000;
  assert.ok(gate.allow("msg:1", t0));
  assert.ok(!gate.allow("msg:2", t0 + 200), "a burst is one sound");
  assert.ok(!gate.allow("msg:3", t0 + SOUND_GAP_MS - 1));
  assert.ok(gate.allow("msg:4", t0 + SOUND_GAP_MS));
  // The same message, from the conversation's socket and then the feed.
  assert.ok(!gate.allow("msg:4", t0 + SOUND_GAP_MS * 3));
  assert.ok(!gate.allow("msg:4", t0 + SOUND_GAP_MS + SAME_MESSAGE_MS - 1));
  assert.ok(gate.allow("msg:4", t0 + SOUND_GAP_MS + SAME_MESSAGE_MS + 1), "long after, it is a new message to the gate");
  // A key refused by the gap is still remembered, so the feed's copy a moment later stays quiet.
  const again = new SoundGate();
  assert.ok(again.allow("msg:a", t0));
  assert.ok(!again.allow("msg:b", t0 + 100));
  assert.ok(!again.allow("msg:b", t0 + SOUND_GAP_MS + 100), "msg:b was heard of, if not sounded");
  // No key: only the gap applies.
  assert.ok(again.allow(null, t0 + SOUND_GAP_MS * 2));
  assert.ok(!again.allow(null, t0 + SOUND_GAP_MS * 2 + 10));
});

test("an arrival's key is its message id, the same over the socket and the feed", () => {
  assert.equal(arrivalKey(chat(message({ id: "msg_7" }))), "msg:msg_7");
  assert.equal(arrivalKey(feed(notification({ id: "msg_7" }))), "msg:msg_7");
});

test("a desktop notification shows only when wanted, allowed, out of front, and not already pushed", () => {
  const base = {
    notification: { kind: "dm" as const },
    toast: true,
    ctx: ctx({ focus: { visible: true, focused: false, viewingChannel: null } }, { desktop_toasts: true }),
    permission: "granted" as const,
    pushOn: false,
  };
  assert.ok(wantsDesktopToast(base));
  assert.ok(!wantsDesktopToast({ ...base, ctx: ctx({ focus: base.ctx.focus }) }), "off unless turned on");
  assert.ok(!wantsDesktopToast({ ...base, permission: "default" }));
  assert.ok(!wantsDesktopToast({ ...base, permission: "denied" }));
  assert.ok(!wantsDesktopToast({ ...base, pushOn: true }), "the push shows it instead");
  assert.ok(!wantsDesktopToast({ ...base, toast: false }), "what the feed would not toast");
  assert.ok(!wantsDesktopToast({ ...base, ctx: { ...base.ctx, dnd: true } }));
  assert.ok(!wantsDesktopToast({ ...base, ctx: { ...base.ctx, focus: { visible: true, focused: true, viewingChannel: null } } }), "in front: the toast is enough");
  assert.ok(wantsDesktopToast({ ...base, ctx: { ...base.ctx, focus: { visible: false, focused: false, viewingChannel: null } } }));
  assert.ok(!wantsDesktopToast({ ...base, notification: { kind: "inbox" } }));
});
