import type { Comparison } from "@g1t/contracts";

import type { HighlightedComparison, HighlightedFile } from "./diff";

// Shiki and its grammars load on the first file highlighted, not when the
// Worker starts: most requests highlight nothing.
const shiki = () => import("./shiki");

const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * Highlighted HTML for a file, or null when its language is unknown or it
 * is too large, in which case the caller shows plain text.
 */
export async function highlight(path: string, text: string): Promise<string | null> {
  const { THEME, getHighlighter, languageOf } = await shiki();
  const lang = languageOf(path);
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return (await getHighlighter()).codeToHtml(text.replace(/\n$/, ""), { lang, theme: THEME });
  } catch {
    return null;
  }
}

/**
 * A file's lines as highlighted HTML, one string per line, or null when its
 * language is unknown or it is too large.
 */
export async function highlightLines(path: string, text: string): Promise<string[] | null> {
  const { getHighlighter, languageOf, linesToHtml } = await shiki();
  const lang = languageOf(path);
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return linesToHtml(await getHighlighter(), text.replace(/\n$/, ""), lang);
  } catch {
    return null;
  }
}

/**
 * How much of a change is highlighted before the page is sent: its first
 * screens. The rest is highlighted in the browser as it comes near
 * (components/diff-view.tsx), so a large change never holds the page up.
 */
const FIRST_SCREENS_CHARS = 40_000;

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
    const { highlightFile } = await shiki();
    files.push((await highlightFile(file).catch(() => null)) ?? file);
  }
  return { ...comparison, files };
}
