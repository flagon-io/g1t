import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_EMOJI_BYTES,
  MAX_REACTIONS_PER_MESSAGE,
  REACTORS_SHOWN,
  emojiImage,
  emojiName,
  fromBase64,
  isUnicodeEmoji,
  mayRemove,
  mayUpload,
  reactionEmoji,
  roomForReaction,
  sniffImage,
  tallyReactions,
} from "./emoji.ts";

test("a reaction is one emoji, however many code points it takes", () => {
  for (const emoji of ["👍", "👍🏽", "❤️", "👩‍💻", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇳🇱", "1️⃣", "#️⃣", "✅", "🫠"]) {
    assert.equal(isUnicodeEmoji(emoji), true, emoji);
  }
  for (const text of ["", "a", "ab", "👍👍", "👍 ", "🇳", "1", "<b>", "👍x", ":)"]) {
    assert.equal(isUnicodeEmoji(text), false, JSON.stringify(text));
  }
});

test("a reaction is a Unicode emoji or a workspace's own by name", () => {
  assert.deepEqual(reactionEmoji(" 🎉 "), { ok: true, emoji: "🎉", custom: null });
  assert.deepEqual(reactionEmoji(":shipit-g1t:"), { ok: true, emoji: ":shipit-g1t:", custom: "shipit-g1t" });
  // A standard shortcode is sent as the emoji, never by name.
  assert.equal(reactionEmoji(":thumbsup:").ok, false);
  assert.equal(reactionEmoji(":+1:").ok, false);
  assert.equal(reactionEmoji(":A:").ok, false);
  // One spelling: a needless variation selector is dropped; a needed one kept.
  const vs16 = String.fromCodePoint(0xfe0f);
  assert.deepEqual(reactionEmoji("👍" + vs16), { ok: true, emoji: "👍", custom: null });
  assert.deepEqual(reactionEmoji("❤" + vs16), { ok: true, emoji: "❤" + vs16, custom: null });
  assert.equal(reactionEmoji("hello").ok, false);
  assert.equal(reactionEmoji(42).ok, false);
});

test("custom emoji names: lowercase letters, digits, - _ +, 2 to 32, not a standard one", () => {
  assert.deepEqual(emojiName(":Party-Parrot:"), { ok: true, name: "party-parrot" });
  assert.deepEqual(emojiName("lgtm+1"), { ok: true, name: "lgtm+1" });
  assert.deepEqual(emojiName("ok_g1t"), { ok: true, name: "ok_g1t" });
  assert.equal(emojiName("a").ok, false);
  assert.equal(emojiName("x".repeat(33)).ok, false);
  assert.equal(emojiName("x".repeat(32)).ok, true);
  assert.equal(emojiName("has space").ok, false);
  assert.equal(emojiName("dot.name").ok, false);
  for (const standard of ["smile", "thumbsup", "+1", "tada", "rocket", "heart"]) {
    assert.equal(emojiName(standard).ok, false, standard);
  }
});

/** A PNG's signature and header for a `width`×`height` image. */
function png(width: number, height: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([...new TextEncoder().encode("GIF89a")]);
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function webp(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  const text = new TextEncoder();
  bytes.set(text.encode("RIFF"), 0);
  bytes.set(text.encode("WEBP"), 8);
  bytes.set(text.encode(chunk), 12);
  const view = new DataView(bytes.buffer);
  if (chunk === "VP8X") {
    const w = width - 1;
    const h = height - 1;
    bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  } else if (chunk === "VP8L") {
    const w = width - 1;
    const h = height - 1;
    bytes[20] = 0x2f;
    const bits = w | (h << 14);
    view.setUint32(21, bits, true);
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  }
  return bytes;
}

test("an image is known by its bytes, with its size", () => {
  assert.deepEqual(sniffImage(png(128, 64)), { content_type: "image/png", width: 128, height: 64 });
  assert.deepEqual(sniffImage(gif(32, 30)), { content_type: "image/gif", width: 32, height: 30 });
  assert.deepEqual(sniffImage(webp("VP8X", 300, 200)), { content_type: "image/webp", width: 300, height: 200 });
  assert.deepEqual(sniffImage(webp("VP8L", 64, 48)), { content_type: "image/webp", width: 64, height: 48 });
  assert.deepEqual(sniffImage(webp("VP8 ", 100, 90)), { content_type: "image/webp", width: 100, height: 90 });
  // Not by name: an SVG, a JPEG or text is none of them.
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Uint8Array(40)])), null);
  assert.equal(sniffImage(new Uint8Array()), null);
});

test("a custom emoji file is a PNG, GIF or WebP up to 256 KB and 512 pixels a side", () => {
  assert.equal(emojiImage(png(512, 512)).ok, true);
  assert.equal(emojiImage(png(513, 10)).ok, false);
  assert.equal(emojiImage(webp("VP8X", 10, 600)).ok, false);
  assert.equal(emojiImage(png(0, 10)).ok, false);
  assert.equal(emojiImage(png(64, 64, MAX_EMOJI_BYTES)).ok, true);
  assert.equal(emojiImage(png(64, 64, MAX_EMOJI_BYTES + 1)).ok, false);
  assert.equal(emojiImage(new Uint8Array()).ok, false);
  assert.equal(emojiImage(new TextEncoder().encode("GIF8 not really")).ok, false);
});

test("a file comes as base64, with or without a data: prefix", () => {
  assert.deepEqual(fromBase64("AAEC"), new Uint8Array([0, 1, 2]));
  assert.deepEqual(fromBase64("data:image/png;base64,AAEC"), new Uint8Array([0, 1, 2]));
  assert.equal(fromBase64("not base64!!"), null);
  assert.equal(fromBase64(null), null);
});

test("a message holds at most 50 kinds of reaction; more of one kind always fits", () => {
  const full = new Set(Array.from({ length: MAX_REACTIONS_PER_MESSAGE }, (_, i) => `:e${i}:`));
  assert.equal(roomForReaction(full, ":e3:"), true);
  assert.equal(roomForReaction(full, "🎉"), false);
  assert.equal(roomForReaction(new Set(), "🎉"), true);
});

test("who may add and remove a workspace's emoji", () => {
  assert.equal(mayUpload("members", "member"), true);
  assert.equal(mayUpload("admins", "member"), false);
  assert.equal(mayUpload("admins", "owner"), true);
  assert.equal(mayUpload("members", null), false);
  assert.equal(mayRemove("user:a", "user:a", "member"), true);
  assert.equal(mayRemove("user:a", "user:b", "member"), false);
  assert.equal(mayRemove("user:a", "user:b", "owner"), true);
  assert.equal(mayRemove("user:a", "user:a", null), false);
});

test("reactions are counted per message and emoji, in the order first used", () => {
  const at = (n: number) => `2026-10-08T10:00:${String(n).padStart(2, "0")}.000Z`;
  const rows = [
    { message_id: "m1", emoji: "🎉", principal: "user:b", created_at: at(3) },
    { message_id: "m1", emoji: "👍", principal: "user:a", created_at: at(1) },
    { message_id: "m1", emoji: "👍", principal: "agent:x", created_at: at(2) },
    { message_id: "m2", emoji: ":ship:", principal: "user:a", created_at: at(4) },
  ];
  const tallied = tallyReactions(rows, "user:a");
  assert.deepEqual(tallied.get("m1"), [
    { emoji: "👍", count: 2, me: true, by: ["user:a", "agent:x"] },
    { emoji: "🎉", count: 1, me: false, by: ["user:b"] },
  ]);
  assert.deepEqual(tallied.get("m2"), [{ emoji: ":ship:", count: 1, me: true, by: ["user:a"] }]);
  assert.equal(tallied.get("m3"), undefined);
  // Without a viewer (a live event every one sees), nobody is `me`.
  assert.equal(tallyReactions(rows, null).get("m1")![0]!.me, false);
});

test("a message carries the first ten who reacted, and counts them all", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    message_id: "m1",
    emoji: "🚀",
    principal: `user:u${String(i).padStart(2, "0")}`,
    created_at: `2026-10-08T10:00:${String(i).padStart(2, "0")}.000Z`,
  }));
  const [rocket] = tallyReactions(rows, "user:u24").get("m1")!;
  assert.equal(rocket!.count, 25);
  assert.equal(rocket!.me, true);
  assert.equal(rocket!.by.length, REACTORS_SHOWN);
  assert.equal(rocket!.by[0], "user:u00");
});
