import type { Comparison, DiffLine, FileDiff } from "@g1t/contracts";

/** A diff line, with its text as highlighted HTML when the language is known. */
export type HighlightedLine = DiffLine & { html?: string };
export type HighlightedFile = Omit<FileDiff, "hunks"> & { hunks: { lines: HighlightedLine[] }[] };
export type HighlightedComparison = Omit<Comparison, "files"> & { files: HighlightedFile[] };
