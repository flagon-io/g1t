/**
 * The Markdown agents write, read into a few kinds of block for the files
 * `make_file` writes (pdf.ts, ooxml.ts). Not a full CommonMark parser: the
 * subset a document needs (headings, paragraphs, bold, italic, code, links,
 * lists, quotes, code blocks, rules and tables), read forgivingly. Pure.
 */

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "item"; ordered: boolean; number: number; depth: number; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "table"; header: Span[][]; rows: Span[][][] };

/** Inline Markdown as spans: **bold**, *italic*, `code`, [links](url); ~~strike~~ and HTML tags read as their text. */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const push = (span: Span) => {
    if (!span.text) return;
    const last = spans[spans.length - 1];
    if (last && !!last.bold === !!span.bold && !!last.italic === !!span.italic && !!last.code === !!span.code && last.href === span.href) last.text += span.text;
    else spans.push(span);
  };
  const walk = (input: string, marks: { bold?: boolean; italic?: boolean; href?: string }) => {
    let i = 0;
    let plain = "";
    const flush = () => {
      if (plain) push({ text: plain, ...marks });
      plain = "";
    };
    while (i < input.length) {
      const rest = input.slice(i);
      const ch = input[i]!;
      if (ch === "\\" && i + 1 < input.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(input[i + 1]!)) {
        plain += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === "`") {
        const end = input.indexOf("`", i + 1);
        if (end > i) {
          flush();
          push({ text: input.slice(i + 1, end), code: true, ...(marks.href ? { href: marks.href } : {}) });
          i = end + 1;
          continue;
        }
      }
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link && !marks.href) {
        flush();
        walk(link[1]!, { ...marks, href: link[2]! });
        i += link[0].length;
        continue;
      }
      const image = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
      if (image) {
        flush();
        push({ text: image[1] || "image", ...marks, href: image[2]! });
        i += image[0].length;
        continue;
      }
      const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
      if (strong && (strong[1] === "**" || !/\w/.test(input[i - 1] ?? ""))) {
        flush();
        walk(strong[2]!, { ...marks, bold: true });
        i += strong[0].length;
        continue;
      }
      const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?!\1)/.exec(rest);
      if (em && (em[1] === "*" || (!/\w/.test(input[i - 1] ?? "") && !/\w/.test(input[i + em[0].length] ?? "")))) {
        flush();
        walk(em[2]!, { ...marks, italic: true });
        i += em[0].length;
        continue;
      }
      const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (strike) {
        flush();
        walk(strike[1]!, marks);
        i += strike[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][^>]*>/.exec(rest);
      if (tag) {
        plain += /^<br\s*\/?>$/i.test(tag[0]) ? " " : "";
        i += tag[0].length;
        continue;
      }
      plain += ch;
      i += 1;
    }
    flush();
  };
  walk(text.replace(/\s+/g, " ").trim(), {});
  return spans;
}

/** A table row's cells, without the outer pipes. */
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (row[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += row[i];
  }
  out.push(cell.trim());
  return out;
}

const DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Markdown as blocks. */
export function parseBlocks(markdown: string): Block[] {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", spans: parseSpans(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      endParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      // A Mermaid chart can't be drawn into a file: its source is kept, as code.
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, spans: parseSpans(heading[2]!) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && DIVIDER.test(lines[i + 1]!)) {
      endParagraph();
      const header = cells(line).map(parseSpans);
      const rows: Span[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!).map(parseSpans));
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      endParagraph();
      const body = [quote[1]!];
      while (i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1]!)) body.push(lines[++i]!.replace(/^\s{0,3}>\s?/, ""));
      // GitHub's alerts (> [!NOTE]) read as their text.
      const text = body.join(" ").replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, (_, kind: string) => `${kind[0]!.toUpperCase()}${kind.slice(1).toLowerCase()}: `);
      blocks.push({ kind: "quote", spans: parseSpans(text) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      endParagraph();
      const marker = item[2]!;
      const ordered = /\d/.test(marker);
      let text = item[3]!;
      // Lazy continuation lines belong to the item.
      while (i + 1 < lines.length && lines[i + 1]!.trim() && !ITEM.test(lines[i + 1]!) && /^\s{2,}\S/.test(lines[i + 1]!) && !/^\s*(```|~~~|#|>|\|)/.test(lines[i + 1]!)) {
        text += ` ${lines[++i]!.trim()}`;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) text = `${task[1] === " " ? "[ ]" : "[x]"} ${task[2]}`;
      blocks.push({ kind: "item", ordered, number: ordered ? Number.parseInt(marker, 10) : 0, depth: Math.min(3, Math.floor(item[1]!.length / 2)), spans: parseSpans(text) });
      continue;
    }
    paragraph.push(line.trim());
  }
  endParagraph();
  return blocks;
}

/** A span list's plain text. */
export function spanText(spans: Span[]): string {
  return spans.map((s) => s.text).join("");
}
