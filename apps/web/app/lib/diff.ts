import type { Comparison, DiffLine, FileDiff } from "@g1t/contracts";

/** A diff line, with its text as highlighted HTML when the language is known. */
export type HighlightedLine = DiffLine & { html?: string };
export type HighlightedFile = Omit<FileDiff, "hunks"> & { hunks: { lines: HighlightedLine[] }[]; deferred?: Deferred };
export type HighlightedComparison = Omit<Comparison, "files"> & { files: HighlightedFile[] };

/**
 * A file sent without its lines, which the page fetches when it gets near
 * (components/diff-view.tsx): `lines` is how many it has, null when the
 * comparison did not read them (`omitted`); a `large` one waits to be asked
 * for.
 */
export type Deferred = { lines: number | null; large: boolean };

/** How many diff lines a page is sent with: about its first screens. */
export const FIRST_LINES = 2_000;
/** Past this a file's lines wait for "Load diff": generated files, lockfiles. */
export const LARGE_FILE_LINES = 1_000;

/** How many lines a file's diff has. */
export function linesOf(file: FileDiff): number {
  return file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/**
 * A comparison as a page is sent it: the first files with their lines,
 * until about `budget` lines, and every file after that, and any very large
 * one, with its path and counts only (`deferred`), so a pull request of
 * hundreds of files is not drawn, sent and hydrated all at once. Files
 * named in `eager` (ones with comments on their lines) keep their lines
 * wherever they are. The list itself is whole: the tree and counts show at once.
 */
export function firstScreens(
  comparison: Comparison | HighlightedComparison,
  { eager = [], budget = FIRST_LINES, large = LARGE_FILE_LINES }: { eager?: Iterable<string>; budget?: number; large?: number } = {},
): HighlightedComparison {
  const wanted = new Set(eager);
  let spent = 0;
  let full = false;
  const files = comparison.files.map((file): HighlightedFile => {
    if (file.omitted) return { ...file, hunks: [], deferred: { lines: null, large: false } };
    if (file.binary || file.hunks.length === 0) return file;
    const lines = linesOf(file);
    if (wanted.has(file.path)) {
      spent += lines;
      return file;
    }
    if (lines > large) return { ...file, hunks: [], deferred: { lines, large: true } };
    // In order, so what is drawn is the top of the change; once one does
    // not fit, the rest wait too.
    if (!full && spent + lines <= budget) {
      spent += lines;
      return file;
    }
    full = true;
    return { ...file, hunks: [], deferred: { lines, large: false } };
  });
  return { ...comparison, files };
}

/** The file a page's address points to, as `#file-<path>` (or `#diff-<path>`), if it is one of `files`. */
export function linkedFile(hash: string, files: { path: string }[]): string | null {
  const match = /^#(?:file|diff)-(.+)$/.exec(hash);
  if (!match) return null;
  let path = match[1]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not encoded: as it is.
  }
  return files.some((file) => file.path === path) ? path : null;
}

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
