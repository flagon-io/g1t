import { waitUntil } from "cloudflare:workers";

import type { Comparison } from "@g1t/contracts";

import { type SharedCache, contentCache, weightOfLines } from "./content-cache";
import { type FileHtml, type HighlightedComparison, type HighlightedFile, diffContent, htmlOfFile, withHtml } from "./diff";

// Shiki and its grammars load on the first file highlighted, not when the
// Worker starts: most requests highlight nothing. The module is asked for
// once per isolate.
let shikiModule: Promise<typeof import("./shiki")> | undefined;
const shiki = () => (shikiModule ??= import("./shiki"));

const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * Highlighting is most of the work of a file's page (about two thirds of a
 * small file's, nine tenths of a large one's), and the same text always
 * highlights the same way. So it is kept by a hash of the text and its
 * language: in the isolate, and in the data centre's cache for the other
 * isolates there (lib/content-cache.ts). A file read again on another
 * branch or commit, through blame, or by the next crawler, is highlighted
 * once. Bump `HIGHLIGHT_VERSION` when the theme, the grammars, Shiki or
 * `linesToHtml` change what they make.
 */
export const HIGHLIGHT_VERSION = "v2";

function dataCentre(): SharedCache | null {
  try {
    return (caches as unknown as { default: Cache }).default ?? null;
  } catch {
    // No cache (local development).
    return null;
  }
}

function defer(work: Promise<unknown>) {
  try {
    waitUntil(work);
  } catch {
    // Outside a request: the write finishes or not; nothing waits on it.
  }
}

/**
 * About 8 MB of highlighted lines per isolate (two bytes a character); one
 * file up to a quarter of that, which a 1,800-line file fits. A pull
 * request's first screens are at most 40,000 characters of text, about
 * ten times that highlighted.
 */
const linesCache = contentCache<string[]>({
  name: "highlight-lines",
  version: HIGHLIGHT_VERSION,
  maxWeight: 4_000_000,
  weigh: weightOfLines,
  shared: dataCentre,
  defer,
});

const filesCache = contentCache<FileHtml>({
  name: "highlight-diff",
  version: HIGHLIGHT_VERSION,
  maxWeight: 2_000_000,
  weigh: (html) => html.reduce((sum, hunk) => sum + weightOfLines(hunk), 0),
  shared: dataCentre,
  defer,
});

/**
 * A file's lines as highlighted HTML, one string per line, or null when its
 * language is unknown or it is too large.
 */
export async function highlightLines(path: string, text: string): Promise<string[] | null> {
  const { languageOf } = await shiki();
  const lang = languageOf(path);
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return null;
  const code = text.replace(/\n$/, "");
  return linesCache([lang, code], async () => {
    const { getHighlighter, linesToHtml } = await shiki();
    try {
      return linesToHtml(await getHighlighter(), code, lang);
    } catch {
      return null;
    }
  });
}

/**
 * How much of a change is highlighted before the page is sent: its first
 * screens. The rest is highlighted in the browser as it comes near
 * (components/diff-view.tsx), so a large change never holds the page up.
 */
const FIRST_SCREENS_CHARS = 40_000;

/** A file's diff highlighted, from the cache when the same lines were highlighted before. */
async function highlightFileCached(file: Comparison["files"][number]): Promise<HighlightedFile | null> {
  const { highlightFile, languageOf } = await shiki();
  const lang = languageOf(file.path);
  // Nothing to highlight: highlightFile says so without any work.
  if (!lang || file.binary) return null;
  const html = await filesCache([lang, diffContent(file)], async () => {
    const highlighted = await highlightFile(file).catch(() => null);
    return highlighted ? htmlOfFile(highlighted) : null;
  });
  return html ? withHtml(file, html) : null;
}

/**
 * A comparison with its first files' lines highlighted, in order, until
 * the budget runs out, so what is on screen when the page arrives already
 * has its colours.
 */
export async function highlightFirstFiles(comparison: Comparison): Promise<HighlightedComparison> {
  let budget = FIRST_SCREENS_CHARS;
  const files: HighlightedFile[] = [];
  for (const file of comparison.files) {
    const size = file.hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((n, line) => n + line.text.length + 1, 0), 0);
    if (budget <= 0 || size > budget || file.binary) {
      // Past the first screens: everything after it waits for the browser.
      budget = 0;
      files.push(file);
      continue;
    }
    budget -= size;
    files.push((await highlightFileCached(file).catch(() => null)) ?? file);
  }
  return { ...comparison, files };
}
