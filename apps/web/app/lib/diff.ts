import type { Comparison, DiffLine, FileDiff } from "@g1t/contracts";

/** A diff line, with its text as highlighted HTML when the language is known. */
export type HighlightedLine = DiffLine & { html?: string };
export type HighlightedFile = Omit<FileDiff, "hunks"> & { hunks: { lines: HighlightedLine[] }[] };
export type HighlightedComparison = Omit<Comparison, "files"> & { files: HighlightedFile[] };

/** Each hunk's lines' HTML, null for a line without any: what a highlighted file adds to its diff. */
export type FileHtml = (string | null)[][];

/** The HTML `highlighted` gives its lines, to keep apart from the diff it came from. */
export function htmlOfFile(highlighted: HighlightedFile): FileHtml {
  return highlighted.hunks.map((hunk) => hunk.lines.map((line) => line.html ?? null));
}

/** `file` with `html` given back to its lines: the same as the highlighted file it was taken from. */
export function withHtml(file: FileDiff, html: FileHtml): HighlightedFile {
  return {
    ...file,
    hunks: file.hunks.map((hunk, h) => ({
      lines: hunk.lines.map((line, n): HighlightedLine => {
        const row = html[h]?.[n];
        return row == null ? { ...line } : { ...line, html: row };
      }),
    })),
  };
}

/**
 * What a file's highlighting depends on besides its language: each line's
 * side and text, hunk by hunk. Line numbers and the path do not change the
 * colours, so they are left out.
 */
export function diffContent(file: FileDiff): string {
  return JSON.stringify(file.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text])));
}
