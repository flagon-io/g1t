import assert from "node:assert/strict";
import { test } from "node:test";

import type { FeedNotification } from "@g1t/contracts";

import { ANDROID_CHANNEL, EXPO_BATCH, EXPO_PUSH_URL, cleanDevice, expoMessages, readTickets, sendExpo } from "./expopush.ts";
import { pushPayload } from "./prefs.ts";

const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

function notification(over: Partial<FeedNotification> = {}): FeedNotification {
  return {
    id: "m1",
    kind: "mention",
    workspace: "acme",
    title: "Ana in #general",
    body: "ship it?",
    href: "/acme/chat/general",
    actor: { kind: "user", id: "u1", name: "Ana", avatar: null, avatar_seed: null },
    channel_id: "chn_1",
    thread_root: "msg_0",
    created_at: "2026-10-11T12:00:00Z",
    ...over,
  };
}

test("a device is an Expo push token, a platform and maybe a name", () => {
  assert.deepEqual(cleanDevice({ token: TOKEN, platform: "android", name: " Pixel 9 " }), { token: TOKEN, platform: "android", name: "Pixel 9" });
  assert.deepEqual(cleanDevice({ token: "ExpoPushToken[abc-123_x]", platform: "ios" }), { token: "ExpoPushToken[abc-123_x]", platform: "ios", name: null });
  assert.equal(cleanDevice({ token: TOKEN, platform: "ios", name: "x".repeat(300) })?.name?.length, 100);
  assert.equal(cleanDevice({ token: TOKEN, platform: "ios", name: 7 })?.name, null);
  for (const bad of [
    null,
    "ExponentPushToken[x]",
    { token: TOKEN, platform: "web" },
    { token: TOKEN },
    { token: "fcm:abcdef", platform: "android" },
    { token: "ExponentPushToken[]", platform: "android" },
    { token: "ExponentPushToken[a b]", platform: "android" },
    { token: "ExponentPushToken[abc]x", platform: "android" },
    { token: `ExponentPushToken[${"a".repeat(200)}]`, platform: "android" },
    { token: 42, platform: "android" },
  ]) {
    assert.equal(cleanDevice(bad), null, JSON.stringify(bad));
  }
});

test("a message says what a browser push says, with where it is in chat", () => {
  const n = notification({ body: "x".repeat(300) });
  const [message] = expoMessages([TOKEN], pushPayload(n), n);
  assert.deepEqual(message, {
    to: TOKEN,
    title: "Ana in #general",
    body: "x".repeat(240),
    sound: "default",
    priority: "high",
    ttl: 12 * 3600,
    channelId: ANDROID_CHANNEL,
    threadId: "chat:chn_1",
    data: { href: "/acme/chat/general", workspace: "acme", kind: "mention", tag: "chat:chn_1", channel_id: "chn_1", thread_root: "msg_0", card: null },
  });
  assert.equal(ANDROID_CHANNEL, "messages");
});

test("what is not said to you goes at normal priority; one with no conversation threads by itself", () => {
  const inbox = notification({ kind: "inbox", id: "in_9", channel_id: null, thread_root: null });
  const [message] = expoMessages([TOKEN], pushPayload(inbox), inbox);
  assert.equal(message.priority, "normal");
  assert.equal(message.threadId, "inbox:in_9");
  assert.equal(message.data.channel_id, null);
  assert.equal(message.data.thread_root, null);
});

test("a card's place travels with it", () => {
  const n = notification({
    card: { channel_id: "chn_1", message_id: "msg_5", actions: [{ id: "open", label: "Open", style: "default", confirm: null, input: null, href: "/x" }] },
  });
  const [message] = expoMessages([TOKEN], pushPayload(n), n);
  assert.deepEqual(message.data.card, { channel_id: "chn_1", message_id: "msg_5" });
  assert.equal(message.threadId, "mention:m1");
});

test("tickets: ok counts, DeviceNotRegistered is gone, anything else is an error", () => {
  const tokens = ["ExpoPushToken[a]", "ExpoPushToken[b]", "ExpoPushToken[c]", "ExpoPushToken[d]"];
  const result = readTickets(tokens, {
    data: [
      { status: "ok", id: "t1" },
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      { status: "error", message: "too big", details: { error: "MessageTooBig" } },
    ],
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(result.gone, ["ExpoPushToken[b]"]);
  assert.deepEqual(result.errors, ["MessageTooBig", "no ticket"]);
  const refused = readTickets(tokens, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] });
  assert.equal(refused.sent, 0);
  assert.deepEqual(refused.gone, []);
  assert.equal(refused.errors.length, 1);
});

test("sending: 100 to a request, JSON with Expo's headers, the access token only when set", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const messages = JSON.parse(String(init.body)) as { to: string }[];
    const data = messages.map((m) =>
      m.to.endsWith("[t7]") ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: m.to },
    );
    return Response.json({ data });
  }) as unknown as typeof fetch;
  const tokens = Array.from({ length: 250 }, (_, i) => `ExpoPushToken[t${i}]`);
  const n = notification();
  const result = await sendExpo(tokens, pushPayload(n), n, { accessToken: "secret" }, fetcher);
  assert.deepEqual(
    seen.map((s) => JSON.parse(String(s.init.body)).length),
    [EXPO_BATCH, EXPO_BATCH, 50],
  );
  assert.equal(seen[0].url, EXPO_PUSH_URL);
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(seen[0].init.headers, { accept: "application/json", "content-type": "application/json", authorization: "Bearer secret" });
  assert.deepEqual(result, { sent: 249, gone: ["ExpoPushToken[t7]"], errors: [] });

  seen.length = 0;
  await sendExpo(tokens.slice(0, 1), pushPayload(n), n, {}, fetcher);
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, undefined);
});

test("a failed request counts nothing and the others still count", async () => {
  let call = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    call++;
    if (call === 1) throw new Error("network down");
    if (call === 2) return Response.json({ errors: [{ code: "RATE_LIMIT" }] }, { status: 429 });
    const messages = JSON.parse(String(init.body)) as unknown[];
    return Response.json({ data: messages.map(() => ({ status: "ok", id: "x" })) });
  }) as unknown as typeof fetch;
  const tokens = Array.from({ length: 210 }, (_, i) => `ExpoPushToken[t${i}]`);
  const n = notification();
  const result = await sendExpo(tokens, pushPayload(n), n, {}, fetcher);
  assert.equal(result.sent, 10);
  assert.deepEqual(result.gone, []);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join("\n"), /network down/);
  assert.match(result.errors.join("\n"), /429/);
});
