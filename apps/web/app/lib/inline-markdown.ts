/**
 * The few marks an agent's one-line summary or a memory's first line
 * carries, read so a row shows them as marks rather than as asterisks and
 * backticks: **bold**, *italic* or _italic_, `code`, and [links](…) as
 * their words. Nothing else; a row is one line, not a document.
 */

export type InlinePart = { kind: "text" | "strong" | "em" | "code"; text: string };

const MARKS = /`([^`]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\([^)\s]*\)/g;

export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const push = (kind: InlinePart["kind"], value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (kind === "text" && last?.kind === "text") last.text += value;
    else parts.push({ kind, text: value });
  };
  let at = 0;
  for (const match of text.matchAll(MARKS)) {
    push("text", text.slice(at, match.index));
    const [, code, strong, strongU, em, emU, link] = match;
    if (code != null) push("code", code);
    else if (strong != null || strongU != null) push("strong", (strong ?? strongU)!);
    else if (em != null || emU != null) push("em", (em ?? emU)!);
    else push("text", link ?? "");
    at = match.index + match[0].length;
  }
  push("text", text.slice(at));
  return parts;
}

/** The words alone, for a tooltip or an attribute. */
export function inlinePlain(text: string): string {
  return inlineParts(text)
    .map((part) => part.text)
    .join("");
}
