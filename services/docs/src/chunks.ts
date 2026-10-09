/**
 * Passages: a page's Markdown (or a repository's docs file) split into
 * sections an agent can be handed whole, for the semantic index
 * (src/indexer.ts) and recall. Pure.
 *
 * A passage is one section under its heading path ("Runbook › Rollback"),
 * between MIN_CHARS and MAX_CHARS where it can be: long sections split on
 * paragraph boundaries (a fenced code block stays one paragraph), tiny ones
 * join the next. What is embedded is the passage with its document's title
 * and heading in front (`embedText`); what an agent reads is the passage.
 */

/** A passage shorter than this joins the next one. */
export const MIN_CHARS = 300;
/** A passage longer than this splits on paragraphs. */
export const MAX_CHARS = 1500;
/** The most passages one document keeps; past it the rest goes unindexed (words still find the page). */
export const MAX_CHUNKS = 150;
/** The most text embedded for one passage: the model reads 512 tokens. */
export const EMBED_CHARS = 2000;
/** Between heading levels in a passage's heading path. */
export const HEADING_SEPARATOR = " › ";

export type Chunk = {
  seq: number;
  /** The heading path the passage sits under, or null before the first heading. */
  heading: string | null;
  /** The passage as Markdown. */
  text: string;
};

type Section = { heading: string | null; lines: string[] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/** A heading's text as plain words: no emphasis, code ticks or links. */
function headingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops YAML front matter, as repository docs files often have. */
function withoutFrontMatter(markdown: string): string {
  const front = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(markdown);
  return front ? markdown.slice(front[0].length) : markdown;
}

/** The document split at its headings, each section with its heading path. */
function sections(markdown: string, title: string): Section[] {
  const lines = withoutFrontMatter(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out: Section[] = [{ heading: null, lines: [] }];
  const path: { level: number; text: string }[] = [];
  let fence: string | null = null;
  let first = true;
  const wantTitle = headingText(title).toLowerCase();
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      out[out.length - 1]!.lines.push(line);
      continue;
    }
    if (f) {
      fence = f[1]!;
      out[out.length - 1]!.lines.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (!h) {
      if (line.trim()) first = false;
      out[out.length - 1]!.lines.push(line);
      continue;
    }
    const level = h[1]!.length;
    const text = headingText(h[2]!);
    // A file's leading `# Title` is its title, not a section of it.
    if (first && level === 1 && text.toLowerCase() === wantTitle) {
      first = false;
      continue;
    }
    first = false;
    while (path.length && path[path.length - 1]!.level >= level) path.pop();
    path.push({ level, text });
    out.push({ heading: path.map((p) => p.text).filter(Boolean).join(HEADING_SEPARATOR) || null, lines: [] });
  }
  return out;
}

/** Paragraphs: runs of lines between blank lines, with a fenced block kept whole. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      current.push(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      current.push(line);
      continue;
    }
    if (!line.trim()) flush();
    else current.push(line);
  }
  flush();
  return out;
}

/** A paragraph longer than MAX_CHARS, cut at sentence ends or spaces. */
function cut(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    let at = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("\n"));
    if (at < MAX_CHARS / 2) at = window.lastIndexOf(" ");
    if (at < MAX_CHARS / 2) at = MAX_CHARS - 1;
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** One section's passages: its paragraphs packed up to MAX_CHARS. */
function pack(paras: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const para of paras.flatMap(cut)) {
    if (!current) current = para;
    else if (current.length + 2 + para.length <= MAX_CHARS) current += `\n\n${para}`;
    else {
      out.push(current);
      current = para;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * A document's passages, in order. `title` is the page's or file's title:
 * not part of any passage, but a file's leading `# Title` is dropped as it.
 */
export function chunkMarkdown(markdown: string, title = ""): Chunk[] {
  const pieces: { heading: string | null; text: string }[] = [];
  for (const section of sections(String(markdown ?? ""), title)) {
    for (const text of pack(paragraphs(section.lines))) pieces.push({ heading: section.heading, text });
    // A heading with nothing under it but subsections still names them: nothing to keep alone.
  }
  // Tiny passages join the next one (its heading written in), while that fits.
  const merged: { heading: string | null; text: string }[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MIN_CHARS) {
      const joined = piece.heading && piece.heading !== last.heading ? `${last.text}\n\n**${piece.heading.split(HEADING_SEPARATOR).pop()}**\n\n${piece.text}` : `${last.text}\n\n${piece.text}`;
      if (joined.length <= MAX_CHARS) {
        last.text = joined;
        if (!last.heading) last.heading = piece.heading;
        continue;
      }
    }
    merged.push({ ...piece });
  }
  // A tiny last passage joins the one before it, when that fits.
  if (merged.length > 1) {
    const last = merged[merged.length - 1]!;
    const before = merged[merged.length - 2]!;
    if (last.text.length < MIN_CHARS && before.text.length + last.text.length + 40 <= MAX_CHARS) {
      before.text = last.heading && last.heading !== before.heading ? `${before.text}\n\n**${last.heading.split(HEADING_SEPARATOR).pop()}**\n\n${last.text}` : `${before.text}\n\n${last.text}`;
      merged.pop();
    }
  }
  return merged.slice(0, MAX_CHUNKS).map((piece, seq) => ({ seq, heading: piece.heading, text: piece.text }));
}

/** What is embedded for a passage: its document's title and heading in front, so a passage alone still says what it is about. */
export function embedText(title: string, chunk: Pick<Chunk, "heading" | "text">): string {
  const head = [title.trim(), chunk.heading ?? ""].filter(Boolean).join(HEADING_SEPARATOR);
  return (head ? `${head}\n\n${chunk.text}` : chunk.text).slice(0, EMBED_CHARS);
}

/** A short, stable hash (hex) of a string: whether a passage changed since it was embedded. Not for security. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** A repository docs file's id in the index (`rf_` and 32 hex): short enough for a vector id, the same each time. */
export function repoFileId(spaceId: string, path: string): string {
  return `rf_${textHash(`${spaceId}\n${path}`)}${textHash(`${path}\n${spaceId}`)}`;
}

/** A passage's id, in D1 and in the vector index: `<page or file id>:<seq>`. */
export function chunkId(docId: string, seq: number): string {
  return `${docId}:${seq}`;
}
