/**
 * What every kind of folio says about its own content, so one room
 * (FolioRoom, src/folios/room.ts) serves docs, slides, designs and
 * dashboards alike. Each kind is one module under src/kinds/ and one line
 * in src/kinds/index.ts. Pure (yjs only): nothing here reads D1 or the
 * network.
 */
import type { DocBlockOutline, DocCitation, FolioAgentEdit, FolioKind, FolioPreview, FolioVersionKind } from "@g1t/contracts";
import type * as Y from "yjs";

import type { Chunk } from "../chunks.ts";

/** Who made a change on the server, for history. */
export type FolioOrigin = { key: string; kind: FolioVersionKind; note: string | null; authors?: string[] };

/** What the room saves after a burst of edits: everything derived from the content. */
export type Rendition = {
  /** The text rendition: search, recall, the read view, export. Never data values. */
  text: string;
  /** People mentioned (usernames, lowercased). */
  mentions: string[];
  /** Folio ids it links to. */
  links: string[];
  /** Code it cites. */
  citations: DocCitation[];
  /** What a card draws. */
  preview: FolioPreview | null;
};

/** The folio in the form an agent reads and writes. */
export type AgentForm = { content: string; blocks?: DocBlockOutline[] };

export interface KindModel {
  kind: FolioKind;
  /** Whether the document has nothing in it yet (so `seed` may fill it). */
  isEmpty(doc: Y.Doc): boolean;
  /** Fills an empty document: from a template's or an agent's text (Markdown) or spec, or blank. */
  seed(doc: Y.Doc, init: { text?: string | null; spec?: unknown }): void;
  render(doc: Y.Doc): Rendition;
  /** The text rendition as passages for the index (src/indexer.ts). */
  chunks(text: string, title: string): Chunk[];
  read(doc: Y.Doc): AgentForm;
  /** Applies an agent's (or a token's) edit in the kind's own terms. Not applied: what it targets is gone. */
  applyAgentEdit(doc: Y.Doc, edit: FolioAgentEdit, origin: FolioOrigin): { applied: boolean; summary: string };
  /** Makes the document what an old one was, as one change. */
  restore(doc: Y.Doc, old: Y.Doc, origin: FolioOrigin): void;
  /** Makes the document what an old text rendition was, when no state was kept. */
  restoreText(doc: Y.Doc, text: string, origin: FolioOrigin): void;
  /** What is wrong with the document's size or shape (node counts, sizes), or null. */
  validate(doc: Y.Doc): string | null;
}
