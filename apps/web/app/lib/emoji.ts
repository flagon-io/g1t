/**
 * Emoji as the site draws them: finding one by name or keyword, what a
 * workspace's own emoji may be called, `:name:` in text and in the
 * composer, and reactions changing as people click and as the room says.
 * Pure, so it is tested on its own (emoji.test.ts); the components are in
 * components/emoji.
 *
 * The standard emoji come from components/emoji/data.json (Emojibase, MIT,
 * made by scripts/emoji/generate.mjs). It is loaded on first use, never in
 * the main bundle.
 */
import type { ChatLiveEvent, ChatReaction, CustomEmoji, MemberProfile } from "@g1t/contracts";

/** One standard emoji: the emoji, its name, shortcodes and keywords (space-separated), its group, and its five skin tones if it has them. */
export type EmojiEntry = [emoji: string, name: string, codes: string, tags: string, group: number, skins?: string[]];

export type EmojiData = { source: string; groups: string[]; emoji: EmojiEntry[] };

/** What the picker and the composer offer: a standard emoji, or one of the workspace's. */
export type EmojiPick =
  | { kind: "unicode"; emoji: string; name: string; code: string | null; skins?: string[] }
  | { kind: "custom"; emoji: string; name: string; file: string };

/** Skin tones, as the picker offers them: none, then light to dark. */
export const SKIN_TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"] as const;

/** A standard emoji in a skin tone (0 for none). */
export function skinned(entry: Pick<EmojiPick & { kind: "unicode" }, "emoji" | "skins">, tone: number): string {
  return tone > 0 && entry.skins?.[tone - 1] ? entry.skins[tone - 1]! : entry.emoji;
}

export function unicodePick(entry: EmojiEntry): EmojiPick {
  return { kind: "unicode", emoji: entry[0], name: entry[1], code: entry[2].split(" ")[0] || null, skins: entry[5] };
}

export function customPick(emoji: Pick<CustomEmoji, "name" | "file">): EmojiPick {
  return { kind: "custom", emoji: `:${emoji.name}:`, name: emoji.name, file: emoji.file };
}

/** Where a custom emoji's image is served: the usercontent origin, never the site. */
export function emojiUrl(file: string, usercontent: string): string {
  return `${usercontent}/emoji/${file}`;
}

/** How well `query` matches a set of words: lower is better, null for no match. */
function rank(query: string, codes: string[], name: string, tags: string[]): number | null {
  if (codes.includes(query)) return 0;
  if (codes.some((code) => code.startsWith(query))) return 1;
  const words = name.toLowerCase().split(/[\s:,-]+/);
  if (name.toLowerCase() === query) return 0;
  if (words.some((word) => word.startsWith(query))) return 2;
  if (tags.some((tag) => tag.startsWith(query))) return 3;
  if (codes.some((code) => code.includes(query)) || name.toLowerCase().includes(query)) return 4;
  return null;
}

/**
 * Emoji matching what was typed, best first: a shortcode exactly, then one
 * starting with it, then a word of the name, then a keyword, then anywhere
 * in a name. The workspace's own come first among equals. `:` around the
 * query is ignored; an empty query finds nothing.
 */
export function searchEmoji(data: EmojiData | null, customs: readonly Pick<CustomEmoji, "name" | "file">[], typed: string, limit = 60): EmojiPick[] {
  const query = typed.trim().toLowerCase().replace(/^:+|:+$/g, "");
  if (!query) return [];
  const found: { pick: EmojiPick; score: number; order: number }[] = [];
  customs.forEach((custom, order) => {
    const score = rank(query, [custom.name], custom.name.replace(/[-_+]/g, " "), []);
    if (score != null) found.push({ pick: customPick(custom), score, order });
  });
  data?.emoji.forEach((entry, order) => {
    const score = rank(query, entry[2] ? entry[2].split(" ") : [], entry[1], entry[3] ? entry[3].split(" ") : []);
    if (score != null) found.push({ pick: unicodePick(entry), score: score + 0.5, order: order + customs.length });
  });
  return found
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((f) => f.pick);
}

/** As the chat service's rule: lowercase letters, digits, `-`, `_` and `+`, 2 to 32 of them. */
export const EMOJI_NAME = /^[a-z0-9_+-]{2,32}$/;

/** A name typed for a new emoji, as it would be kept: lowercase, without colons. */
export function cleanEmojiName(typed: string): string {
  return typed.trim().replace(/^:+|:+$/g, "").toLowerCase().replace(/\s+/g, "_");
}

/**
 * What is wrong with a name for a new emoji, or null when it will do:
 * its shape, a standard emoji's shortcode, or one the workspace already has.
 * The chat service checks again and decides.
 */
export function emojiNameProblem(name: string, taken: ReadonlySet<string>, standard: ReadonlySet<string> | null): string | null {
  if (name.length < 2) return "At least 2 characters.";
  if (name.length > 32) return "At most 32 characters.";
  if (!EMOJI_NAME.test(name)) return "Only lowercase letters, digits, -, _ and +.";
  if (standard?.has(name)) return `:${name}: is a standard emoji.`;
  if (taken.has(name)) return `:${name}: is already taken.`;
  return null;
}

/** Every standard shortcode, for checking a new name against. */
export function standardCodes(data: EmojiData): Set<string> {
  const codes = new Set<string>();
  for (const entry of data.emoji) for (const code of entry[2].split(" ")) if (code) codes.add(code);
  return codes;
}

/**
 * A `:name` being typed just before the caret, for the composer to
 * complete: two characters at least, after the start, a space or an
 * opening bracket, so `https://` and `12:30` are left alone.
 */
export function shortcodeQuery(text: string, caret: number): { start: number; typed: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{])(:[a-z0-9_+-]{2,32})$/i.exec(before);
  if (!match) return null;
  return { start: caret - match[2]!.length, typed: match[2]!.slice(1).toLowerCase() };
}

export type EmojiPart = { t: "text"; v: string } | { t: "emoji"; name: string; file: string };

/** Text with each `:name:` of a workspace emoji picked out; anything else stays text. */
export function splitShortcodes(text: string, customs: ReadonlyMap<string, string>): EmojiPart[] {
  if (!customs.size || !text.includes(":")) return [{ t: "text", v: text }];
  const parts: EmojiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/:([a-z0-9_+-]{2,32}):/g)) {
    const file = customs.get(match[1]!);
    if (!file) continue;
    if (match.index! > last) parts.push({ t: "text", v: text.slice(last, match.index) });
    parts.push({ t: "emoji", name: match[1]!, file });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });
  return parts.length ? parts : [{ t: "text", v: text }];
}

/** Whether a text is nothing but a few emoji, standard or the workspace's: shown large. */
export function onlyEmojiOrCustom(text: string, customs: ReadonlyMap<string, string>): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return false;
  const rest = trimmed.replace(/:([a-z0-9_+-]{2,32}):/g, (all, name: string) => (customs.has(name) ? "" : all)).replace(/\s+/g, "");
  if (rest === trimmed.replace(/\s+/g, "")) return false;
  return rest === "" || /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u.test(rest);
}

// ── Reactions ───────────────────────────────────────────────────────────

const sameMember = (a: Pick<MemberProfile, "kind" | "id">, b: Pick<MemberProfile, "kind" | "id">) => a.kind === b.kind && a.id === b.id;

/**
 * A message's reactions after the viewer (`me`) reacts with `emoji` (`on`)
 * or takes it back: what the page shows at once, before the service
 * answers. Doing what is already done changes nothing.
 */
export function toggleReaction(reactions: readonly ChatReaction[], emoji: string, on: boolean, me: MemberProfile): ChatReaction[] {
  const at = reactions.findIndex((r) => r.emoji === emoji);
  const current = at >= 0 ? reactions[at]! : null;
  if (on) {
    if (current?.me) return [...reactions];
    if (!current) return [...reactions, { emoji, count: 1, me: true, by: [me] }];
    const next = { ...current, count: current.count + 1, me: true, by: current.by.length < 10 ? [...current.by, me] : current.by };
    return reactions.map((r, i) => (i === at ? next : r));
  }
  if (!current?.me) return [...reactions];
  if (current.count <= 1) return reactions.filter((_, i) => i !== at);
  const next = { ...current, count: current.count - 1, me: false, by: current.by.filter((m) => !sameMember(m, me)) };
  return reactions.map((r, i) => (i === at ? next : r));
}

type ReactionEvent = Extract<ChatLiveEvent, { type: "reaction.added" | "reaction.removed" }>;

/**
 * A message's reactions after the room says someone reacted or took one
 * back. The viewer's own (`meId`, a user id) may already show, from
 * `toggleReaction`: it is not counted twice.
 */
export function reactionsAfterEvent(reactions: readonly ChatReaction[], event: ReactionEvent, meId: string | null): ChatReaction[] {
  const mine = event.member.kind === "user" && event.member.id === meId;
  const on = event.type === "reaction.added";
  const at = reactions.findIndex((r) => r.emoji === event.emoji);
  const current = at >= 0 ? reactions[at]! : null;
  if (mine) return toggleReaction(reactions, event.emoji, on, event.member);
  const listed = current?.by.some((m) => sameMember(m, event.member)) ?? false;
  if (on) {
    if (!current) return [...reactions, { emoji: event.emoji, count: 1, me: false, by: [event.member] }];
    if (listed) return [...reactions];
    const next = { ...current, count: current.count + 1, by: current.by.length < 10 ? [...current.by, event.member] : current.by };
    return reactions.map((r, i) => (i === at ? next : r));
  }
  if (!current) return [...reactions];
  if (current.count <= 1) return reactions.filter((_, i) => i !== at);
  const next = { ...current, count: current.count - 1, by: current.by.filter((m) => !sameMember(m, event.member)) };
  return reactions.map((r, i) => (i === at ? next : r));
}

/** Applies a reaction event to the messages it is about. */
export function applyReactionEvent<M extends { id: string; reactions?: ChatReaction[] }>(messages: readonly M[], event: ReactionEvent, meId: string | null): M[] {
  return messages.map((m) => (m.id === event.message_id ? { ...m, reactions: reactionsAfterEvent(m.reactions ?? [], event, meId) } : m));
}

/**
 * A message as the room sent it (where no reaction is anyone's own), with
 * the viewer's own marks kept from what the page already showed.
 */
export function keepMine<M extends { id: string; reactions?: ChatReaction[] }>(shown: readonly M[], incoming: M): M {
  const before = shown.find((m) => m.id === incoming.id)?.reactions;
  if (!before || !incoming.reactions) return incoming;
  const mine = new Set(before.filter((r) => r.me).map((r) => r.emoji));
  return { ...incoming, reactions: incoming.reactions.map((r) => (mine.has(r.emoji) ? { ...r, me: true } : r)) };
}

/** Who reacted, for the hover list: up to ten names, and how many more. */
export function reactorsLine(reaction: ChatReaction, meId: string | null): string {
  const names = reaction.by.map((m) => (m.kind === "user" && m.id === meId ? "You" : m.display_name || m.name));
  const more = reaction.count - names.length;
  if (more > 0) return `${names.join(", ")} and ${more} more`;
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── Recently used ───────────────────────────────────────────────────────

/** How many recent emoji the picker remembers. */
export const MAX_RECENT = 24;

/** The recent list with `emoji` first, each once. */
export function pushRecent(recent: readonly string[], emoji: string, max = MAX_RECENT): string[] {
  return [emoji, ...recent.filter((e) => e !== emoji)].slice(0, max);
}
