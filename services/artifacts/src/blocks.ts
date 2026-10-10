/**
 * Markdown into a page's Yjs document: how templates, agents' edits and
 * accepted suggestions become blocks. Pure (yjs only).
 *
 * `parseMarkdown` reads the Markdown agents write (CommonMark plus GitHub's
 * tables, task lists and alerts, `$$` math and Mermaid fences) into block
 * specs; `writeBlocks` turns specs into BlockNote's `blockContainer`
 * elements, with the attributes the editor gives its own blocks, so the
 * editor shows them exactly as if typed. The inverse is markdown.ts.
 */
import * as Y from "yjs";

export type Marks = Record<string, object>;
export type Run = { text: string; marks?: Marks } | { node: "mention"; attrs: Record<string, string> };

export type BlockSpec = {
  type: string;
  props?: Record<string, string | number | boolean>;
  /** Inline content; a code block's text is one plain run. */
  content?: Run[];
  /** A table's cells: rows of cells of runs. */
  rows?: Run[][][];
  children?: BlockSpec[];
};

const ALERT_KINDS: Record<string, string> = { NOTE: "info", IMPORTANT: "info", TIP: "success", WARNING: "warning", CAUTION: "danger" };

// ── Inline ────────────────────────────────────────────────────────────────

/** Inline Markdown as runs: bold, italic, strike, underline, code, links. */
export function parseInline(text: string, marks: Marks = {}): Run[] {
  const runs: Run[] = [];
  let plain = "";
  const flush = () => {
    if (plain) runs.push(Object.keys(marks).length ? { text: plain, marks: { ...marks } } : { text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // Escapes.
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_{}[\]()#+\-.!~|<>$]/.test(rest[1]!)) {
      plain += rest[1];
      i += 2;
      continue;
    }
    // Hard break: a backslash at the end of a line.
    if (rest.startsWith("\\\n")) {
      plain += "\n";
      i += 2;
      continue;
    }
    // Code.
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      flush();
      runs.push({ text: code[2]!.replace(/^ (.*) $/, "$1"), marks: { ...marks, code: {} } });
      i += code[0].length;
      continue;
    }
    // Images inline: keep as a link to the image.
    const link = /^!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      runs.push(...parseInline(link[1]! || link[2]!, { ...marks, link: { href: link[2]! } }));
      i += link[0].length;
      continue;
    }
    const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
    if (auto) {
      flush();
      runs.push({ text: auto[1]!, marks: { ...marks, link: { href: auto[1]! } } });
      i += auto[0].length;
      continue;
    }
    const underline = /^<u>([\s\S]+?)<\/u>/.exec(rest);
    if (underline) {
      flush();
      runs.push(...parseInline(underline[1]!, { ...marks, underline: {} }));
      i += underline[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      runs.push(...parseInline(strong[2]!, { ...marks, bold: {} }));
      i += strong[0].length;
      continue;
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      flush();
      runs.push(...parseInline(strike[1]!, { ...marks, strike: {} }));
      i += strike[0].length;
      continue;
    }
    // `_` only at a word boundary, so snake_case stays as written.
    const em = /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/.exec(rest) ?? (/[A-Za-z0-9]$/.test(text.slice(0, i)) ? null : /^_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/.exec(rest));
    if (em) {
      flush();
      runs.push(...parseInline(em[1]!, { ...marks, italic: {} }));
      i += em[0].length;
      continue;
    }
    plain += rest[0];
    i += 1;
  }
  flush();
  return merge(runs);
}

function sameMarks(a: Marks | undefined, b: Marks | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && "text" in last && "text" in run && sameMarks(last.marks, run.marks)) last.text += run.text;
    else out.push("text" in run ? { ...run } : run);
  }
  return out.filter((r) => !("text" in r) || r.text !== "");
}

// ── Blocks ────────────────────────────────────────────────────────────────

type Line = { indent: number; text: string };

function lineOf(raw: string): Line {
  const expanded = raw.replace(/\t/g, "    ");
  const indent = /^ */.exec(expanded)![0].length;
  return { indent, text: expanded.slice(indent) };
}

const LIST_ITEM = /^([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

function isBlockStart(text: string): boolean {
  return /^(#{1,6}\s|>|```|~~~|\$\$|<details>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(text) || LIST_ITEM.test(text) || /^!\[[^\]]*\]\([^)]+\)\s*$/.test(text);
}

/** Markdown as block specs. */
export function parseMarkdown(markdown: string): BlockSpec[] {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines.map(lineOf), 0, lines.length);
}

function parseLines(lines: Line[], from: number, to: number): BlockSpec[] {
  const out: BlockSpec[] = [];
  let i = from;
  while (i < to) {
    const line = lines[i]!;
    const text = line.text;
    if (!text.trim()) {
      i++;
      continue;
    }
    // Fenced code, Mermaid.
    const fenceOpen = /^(`{3,}|~{3,})\s*([^\s`]*)/.exec(text);
    if (fenceOpen) {
      const marker = fenceOpen[1]!;
      const lang = fenceOpen[2]!.toLowerCase();
      const body: string[] = [];
      i++;
      while (i < to && !lines[i]!.text.startsWith(marker)) {
        body.push(" ".repeat(Math.max(0, lines[i]!.indent - line.indent)) + lines[i]!.text);
        i++;
      }
      i++;
      const code = body.join("\n");
      if (lang === "mermaid") out.push({ type: "mermaid", props: { code } });
      else if (lang === "math" || lang === "latex" || lang === "katex") out.push({ type: "math", props: { expression: code } });
      else out.push({ type: "codeBlock", props: { language: lang || "text" }, content: code ? [{ text: code }] : [] });
      continue;
    }
    // Math.
    if (text.startsWith("$$")) {
      const same = /^\$\$(.+)\$\$\s*$/.exec(text);
      if (same) {
        out.push({ type: "math", props: { expression: same[1]!.trim() } });
        i++;
        continue;
      }
      const body: string[] = [];
      i++;
      while (i < to && !lines[i]!.text.startsWith("$$")) body.push(lines[i++]!.text);
      i++;
      out.push({ type: "math", props: { expression: body.join("\n").trim() } });
      continue;
    }
    // Headings.
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (heading) {
      out.push({ type: "heading", props: { level: Math.min(heading[1]!.length, 6) }, content: parseInline(heading[2]!) });
      i++;
      continue;
    }
    // Dividers.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      out.push({ type: "divider" });
      i++;
      continue;
    }
    // Toggles.
    if (text.startsWith("<details>")) {
      let summary = "";
      const inner: Line[] = [];
      let depth = 0;
      const first = text.slice("<details>".length);
      const queue = first.trim() ? [{ indent: 0, text: first.trim() }] : [];
      i++;
      const take = (l: Line): boolean => {
        const sm = /^<summary>([\s\S]*?)<\/summary>\s*(.*)$/.exec(l.text);
        if (sm && !summary) {
          summary = sm[1]!;
          if (sm[2]) inner.push({ indent: 0, text: sm[2] });
          return false;
        }
        if (l.text.startsWith("<details>")) depth++;
        if (l.text.startsWith("</details>")) {
          if (depth === 0) return true;
          depth--;
        }
        inner.push(l);
        return false;
      };
      let closed = false;
      for (const l of queue) if (take(l)) closed = true;
      while (!closed && i < to) {
        closed = take(lines[i]!);
        i++;
      }
      out.push({ type: "toggleListItem", content: parseInline(summary.trim()), children: parseLines(inner, 0, inner.length) });
      continue;
    }
    // Quotes and callouts.
    if (text.startsWith(">")) {
      const body: string[] = [];
      while (i < to && lines[i]!.text.startsWith(">")) {
        body.push(lines[i]!.text.replace(/^>\s?/, ""));
        i++;
      }
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(body[0] ?? "");
      if (alert) {
        const rest = [alert[2]!, ...body.slice(1)].filter((l, n) => n > 0 || l.trim()).join("\n").trim();
        out.push({ type: "callout", props: { kind: ALERT_KINDS[alert[1]!.toUpperCase()] ?? "info" }, content: parseInline(joinParagraph(rest)) });
      } else {
        out.push({ type: "quote", content: parseInline(joinParagraph(body.join("\n").trim())) });
      }
      continue;
    }
    // Images on a line of their own.
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(text);
    if (image) {
      out.push({ type: "image", props: { url: image[2]!, caption: image[1]!, name: image[1]! } });
      i++;
      continue;
    }
    // Tables.
    if (text.includes("|") && i + 1 < to && TABLE_RULE.test(lines[i + 1]!.text)) {
      const rows: Run[][][] = [splitRow(text).map((c) => parseInline(c))];
      i += 2;
      while (i < to && lines[i]!.text.includes("|") && lines[i]!.text.trim()) {
        rows.push(splitRow(lines[i]!.text).map((c) => parseInline(c)));
        i++;
      }
      out.push({ type: "table", rows });
      continue;
    }
    // Lists.
    const item = LIST_ITEM.exec(text);
    if (item) {
      const base = line.indent;
      const marker = item[1]!;
      const contentIndent = base + marker.length + 1;
      let first = item[2]!;
      let type = /^\d/.test(marker) ? "numberedListItem" : "bulletListItem";
      const props: Record<string, string | number | boolean> = {};
      const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
      if (task && type === "bulletListItem") {
        type = "checkListItem";
        props.checked = task[1] !== " ";
        first = task[2]!;
      }
      if (type === "numberedListItem") {
        const start = parseInt(marker, 10);
        if (start !== 1 && !out.some((b) => b.type === "numberedListItem")) props.start = start;
      }
      i++;
      // Continuation lines of the item's own paragraph.
      const own = [first];
      while (i < to && lines[i]!.text.trim() && lines[i]!.indent >= contentIndent - 1 && !isBlockStart(lines[i]!.text) && !LIST_ITEM.test(lines[i]!.text)) {
        own.push(lines[i]!.text);
        i++;
      }
      // Nested blocks: lines indented past the marker (blank lines allowed between).
      const nested: Line[] = [];
      while (i < to) {
        const l = lines[i]!;
        if (!l.text.trim()) {
          // A blank line ends the item unless more indented content follows.
          let j = i + 1;
          while (j < to && !lines[j]!.text.trim()) j++;
          if (j < to && lines[j]!.indent > base && lines[j]!.indent >= Math.min(contentIndent, base + 2)) {
            for (; i < j; i++) nested.push({ indent: 0, text: "" });
            continue;
          }
          break;
        }
        if (l.indent > base && l.indent >= Math.min(contentIndent, base + 2)) {
          nested.push({ indent: l.indent - Math.min(contentIndent, l.indent), text: l.text });
          i++;
          continue;
        }
        break;
      }
      out.push({ type, props, content: parseInline(joinParagraph(own.join("\n"))), children: parseLines(nested, 0, nested.length) });
      continue;
    }
    // A paragraph: lines up to a blank line or another block.
    const para = [text];
    i++;
    while (i < to && lines[i]!.text.trim() && !isBlockStart(lines[i]!.text) && !(lines[i]!.text.includes("|") && i + 1 < to && TABLE_RULE.test(lines[i + 1]!.text))) {
      para.push(lines[i]!.text);
      i++;
    }
    out.push({ type: "paragraph", content: parseInline(joinParagraph(para.join("\n"))) });
  }
  return out;
}

/** Soft line breaks become spaces; a trailing backslash or two spaces stay a hard break. */
function joinParagraph(text: string): string {
  return text.replace(/( {2,}|\\)\n/g, "\\\n").replace(/([^\\])\n/g, "$1 ");
}

// ── Into Yjs ──────────────────────────────────────────────────────────────

/** The attributes BlockNote gives each of its blocks when it makes them. */
function defaults(type: string): Record<string, unknown> {
  const colors = { backgroundColor: "default", textColor: "default" };
  switch (type) {
    case "paragraph":
    case "bulletListItem":
    case "numberedListItem":
    case "toggleListItem":
      return { ...colors, textAlignment: "left" };
    case "checkListItem":
      return { ...colors, textAlignment: "left", checked: false };
    case "heading":
      return { ...colors, textAlignment: "left", level: 1, isToggleable: false };
    case "quote":
      return { ...colors };
    case "codeBlock":
      return { language: "text" };
    case "image":
      return { textAlignment: "left", backgroundColor: "default", name: "", url: "", caption: "", showPreview: true };
    case "table":
      return { textColor: "default" };
    case "callout":
      return { ...colors, kind: "info" };
    case "mermaid":
      return { code: "" };
    case "math":
      return { expression: "" };
    default:
      return {};
  }
}

function newBlockId(): string {
  return crypto.randomUUID();
}

function textOf(runs: Run[] | undefined): (Y.XmlText | Y.XmlElement)[] {
  const out: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  const pending: Run[] = [];
  const flush = () => {
    if (!pending.length) return;
    text = new Y.XmlText();
    let at = 0;
    for (const run of pending) {
      if (!("text" in run)) continue;
      text.insert(at, run.text, run.marks && Object.keys(run.marks).length ? run.marks : {});
      at += run.text.length;
    }
    out.push(text);
    pending.length = 0;
  };
  for (const run of runs ?? []) {
    if ("text" in run) pending.push(run);
    else {
      flush();
      const el = new Y.XmlElement(run.node);
      for (const [k, v] of Object.entries(run.attrs)) el.setAttribute(k, v);
      out.push(el);
    }
  }
  flush();
  return out;
}

function tableNode(rows: Run[][][]): Y.XmlElement {
  const table = new Y.XmlElement("table");
  for (const [k, v] of Object.entries(defaults("table"))) table.setAttribute(k, v as string);
  const width = Math.max(1, ...rows.map((r) => r.length));
  table.insert(
    0,
    rows.map((row) => {
      const tr = new Y.XmlElement("tableRow");
      tr.insert(
        0,
        Array.from({ length: width }, (_, n) => {
          const cell = new Y.XmlElement("tableCell");
          for (const [k, v] of Object.entries({ textColor: "default", backgroundColor: "default", textAlignment: "left", colspan: 1, rowspan: 1 })) cell.setAttribute(k, v as unknown as string);
          const p = new Y.XmlElement("tableParagraph");
          p.insert(0, textOf(row[n] ?? []));
          cell.insert(0, [p]);
          return cell;
        }),
      );
      return tr;
    }),
  );
  return table;
}

/** One block spec as a `blockContainer` (with its children), ready to insert. */
export function containerOf(spec: BlockSpec): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", newBlockId());
  let content: Y.XmlElement;
  if (spec.type === "table") content = tableNode(spec.rows ?? []);
  else {
    content = new Y.XmlElement(spec.type);
    for (const [k, v] of Object.entries({ ...defaults(spec.type), ...(spec.props ?? {}) })) content.setAttribute(k, v as string);
    if (spec.content?.length) content.insert(0, textOf(spec.content));
  }
  const parts: Y.XmlElement[] = [content];
  if (spec.children?.length) {
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, spec.children.map(containerOf));
    parts.push(group);
  }
  container.insert(0, parts);
  return container;
}

/** Block specs as containers. An empty list becomes one empty paragraph, as the editor keeps. */
export function writeBlocks(specs: BlockSpec[]): Y.XmlElement[] {
  return (specs.length ? specs : [{ type: "paragraph" }]).map(containerOf);
}

/** The fragment's block group, made when the document is new. */
export function blockGroupOf(fragment: Y.XmlFragment): Y.XmlElement {
  const found = fragment.toArray().find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "blockGroup");
  if (found) return found;
  const group = new Y.XmlElement("blockGroup");
  fragment.insert(fragment.length, [group]);
  return group;
}

/** Fills an empty document from Markdown (a template, an agent's new page). */
export function seed(doc: Y.Doc, fragment: Y.XmlFragment, markdown: string): void {
  doc.transact(() => {
    const group = blockGroupOf(fragment);
    if (group.length) group.delete(0, group.length);
    group.insert(0, writeBlocks(parseMarkdown(markdown)));
  });
}
