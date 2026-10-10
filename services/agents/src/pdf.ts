/**
 * A PDF from Markdown, for `make_file` (files.ts): headings, paragraphs
 * with bold, italic, code and links, lists, quotes, code blocks, rules and
 * tables, laid out on US Letter pages with page numbers. Pure and small:
 * the standard Helvetica and Courier fonts every reader has (so no fonts
 * are embedded, and text is Latin script: what Windows-1252 holds),
 * uncompressed content, links as link annotations.
 */
import { type Block, type Span, parseBlocks, spanText } from "./file-markdown.ts";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 64;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;
const WIDTH = PAGE_W - 2 * MARGIN_X;
/** The most pages one file gets; the rest is cut, and said so. */
export const MAX_PDF_PAGES = 300;

type Font = "R" | "B" | "I" | "BI" | "M";
const FONT_NAMES: Record<Font, string> = { R: "Helvetica", B: "Helvetica-Bold", I: "Helvetica-Oblique", BI: "Helvetica-BoldOblique", M: "Courier" };
const FONT_IDS: Record<Font, string> = { R: "F1", B: "F2", I: "F3", BI: "F4", M: "F5" };

// Advance widths, in thousandths of the size, of characters 32 to 126 (Adobe's AFM metrics).
const REGULAR = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
  .split(" ")
  .map(Number);
const BOLD = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584"
  .split(" ")
  .map(Number);

/** Windows-1252's characters 0x80 to 0x9F, by their Unicode code point. */
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
/** Characters outside Windows-1252 written as near equivalents. */
const NEAR: Record<string, string> = { "→": "->", "←": "<-", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "−": "-", "‑": "-", "‐": "-", "✓": "v", "✔": "v", "✗": "x", "✘": "x", "­": "" };

/** Text as Windows-1252 codes: accents folded where it has no such letter, emoji dropped, anything else a question mark. */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 9) out.push(32);
    else if (code >= 32 && code <= 126) out.push(code);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else if (CP1252[code]) out.push(CP1252[code]!);
    else if (NEAR[ch] !== undefined) for (const c of NEAR[ch]!) out.push(c.charCodeAt(0));
    else if (/\p{Extended_Pictographic}|[​-‏️]/u.test(ch)) continue;
    else {
      const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      if (folded && [...folded].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)) for (const c of folded) out.push(c.charCodeAt(0));
      else if (code >= 32) out.push(63);
    }
  }
  return out;
}

function charWidth(code: number, font: Font): number {
  if (font === "M") return 600;
  const bold = font === "B" || font === "BI";
  if (code >= 32 && code <= 126) return (bold ? BOLD : REGULAR)[code - 32]!;
  if (code === 0xa0) return 278;
  if (code === 0x95) return 350;
  if (code === 0x97 || code === 0x85 || code === 0x89) return 1000;
  if (code === 0x91 || code === 0x92) return bold ? 278 : 222;
  if (code === 0x93 || code === 0x94) return bold ? 500 : 333;
  if (code >= 0xc0 && code <= 0xde) return 722;
  return 556;
}

/** How wide `text` is in `font` at `size`, in points. */
export function measure(text: string, font: Font, size: number): number {
  let w = 0;
  for (const code of winAnsi(text)) w += charWidth(code, font);
  return (w * size) / 1000;
}

/** A PDF literal string. */
function pdfString(text: string): string {
  let out = "(";
  for (const code of winAnsi(text)) {
    if (code === 40 || code === 41 || code === 92) out += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

type Color = [number, number, number];
const INK: Color = [0.1, 0.1, 0.12];
const MUTED: Color = [0.38, 0.38, 0.42];
const LINK: Color = [0.16, 0.36, 0.78];

type Piece = { text: string; font: Font; size: number; x: number; width: number; color: Color; href?: string };

function fontOf(span: Span, base: { bold?: boolean; italic?: boolean }): Font {
  if (span.code) return "M";
  const bold = !!(span.bold || base.bold);
  const italic = !!(span.italic || base.italic);
  return bold && italic ? "BI" : bold ? "B" : italic ? "I" : "R";
}

/** Spans wrapped to `width`: lines of pieces, x from the line's start. */
function wrap(spans: Span[], size: number, width: number, base: { bold?: boolean; italic?: boolean; color?: Color } = {}): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let x = 0;
  let space: { width: number; font: Font } | null = null;
  const newLine = () => {
    lines.push(line);
    line = [];
    x = 0;
    space = null;
  };
  const place = (text: string, font: Font, span: Span) => {
    const pieceSize = font === "M" ? size * 0.92 : size;
    const w = measure(text, font, pieceSize);
    const gap = space && line.length ? space.width : 0;
    if (line.length && x + gap + w > width) newLine();
    else if (gap) {
      const last = line[line.length - 1]!;
      last.text += " ";
      last.width += gap;
      x += gap;
    }
    const color = span.href ? LINK : (base.color ?? INK);
    const last = line[line.length - 1];
    if (last && last.font === font && last.href === span.href && last.x + last.width === x) {
      last.text += text;
      last.width += w;
    } else line.push({ text, font, size: pieceSize, x, width: w, color, ...(span.href ? { href: span.href } : {}) });
    x += w;
    space = null;
  };
  for (const span of spans) {
    const font = fontOf(span, base);
    for (const token of span.text.match(/\s+|\S+/g) ?? []) {
      if (/^\s+$/.test(token)) {
        space = { width: measure(" ", font, size), font };
        continue;
      }
      let word = token;
      // A word wider than the line is broken where it must be.
      while (measure(word, font, size) > width) {
        let cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut), font, size) > width) cut--;
        if (line.length) newLine();
        place(word.slice(0, cut), font, span);
        newLine();
        word = word.slice(cut);
      }
      if (word) place(word, font, span);
    }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

type Annot = { rect: [number, number, number, number]; uri: string };
type Page = { ops: string[]; annots: Annot[] };

/** The document being laid out: its pages, and where the next line goes. */
class Layout {
  pages: Page[] = [];
  y = 0;
  truncated = false;

  constructor() {
    this.newPage();
  }

  get page(): Page {
    return this.pages[this.pages.length - 1]!;
  }

  newPage(): boolean {
    if (this.pages.length >= MAX_PDF_PAGES) {
      this.truncated = true;
      return false;
    }
    this.pages.push({ ops: [], annots: [] });
    this.y = PAGE_H - MARGIN_TOP;
    return true;
  }

  /** Room for `height` more points on this page, or a new page; false when the document is full. */
  room(height: number): boolean {
    if (this.truncated) return false;
    if (this.y - height >= MARGIN_BOTTOM) return true;
    return this.newPage();
  }

  text(piece: Piece, x: number, baseline: number) {
    const [r, g, b] = piece.color;
    this.page.ops.push(`BT /${FONT_IDS[piece.font]} ${n(piece.size)} Tf ${n(r)} ${n(g)} ${n(b)} rg ${n(x)} ${n(baseline)} Td ${pdfString(piece.text)} Tj ET`);
    if (piece.href && /^(https?:|mailto:)/i.test(piece.href)) {
      // A space carried at the end of a link is not underlined.
      const width = measure(piece.text.trimEnd(), piece.font, piece.size);
      this.page.annots.push({ rect: [x, baseline - piece.size * 0.25, x + width, baseline + piece.size * 0.85], uri: piece.href });
      this.page.ops.push(`${n(r)} ${n(g)} ${n(b)} RG 0.5 w ${n(x)} ${n(baseline - 1.5)} m ${n(x + width)} ${n(baseline - 1.5)} l S`);
    }
  }

  fill(x: number, y: number, w: number, h: number, gray: number) {
    this.page.ops.push(`${n(gray)} g ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  }

  stroke(x1: number, y1: number, x2: number, y2: number, gray: number, width = 0.5) {
    this.page.ops.push(`${n(gray)} G ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }

  /** Lines of pieces from `left`, each `lead` tall. */
  lines(lines: Piece[][], left: number, size: number, lead: number, before?: (first: boolean, top: number) => void): boolean {
    let first = true;
    for (const line of lines) {
      if (!this.room(lead)) return false;
      before?.(first, this.y);
      const baseline = this.y - size;
      for (const piece of line) this.text(piece, left + piece.x, baseline);
      this.y -= lead;
      first = false;
    }
    return true;
  }
}

const BODY = 10.5;
const LEAD = 15;
const HEADINGS: Record<1 | 2 | 3, { size: number; before: number; after: number }> = {
  1: { size: 20, before: 14, after: 8 },
  2: { size: 15, before: 14, after: 6 },
  3: { size: 12.5, before: 10, after: 4 },
};

function table(layout: Layout, block: Extract<Block, { kind: "table" }>) {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const size = BODY - 1;
  const lead = 13;
  const pad = 5;
  const natural = Array.from({ length: columns }, (_, c) =>
    Math.min(260, Math.max(36, ...[block.header[c] ?? [], ...block.rows.map((row) => row[c] ?? [])].map((cell) => measure(spanText(cell), "B", size) + 2 * pad))),
  );
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = total > WIDTH ? natural.map((w) => (w / total) * WIDTH) : natural;
  const right = MARGIN_X + widths.reduce((a, b) => a + b, 0);
  const shape = (row: Span[][], header: boolean) => {
    const wrapped = widths.map((w, c) => wrap(row[c] ?? [], size, w - 2 * pad, { bold: header }));
    return { wrapped, height: Math.max(...wrapped.map((lines) => lines.length)) * lead + 2 * pad - 2 };
  };
  const draw = (row: { wrapped: Piece[][][]; height: number }, header: boolean) => {
    const top = layout.y;
    if (header) layout.fill(MARGIN_X, top - row.height, right - MARGIN_X, row.height, 0.94);
    let x = MARGIN_X;
    row.wrapped.forEach((lines, c) => {
      lines.forEach((line, i) => {
        for (const piece of line) layout.text(piece, x + pad + piece.x, top - pad - size + 1 - i * lead);
      });
      x += widths[c]!;
    });
    if (header) layout.stroke(MARGIN_X, top, right, top, 0.8);
    layout.stroke(MARGIN_X, top - row.height, right, top - row.height, 0.8);
    layout.y = top - row.height;
  };
  const header = block.header.length ? shape(block.header, true) : null;
  if (header) {
    if (!layout.room(header.height + lead * 2)) return;
    draw(header, true);
  }
  for (const cells of block.rows) {
    const row = shape(cells, false);
    const before = layout.pages.length;
    if (!layout.room(row.height)) return;
    // A table carried onto a new page repeats its header there.
    if (layout.pages.length !== before && header) draw(header, true);
    draw(row, false);
  }
  layout.y -= 10;
}

/** The PDF of `markdown`, titled `title` (the first heading when the Markdown starts without one). */
export function markdownPdf(title: string, markdown: string): { bytes: Uint8Array; pages: number; truncated: boolean } {
  let blocks = parseBlocks(markdown);
  if (title.trim() && !(blocks[0]?.kind === "heading" && blocks[0].level === 1)) blocks = [{ kind: "heading", level: 1, spans: [{ text: title.trim() }] }, ...blocks];
  const layout = new Layout();
  let previous: Block["kind"] | null = null;
  for (const block of blocks) {
    if (layout.truncated) break;
    switch (block.kind) {
      case "heading": {
        const style = HEADINGS[block.level];
        if (previous) layout.y -= style.before;
        const lines = wrap(block.spans, style.size, WIDTH, { bold: true });
        // Keep a heading with the line after it.
        layout.room(lines.length * style.size * 1.25 + LEAD * 2);
        layout.lines(lines, MARGIN_X, style.size, style.size * 1.25);
        if (block.level === 1) layout.stroke(MARGIN_X, layout.y + 2, MARGIN_X + WIDTH, layout.y + 2, 0.85);
        layout.y -= style.after;
        break;
      }
      case "paragraph":
        layout.lines(wrap(block.spans, BODY, WIDTH), MARGIN_X, BODY, LEAD);
        layout.y -= 7;
        break;
      case "item": {
        const indent = 16 + block.depth * 16;
        const marker = block.ordered ? `${block.number}.` : block.depth % 2 ? "–" : "•";
        const lines = wrap(block.spans, BODY, WIDTH - indent);
        layout.lines(lines, MARGIN_X + indent, BODY, LEAD, (first, top) => {
          if (!first) return;
          const piece: Piece = { text: marker, font: "R", size: BODY, x: 0, width: measure(marker, "R", BODY), color: MUTED };
          layout.text(piece, MARGIN_X + indent - 6 - piece.width, top - BODY);
        });
        layout.y -= 3;
        break;
      }
      case "quote": {
        const lines = wrap(block.spans, BODY, WIDTH - 16, { color: MUTED });
        layout.lines(lines, MARGIN_X + 14, BODY, LEAD, (_first, top) => layout.fill(MARGIN_X, top - LEAD + 2, 2.5, LEAD, 0.75));
        layout.y -= 7;
        break;
      }
      case "code": {
        const size = 8.6;
        const lead = 11.5;
        const perLine = Math.floor((WIDTH - 16) / ((600 * size) / 1000));
        const rows = block.text.split("\n").flatMap((row) => {
          if (!row) return [""];
          const parts: string[] = [];
          for (let i = 0; i < row.length; i += perLine) parts.push(row.slice(i, i + perLine));
          return parts;
        });
        layout.y -= 2;
        for (const row of rows) {
          if (!layout.room(lead)) break;
          layout.fill(MARGIN_X, layout.y - lead, WIDTH, lead, 0.955);
          if (row) layout.text({ text: row, font: "M", size, x: 0, width: 0, color: INK }, MARGIN_X + 8, layout.y - size - 0.5);
          layout.y -= lead;
        }
        layout.y -= 9;
        break;
      }
      case "rule":
        if (layout.room(14)) {
          layout.stroke(MARGIN_X, layout.y - 6, MARGIN_X + WIDTH, layout.y - 6, 0.8);
          layout.y -= 14;
        }
        break;
      case "table":
        table(layout, block);
        break;
    }
    previous = block.kind;
  }
  return { bytes: writePdf(title, layout.pages), pages: layout.pages.length, truncated: layout.truncated };
}

/** The file: a catalog, the page tree, the fonts, then each page with its content and links. */
function writePdf(title: string, pages: Page[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const tree = add("");
  const info = add(`<< /Title ${pdfString(title)} /Producer (g1t) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`);
  const fonts = (Object.keys(FONT_NAMES) as Font[]).map((font) => `/${FONT_IDS[font]} ${add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[font]} /Encoding /WinAnsiEncoding >>`)} 0 R`);
  const kids: number[] = [];
  pages.forEach((page, index) => {
    const footer = `BT /F1 8.5 Tf 0.55 0.55 0.6 rg ${n(PAGE_W / 2 - measure(`${index + 1} of ${pages.length}`, "R", 8.5) / 2)} 36 Td ${pdfString(`${index + 1} of ${pages.length}`)} Tj ET`;
    const stream = [...page.ops, footer].join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots = page.annots.map((a) => add(`<< /Type /Annot /Subtype /Link /Rect [${a.rect.map(n).join(" ")}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(a.uri)} >> >>`));
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fonts.join(" ")} >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
