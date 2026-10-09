/**
 * Reactions and a workspace's own emoji: what may be reacted with, what a
 * custom emoji may be named, what image it may be, and how reactions are
 * counted for a page of messages. Pure, so it is tested apart from the
 * service.
 */

import { STANDARD_SHORTCODES } from "./standard-emoji.ts";

/** The most different emoji on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 50;
/** How many of the people who reacted with one emoji a message carries; the count says how many in all. */
export const REACTORS_SHOWN = 10;

/** The largest custom emoji file, in bytes. */
export const MAX_EMOJI_BYTES = 256 * 1024;
/** The widest and tallest custom emoji, in pixels. */
export const MAX_EMOJI_SIDE = 512;

/** Who may add a workspace's emoji: every member, or only its owners. */
export type EmojiUpload = "members" | "admins";

const CUSTOM = /^:([a-z0-9_+-]{2,32}):$/;
const NAME = /^[a-z0-9_+-]{2,32}$/;
/** What a lone emoji grapheme starts with: a pictograph, a flag (two regional letters), or a keycap. */
const PICTOGRAPH = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Whether `text` is exactly one emoji: one grapheme cluster that is a pictograph, a flag or a keycap. */
export function isUnicodeEmoji(text: string): boolean {
  if (!text || text.length > 32) return false;
  const parts = [...graphemes.segment(text)];
  return parts.length === 1 && PICTOGRAPH.test(text);
}

const VS16 = String.fromCodePoint(0xfe0f);

/**
 * One spelling per emoji: one shown as an emoji by default needs no
 * variation selector after it, so `👍` and `👍` + U+FE0F are one reaction.
 */
export function plainEmoji(emoji: string): string {
  return emoji.endsWith(VS16) && /^\p{Emoji_Presentation}$/u.test(emoji.slice(0, -1)) ? emoji.slice(0, -1) : emoji;
}

export type ReactionEmoji = { ok: true; emoji: string; custom: string | null } | { ok: false; message: string };

/**
 * What a reaction is with: one Unicode emoji, or `:name:` for one of the
 * workspace's own (`custom` is its name, which the caller checks exists).
 * A standard shortcode is sent as the emoji itself, not by name.
 */
export function reactionEmoji(input: unknown): ReactionEmoji {
  const text = typeof input === "string" ? input.trim() : "";
  const custom = CUSTOM.exec(text);
  if (custom) {
    if (STANDARD_SHORTCODES.has(custom[1]!)) return { ok: false, message: `Send ${text} as the emoji itself.` };
    return { ok: true, emoji: text, custom: custom[1]! };
  }
  if (isUnicodeEmoji(text)) return { ok: true, emoji: plainEmoji(text), custom: null };
  return { ok: false, message: "React with one emoji." };
}

/** A custom emoji's name as kept: lowercase, without colons. */
export function emojiName(input: unknown): { ok: true; name: string } | { ok: false; message: string } {
  const name = (typeof input === "string" ? input : "").trim().replace(/^:+|:+$/g, "").toLowerCase();
  if (name.length < 2 || name.length > 32) return { ok: false, message: "An emoji name is 2 to 32 characters." };
  if (!NAME.test(name)) return { ok: false, message: "An emoji name can only use lowercase letters, digits, -, _ and +." };
  if (STANDARD_SHORTCODES.has(name)) return { ok: false, message: `:${name}: is a standard emoji. Pick another name.` };
  return { ok: true, name };
}

export type EmojiImage = { content_type: "image/png" | "image/gif" | "image/webp"; width: number; height: number };

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

/** What an image is and how big, from its bytes (never its name), or null for anything else. */
export function sniffImage(bytes: Uint8Array): EmojiImage | null {
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG" && bytes[0] === 0x89 && ascii(bytes, 12, 4) === "IHDR") {
    return { content_type: "image/png", width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { content_type: "image/gif", width: le16(bytes, 6), height: le16(bytes, 8) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { content_type: "image/webp", width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
      return {
        content_type: "image/webp",
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8X") return { content_type: "image/webp", width: 1 + le24(bytes, 24), height: 1 + le24(bytes, 27) };
  }
  return null;
}

/** A custom emoji's file, checked: a PNG, GIF or WebP, small enough. */
export function emojiImage(bytes: Uint8Array): { ok: true; image: EmojiImage } | { ok: false; message: string } {
  if (!bytes.length) return { ok: false, message: "Choose an image." };
  if (bytes.length > MAX_EMOJI_BYTES) return { ok: false, message: "An emoji image is at most 256 KB." };
  const image = sniffImage(bytes);
  if (!image) return { ok: false, message: "An emoji image is a PNG, GIF or WebP." };
  if (!image.width || !image.height) return { ok: false, message: "That image has no size." };
  if (image.width > MAX_EMOJI_SIDE || image.height > MAX_EMOJI_SIDE) {
    return { ok: false, message: `An emoji image is at most ${MAX_EMOJI_SIDE}×${MAX_EMOJI_SIDE} pixels.` };
  }
  return { ok: true, image };
}

/** The bytes of a base64 file, or null when it is not base64. */
export function fromBase64(data: unknown): Uint8Array | null {
  if (typeof data !== "string" || data.length > Math.ceil((MAX_EMOJI_BYTES * 4) / 3) + 8 + 1024) return null;
  try {
    const plain = atob(data.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
    return Uint8Array.from(plain, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Whether a member may add one more reaction: it is already there, or there is room for another kind. */
export function roomForReaction(existing: ReadonlySet<string>, emoji: string): boolean {
  return existing.has(emoji) || existing.size < MAX_REACTIONS_PER_MESSAGE;
}

/** Whether someone may add a workspace's emoji. */
export function mayUpload(setting: EmojiUpload, role: "owner" | "member" | null): boolean {
  if (!role) return false;
  return setting === "members" || role === "owner";
}

/** Whether someone may remove a custom emoji: whoever added it, or an owner. */
export function mayRemove(createdBy: string, viewer: string, role: "owner" | "member" | null): boolean {
  return role === "owner" || (role != null && createdBy === viewer);
}

export type ReactionRow = { message_id: string; emoji: string; principal: string; created_at: string };

/** One emoji's reactions on one message, before profiles are resolved. */
export type ReactionTally = { emoji: string; count: number; me: boolean; by: string[] };

/**
 * Each message's reactions: one entry per emoji, in the order each was
 * first used, counting everyone who used it, whether `me` (a member key)
 * did, and the first `REACTORS_SHOWN` of them.
 */
export function tallyReactions(rows: ReactionRow[], me: string | null): Map<string, ReactionTally[]> {
  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.principal.localeCompare(b.principal));
  const out = new Map<string, ReactionTally[]>();
  for (const row of ordered) {
    const list = out.get(row.message_id) ?? [];
    let entry = list.find((r) => r.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, me: false, by: [] };
      list.push(entry);
    }
    entry.count += 1;
    if (row.principal === me) entry.me = true;
    if (entry.by.length < REACTORS_SHOWN) entry.by.push(row.principal);
    out.set(row.message_id, list);
  }
  return out;
}
