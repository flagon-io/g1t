/**
 * The doc kind: BlockNote on `XmlFragment("document-store")`, comments in
 * the `threads` map, Markdown as its text rendition. The same document,
 * code and behaviour as Docs' pages (src/blocks.ts, src/markdown.ts,
 * src/edits.ts, src/citations.ts, src/threads.ts), which PageRoom still
 * uses until Phase 7 retires it; those modules move here then. Pure.
 */
import type { DocEditTarget } from "@g1t/contracts";
import * as Y from "yjs";

import { seed as seedBlocks } from "../../blocks.ts";
import { chunkMarkdown } from "../../chunks.ts";
import { bodyCitations } from "../../citations.ts";
import { applyEdit, findTarget, rangeIds, rangeMarkdown, restoreFrom } from "../../edits.ts";
import { citationNodes, documentMarkdown, mentionedIds, outline, searchText } from "../../markdown.ts";
import type { FolioOrigin, KindModel, Rendition } from "../types.ts";

/** Every folio id a text links to, for backlinks (as `linkedFolioIds` in @g1t/contracts; kept here so this module stays pure for Node's tests). */
export function linkedFolioIds(text: string): string[] {
  return [...new Set(text.match(/fol_[0-9a-hjkmnp-tv-z]{26}/g) ?? [])];
}

/** Where BlockNote keeps the document. */
export const DOC_FRAGMENT = "document-store";
/** The most a doc's Markdown may be. */
export const DOC_MAX_TEXT = 512 * 1024;
/** Lines a card shows. */
const PREVIEW_LINES = 4;

export function docFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOC_FRAGMENT);
}

/** The first lines of a doc, as plain text, for its card. */
export function previewLines(markdown: string, max = PREVIEW_LINES): string[] {
  return searchText(markdown)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => (l.length > 120 ? `${l.slice(0, 119)}…` : l));
}

/** A target's current Markdown and blocks, or null when it is gone. */
export function docTarget(doc: Y.Doc, target: DocEditTarget): { markdown: string; block_ids: string[] } | null {
  const fragment = docFragment(doc);
  const range = findTarget(fragment, target);
  if (!range) return null;
  return { markdown: rangeMarkdown(fragment, range), block_ids: rangeIds(fragment, range) };
}

/** Where each target is now, for marking open suggestions in the editor (null: gone). */
export function docTargets(doc: Y.Doc, targets: DocEditTarget[]): (string[] | null)[] {
  const fragment = docFragment(doc);
  return targets.map((t) => {
    const range = findTarget(fragment, t);
    return range ? rangeIds(fragment, range) : null;
  });
}

function describe(target: DocEditTarget): string {
  switch (target.kind) {
    case "append":
      return "Added to the end";
    case "document":
      return "Rewrote the doc";
    case "section":
      return `Changed the section "${target.heading}"`;
    case "blocks":
      return "Changed some blocks";
  }
}

export const doc: KindModel = {
  kind: "doc",
  isEmpty: (d) => docFragment(d).length === 0,
  seed(d, init) {
    seedBlocks(d, docFragment(d), String(init.text ?? "").slice(0, DOC_MAX_TEXT));
  },
  render(d): Rendition {
    const fragment = docFragment(d);
    const text = documentMarkdown(fragment);
    return {
      text,
      mentions: mentionedIds(fragment).users,
      links: linkedFolioIds(text),
      citations: bodyCitations(citationNodes(fragment), text),
      preview: { kind: "doc", lines: previewLines(text) },
    };
  },
  chunks: (text, title) => chunkMarkdown(text, title),
  read(d) {
    const fragment = docFragment(d);
    return { content: documentMarkdown(fragment), blocks: outline(fragment) };
  },
  applyAgentEdit(d, edit, origin: FolioOrigin) {
    if (edit.kind !== "doc") return { applied: false, summary: "That edit is for another kind of artifact." };
    const applied = applyEdit(d, docFragment(d), edit.target, String(edit.markdown ?? "").slice(0, DOC_MAX_TEXT), origin);
    return { applied, summary: applied ? describe(edit.target) : "That part of the doc isn't there." };
  },
  restore(d, old, origin) {
    restoreFrom(d, docFragment(d), docFragment(old), origin);
  },
  restoreText(d, text, origin) {
    applyEdit(d, docFragment(d), { kind: "document" }, text, origin);
  },
  validate(d) {
    return documentMarkdown(docFragment(d)).length > DOC_MAX_TEXT * 2 ? "This doc is too long." : null;
  },
};
