import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ChatReaction, MemberProfile } from "@g1t/contracts";

import {
  type EmojiData,
  applyReactionEvent,
  cleanEmojiName,
  emojiNameProblem,
  emojiUrl,
  keepMine,
  onlyEmojiOrCustom,
  pushRecent,
  reactionsAfterEvent,
  reactorsLine,
  searchEmoji,
  shortcodeQuery,
  skinned,
  splitShortcodes,
  standardCodes,
  toggleReaction,
  unicodePick,
} from "./emoji.ts";

const data = JSON.parse(readFileSync(new URL("../components/emoji/data.json", import.meta.url), "utf8")) as EmojiData;
const customs = [
  { name: "shipit", file: "a".repeat(64) },
  { name: "party-parrot", file: "b".repeat(64) },
];

test("the emoji data is complete and small", () => {
  assert.ok(data.emoji.length > 1800, String(data.emoji.length));
  assert.equal(data.groups.length, 9);
  assert.ok(readFileSync(new URL("../components/emoji/data.json", import.meta.url)).length < 220_000);
  // Every emoji has a name and a group the picker shows.
  for (const entry of data.emoji) {
    assert.ok(entry[1], entry[0]);
    assert.ok(entry[4] >= 0 && entry[4] < data.groups.length, entry[0]);
  }
});

test("search finds by shortcode first, then name, then keyword", () => {
  assert.equal(searchEmoji(data, [], ":+1:")[0]!.emoji, "👍");
  assert.equal(searchEmoji(data, [], "thumbsup")[0]!.emoji, "👍");
  assert.equal(searchEmoji(data, [], "tada")[0]!.emoji, "🎉");
  assert.equal(searchEmoji(data, [], "rocket")[0]!.emoji, "🚀");
  // A keyword: "celebrate" is no emoji's shortcode or name, but finds the party.
  assert.ok(searchEmoji(data, [], "celebrat").some((p) => p.emoji === "🎉"));
  // Nothing typed, nothing found; nonsense finds nothing.
  assert.deepEqual(searchEmoji(data, [], "  "), []);
  assert.deepEqual(searchEmoji(data, [], "zzqqxx"), []);
  assert.ok(searchEmoji(data, [], "a", 10).length <= 10);
});

test("the workspace's own emoji are found by name, ahead of standard ones as good", () => {
  // The exact shortcode first; the workspace's own next, ahead of other standard ones starting so.
  const found = searchEmoji(data, customs, "ship");
  assert.equal(found[0]!.emoji, "🚢");
  assert.deepEqual(found[1], { kind: "custom", emoji: ":shipit:", name: "shipit", file: "a".repeat(64) });
  assert.equal(searchEmoji(data, customs, "party")[0]!.name, "party-parrot");
  assert.ok(searchEmoji(data, customs, "parrot").some((p) => p.name === "party-parrot"));
});

test("skin tones apply where an emoji has them", () => {
  const wave = unicodePick(data.emoji.find((e) => e[0] === "👋")!);
  assert.equal(skinned(wave as never, 0), "👋");
  assert.equal(skinned(wave as never, 3), "👋🏽");
  const rocket = unicodePick(data.emoji.find((e) => e[0] === "🚀")!);
  assert.equal(skinned(rocket as never, 3), "🚀");
});

test("a new emoji's name: its shape, standard ones and taken ones", () => {
  const standard = standardCodes(data);
  assert.equal(cleanEmojiName(" :Party Parrot: "), "party_parrot");
  assert.equal(emojiNameProblem("shipit2", new Set(), standard), null);
  assert.match(emojiNameProblem("a", new Set(), standard)!, /2/);
  assert.match(emojiNameProblem("x".repeat(33), new Set(), standard)!, /32/);
  assert.match(emojiNameProblem("no.dots", new Set(), standard)!, /Only/);
  assert.match(emojiNameProblem("smile", new Set(), standard)!, /standard/);
  assert.match(emojiNameProblem("shipit", new Set(["shipit"]), standard)!, /taken/);
});

test("a :name being typed is offered for completion, but not in links or times", () => {
  assert.deepEqual(shortcodeQuery("nice :tad", 9), { start: 5, typed: "tad" });
  assert.deepEqual(shortcodeQuery(":+1", 3), { start: 0, typed: "+1" });
  assert.equal(shortcodeQuery("nice :t", 7), null);
  assert.equal(shortcodeQuery("see https://g1t.sh", 18), null);
  assert.equal(shortcodeQuery("at 12:30", 8), null);
  assert.equal(shortcodeQuery("done :tada: ", 12), null);
});

test(":name: becomes the workspace's emoji in text; anything else stays", () => {
  const map = new Map(customs.map((c) => [c.name, c.file]));
  assert.deepEqual(splitShortcodes("ship it :shipit: now :nope:", map), [
    { t: "text", v: "ship it " },
    { t: "emoji", name: "shipit", file: "a".repeat(64) },
    { t: "text", v: " now :nope:" },
  ]);
  assert.deepEqual(splitShortcodes("no colons", map), [{ t: "text", v: "no colons" }]);
  assert.equal(onlyEmojiOrCustom(":shipit: :party-parrot:", map), true);
  assert.equal(onlyEmojiOrCustom(":shipit: 🎉", map), true);
  assert.equal(onlyEmojiOrCustom(":shipit: go", map), false);
  assert.equal(onlyEmojiOrCustom(":nope:", map), false);
  assert.equal(emojiUrl("f".repeat(64), "https://g1tusercontent.com"), `https://g1tusercontent.com/emoji/${"f".repeat(64)}`);
});

const me: MemberProfile = { kind: "user", id: "u1", name: "ana", display_name: "Ana", avatar: null, role: null };
const bo: MemberProfile = { kind: "user", id: "u2", name: "bo", display_name: "Bo", avatar: null, role: null };
const margo: MemberProfile = { kind: "agent", id: "a1", name: "margo", display_name: "Margo", avatar: null, role: null };

test("reacting shows at once, and taking it back undoes it", () => {
  let reactions: ChatReaction[] = [{ emoji: "👍", count: 1, me: false, by: [bo] }];
  reactions = toggleReaction(reactions, "👍", true, me);
  assert.deepEqual(reactions, [{ emoji: "👍", count: 2, me: true, by: [bo, me] }]);
  // Twice is once.
  assert.deepEqual(toggleReaction(reactions, "👍", true, me), reactions);
  reactions = toggleReaction(reactions, "🎉", true, me);
  assert.equal(reactions.length, 2);
  reactions = toggleReaction(reactions, "🎉", false, me);
  assert.deepEqual(reactions, [{ emoji: "👍", count: 2, me: true, by: [bo, me] }]);
  reactions = toggleReaction(reactions, "👍", false, me);
  assert.deepEqual(reactions, [{ emoji: "👍", count: 1, me: false, by: [bo] }]);
});

test("the room's reaction events count others once, and the viewer's own never twice", () => {
  const start: ChatReaction[] = [{ emoji: "👍", count: 1, me: true, by: [me] }];
  const event = (type: "reaction.added" | "reaction.removed", member: MemberProfile, emoji = "👍") =>
    ({ type, channel_id: "c", message_id: "m1", emoji, member }) as const;
  // The viewer's own, already shown optimistically.
  assert.deepEqual(reactionsAfterEvent(start, event("reaction.added", me), "u1"), start);
  // An agent's counts like anyone's.
  const withMargo = reactionsAfterEvent(start, event("reaction.added", margo), "u1");
  assert.deepEqual(withMargo, [{ emoji: "👍", count: 2, me: true, by: [me, margo] }]);
  assert.deepEqual(reactionsAfterEvent(withMargo, event("reaction.added", margo), "u1"), withMargo);
  assert.deepEqual(reactionsAfterEvent(withMargo, event("reaction.removed", margo), "u1"), start);
  assert.deepEqual(reactionsAfterEvent([], event("reaction.added", bo, "🚀"), "u1"), [{ emoji: "🚀", count: 1, me: false, by: [bo] }]);
  assert.deepEqual(reactionsAfterEvent([{ emoji: "🚀", count: 1, me: false, by: [bo] }], event("reaction.removed", bo, "🚀"), "u1"), []);
  const messages = [{ id: "m1", reactions: start }, { id: "m2" }];
  assert.equal(applyReactionEvent(messages, event("reaction.added", bo), "u1")[0]!.reactions![0]!.count, 2);
  assert.equal(applyReactionEvent(messages, event("reaction.added", bo), "u1")[1]!.reactions, undefined);
});

test("a message from the room keeps the viewer's own reactions marked", () => {
  const shown = [{ id: "m1", reactions: [{ emoji: "👍", count: 1, me: true, by: [me] }] }];
  const incoming = { id: "m1", reactions: [{ emoji: "👍", count: 2, me: false, by: [me, bo] }] };
  assert.equal(keepMine(shown, incoming).reactions![0]!.me, true);
  assert.equal(keepMine([], incoming).reactions![0]!.me, false);
});

test("who reacted reads as a sentence", () => {
  assert.equal(reactorsLine({ emoji: "👍", count: 1, me: true, by: [me] }, "u1"), "You");
  assert.equal(reactorsLine({ emoji: "👍", count: 2, me: true, by: [me, bo] }, "u1"), "You and Bo");
  assert.equal(reactorsLine({ emoji: "👍", count: 3, me: false, by: [me, bo, margo] }, "u9"), "Ana, Bo and Margo");
  assert.equal(reactorsLine({ emoji: "👍", count: 14, me: false, by: [bo, margo] }, "u1"), "Bo, Margo and 12 more");
});

test("recent emoji: newest first, each once, a few", () => {
  assert.deepEqual(pushRecent(["🎉", "👍"], "👍"), ["👍", "🎉"]);
  assert.equal(pushRecent(Array.from({ length: 30 }, (_, i) => String(i)), "x").length, 24);
});
