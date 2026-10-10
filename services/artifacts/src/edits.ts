/**
 * Changes made to a page's live document on the server: an agent's edit,
 * an accepted suggestion, a restored version, a comment's anchor. Each
 * runs in one Yjs transaction, so every open editor receives it as one
 * update and the change merges with whatever people are typing. Pure
 * (yjs only).
 */
import type { DocEditTarget } from "@g1t/contracts";
import * as Y from "yjs";

import { blockGroupOf, parseMarkdown, writeBlocks } from "./blocks.ts";
import { blocksMarkdown, partsOf, plainText, topContainers } from "./markdown.ts";

/** Top-level blocks `start` through `end - 1`; `start === end` is an insertion point. */
export type Range = { start: number; end: number };

function norm(text: string): string {
  return text.replace(/[*_`~#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Where a target is in the document now, or null when it is gone. */
export function findTarget(fragment: Y.XmlFragment, target: DocEditTarget): Range | null {
  const tops = topContainers(fragment);
  switch (target.kind) {
    case "append":
      return { start: tops.length, end: tops.length };
    case "document":
      return { start: 0, end: tops.length };
    case "section": {
      const want = norm(target.heading);
      if (!want) return null;
      const at = tops.findIndex((c) => {
        const content = partsOf(c).content;
        return content?.nodeName === "heading" && norm(plainText(content)) === want;
      });
      if (at < 0) return null;
      const level = Number(partsOf(tops[at]!).content!.getAttribute("level")) || 1;
      let end = at + 1;
      while (end < tops.length) {
        const content = partsOf(tops[end]!).content;
        if (content?.nodeName === "heading" && (Number(content.getAttribute("level")) || 1) <= level) break;
        end++;
      }
      return { start: at, end };
    }
    case "blocks": {
      const from = tops.findIndex((c) => c.getAttribute("id") === target.from_block);
      const to = tops.findIndex((c) => c.getAttribute("id") === target.to_block);
      if (from < 0 || to < 0) return null;
      return { start: Math.min(from, to), end: Math.max(from, to) + 1 };
    }
    default:
      return null;
  }
}

/** The Markdown of a range of top-level blocks. */
export function rangeMarkdown(fragment: Y.XmlFragment, range: Range): string {
  return blocksMarkdown(topContainers(fragment).slice(range.start, range.end));
}

/** The ids of a range's top-level blocks. */
export function rangeIds(fragment: Y.XmlFragment, range: Range): string[] {
  return topContainers(fragment)
    .slice(range.start, range.end)
    .map((c) => String(c.getAttribute("id") ?? ""));
}

/**
 * Replaces a range of top-level blocks with Markdown, in one transaction
 * whose origin is `origin` (who made it, for the page's history).
 */
export function replaceRange(doc: Y.Doc, fragment: Y.XmlFragment, range: Range, markdown: string, origin: unknown = null): void {
  const specs = parseMarkdown(markdown);
  doc.transact(() => {
    const group = blockGroupOf(fragment);
    // Only containers count; the group holds nothing else.
    const count = Math.min(range.end, group.length) - range.start;
    if (count > 0) group.delete(range.start, count);
    if (specs.length) group.insert(range.start, writeBlocks(specs));
    // The editor always keeps one block.
    if (group.length === 0) group.insert(0, writeBlocks([]));
  }, origin);
}

/** Applies an edit to a target; false when the target is gone. */
export function applyEdit(doc: Y.Doc, fragment: Y.XmlFragment, target: DocEditTarget, markdown: string, origin: unknown = null): boolean {
  const range = findTarget(fragment, target);
  if (!range) return false;
  replaceRange(doc, fragment, range, String(markdown ?? ""), origin);
  return true;
}

/**
 * Makes the document's blocks what another document's were (restoring a
 * version): the current blocks are removed and copies of the old ones put
 * in, as one change that every open editor merges.
 */
export function restoreFrom(doc: Y.Doc, fragment: Y.XmlFragment, old: Y.XmlFragment, origin: unknown = null): void {
  const oldGroup = old.toArray().find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "blockGroup");
  doc.transact(() => {
    const group = blockGroupOf(fragment);
    if (group.length) group.delete(0, group.length);
    const copies = (oldGroup?.toArray() ?? []).filter((n): n is Y.XmlElement => n instanceof Y.XmlElement).map((n) => n.clone());
    group.insert(0, copies.length ? copies : writeBlocks([]));
  }, origin);
}

/** Every text in the document, in document order. */
function texts(node: Y.XmlFragment | Y.XmlElement, out: Y.XmlText[] = []): Y.XmlText[] {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) out.push(child);
    else if (child instanceof Y.XmlElement) texts(child, out);
  }
  return out;
}

/** The mark key y-prosemirror uses for a comment (overlapping marks carry an 8-character suffix). */
export function commentMarkKey(threadId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < threadId.length; i++) {
    h ^= threadId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bytes = [h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, threadId.length & 255, 0x2a];
  return `comment--${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * Marks the text between two positions with a comment thread, the way the
 * editor does: the `comment` mark on every character in between, across
 * blocks if need be. Returns the text marked (the thread's quote), or null
 * when the positions are not in this document's text.
 */
export function anchorThread(doc: Y.Doc, fragment: Y.XmlFragment, anchor: unknown, head: unknown, threadId: string): string | null {
  let a: Y.AbsolutePosition | null = null;
  let b: Y.AbsolutePosition | null = null;
  try {
    a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor), doc);
    b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), doc);
  } catch {
    return null;
  }
  if (!a || !b || !(a.type instanceof Y.XmlText) || !(b.type instanceof Y.XmlText)) return null;
  const all = texts(fragment);
  let from = { at: all.indexOf(a.type as Y.XmlText), index: a.index };
  let to = { at: all.indexOf(b.type as Y.XmlText), index: b.index };
  if (from.at < 0 || to.at < 0) return null;
  if (from.at > to.at || (from.at === to.at && from.index > to.index)) [from, to] = [to, from];
  const key = commentMarkKey(threadId);
  const value = { orphan: false, threadId };
  let quote = "";
  doc.transact(() => {
    for (let t = from.at; t <= to.at; t++) {
      const text = all[t]!;
      const start = t === from.at ? from.index : 0;
      const end = t === to.at ? to.index : text.length;
      if (end > start) {
        text.format(start, end - start, { [key]: value });
        quote += (quote ? " " : "") + text.toString().replace(/<[^>]+>/g, "").slice(start, end);
      }
    }
  });
  return quote || null;
}

/** Takes a deleted thread's mark off the text it was on. */
export function unanchorThread(doc: Y.Doc, fragment: Y.XmlFragment, threadId: string): void {
  const key = commentMarkKey(threadId);
  doc.transact(() => {
    for (const text of texts(fragment)) {
      let at = 0;
      for (const d of text.toDelta() as { insert: string | object; attributes?: Record<string, { threadId?: string }> }[]) {
        const length = typeof d.insert === "string" ? d.insert.length : 1;
        for (const [name, attrs] of Object.entries(d.attributes ?? {})) {
          if (name.startsWith("comment") && attrs?.threadId === threadId) text.format(at, length, { [name]: null, [key]: null });
        }
        at += length;
      }
    }
  });
}
