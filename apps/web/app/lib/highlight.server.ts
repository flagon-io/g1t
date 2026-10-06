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
