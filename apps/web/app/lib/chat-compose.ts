/**
 * The chat composer's document and the Markdown a message is stored as,
 * each turned into the other. The composer (components/chat/editor.tsx)
 * edits a small rich-text document; what it sends, keeps as a draft and
 * edits again is Markdown, the same text the API, agents and notifications
 * read. Pure, on the editor's JSON, so it is tested without a browser
 * (chat-compose.test.ts).
 *
 * In the document each paragraph is one line of the message: Shift+Enter
 * starts a new one, an empty one is a blank line.
 */
import { type Block, type Span, blocks } from "@g1t/contracts/chat-markdown";

/** The editor's JSON, as much of it as is read here. */
export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

type Mark = { type: string; attrs?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Markdown to the document.

function textNode(text: string, marks: Mark[]): DocNode | null {
  if (!text) return null;
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

function spanNodes(list: Span[], marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = [];
  const add = (node: DocNode | null) => node && out.push(node);
  for (const span of list) {
    switch (span.t) {
      case "text":
        add(textNode(span.v, marks));
        break;
      case "code":
        add(textNode(span.v, [...marks, { type: "code" }]));
        break;
      case "strong":
        out.push(...spanNodes(span.c, [...marks, { type: "bold" }]));
        break;
      case "em":
        out.push(...spanNodes(span.c, [...marks, { type: "italic" }]));
        break;
      case "del":
        out.push(...spanNodes(span.c, [...marks, { type: "strike" }]));
        break;
      case "link":
        out.push(...spanNodes(span.c, [{ type: "link", attrs: { href: span.href } }, ...marks]));
        break;
      case "mention":
        add(textNode(`@${span.name}`, marks));
        break;
      case "channel":
        add(textNode(`#${span.name}`, marks));
        break;
      case "ref":
        add(textNode(`${span.repo ?? ""}#${span.number}`, marks));
        break;
    }
  }
  return out;
}

function paragraph(spans: Span[]): DocNode {
  const content = spanNodes(spans);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function blockNodes(list: Block[]): DocNode[] {
  const out: DocNode[] = [];
  list.forEach((block, index) => {
    // Paragraphs one after another were apart by a blank line: an empty line between them.
    if (block.t === "p" && index > 0 && list[index - 1]!.t === "p") out.push({ type: "paragraph" });
    switch (block.t) {
      case "p":
        for (const line of block.lines) out.push(paragraph(line));
        break;
      case "heading":
        // Chat has no headings to write; one comes back as a bold line.
        out.push(paragraph([{ t: "strong", c: block.c }]));
        break;
      case "hr":
        break;
      case "table": {
        // The composer has no tables: each row comes back as the line it was written as.
        const row = (cells: Span[][]): Span[] => [{ t: "text", v: "| " }, ...cells.flatMap((cell, at) => [...(at ? [{ t: "text" as const, v: " | " }] : []), ...cell]), { t: "text", v: " |" }];
        const rule = block.align.map((align) => (align === "center" ? ":-:" : align === "right" ? "--:" : align === "left" ? ":--" : "---"));
        out.push(paragraph(row(block.head)), paragraph([{ t: "text", v: `| ${rule.join(" | ")} |` }]), ...block.rows.map((cells) => paragraph(row(cells))));
        break;
      }
      case "code":
        out.push({ type: "codeBlock", attrs: { language: block.lang }, ...(block.v ? { content: [{ type: "text", text: block.v }] } : {}) });
        break;
      case "quote": {
        const content = blockNodes(block.c);
        out.push({ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] });
        break;
      }
      case "list":
        out.push({
          type: block.ordered ? "orderedList" : "bulletList",
          ...(block.ordered ? { attrs: { start: block.start } } : {}),
          content: block.items.map((item) => {
            const content = blockNodes(item);
            // An item starts with a line of text.
            if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" });
            return { type: "listItem", content };
          }),
        });
        break;
    }
  });
  return out;
}

/** A message's Markdown as the composer's document. */
export function markdownToDoc(markdown: string): DocNode {
  const content = blockNodes(blocks(markdown));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

// ---------------------------------------------------------------------------
// The document to Markdown.

/** Marks from the outside in: a link holds bold, bold holds code. */
const ORDER = ["link", "bold", "italic", "strike", "code"];
const OPEN: Record<string, string> = { bold: "**", italic: "_", strike: "~~" };

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);
}

/** Text as Markdown shows it as typed: its marks escaped. */
export function escapeText(text: string): string {
  return text
    .replace(/\\(?=[\\`*_{}[\]()#+\-.!~>|<=:@])/g, "\\\\")
    .replace(/[`*~[\]]/g, (char) => `\\${char}`)
    .replace(/_/g, (char, at: number, all: string) => {
      // `snake_case` stays as typed: only an `_` at a word's edge could start or end italics.
      const before = all[at - 1] ?? "";
      const after = all[at + 1] ?? "";
      return /\w/.test(before) && /\w/.test(after) ? char : `\\${char}`;
    });
}

/** A line that would read as a block's start (`# `, `- `, `1. `, `> `, `---`) when it is only text. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}(?:\s|$))/, "$1\\$2")
    .replace(/^(\s*)([-+](?:\s|$))/, "$1\\$2")
    .replace(/^(\s*)(\d{1,9})([.)])(\s|$)/, "$1$2\\$3$4")
    .replace(/^(\s*)(>)/, "$1\\$2")
    .replace(/^(\s*)([-_=]{3,}\s*)$/, "$1\\$2")
    .replace(/^(\s*)•/, "$1\\•");
}

function codeSpan(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  return `\`\` ${text} \`\``;
}

function linkTarget(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>\s]/g, encodeURIComponent)}>` : href;
}

/** A line of inline content (text with marks) as Markdown. */
function inlineMarkdown(nodes: DocNode[]): string {
  let out = "";
  const open: { mark: Mark; text: string }[] = [];
  // A link's text is gathered so a bare URL can be written bare.
  const close = (count: number) => {
    for (let n = 0; n < count; n++) {
      const top = open.pop()!;
      // Spaces at a mark's end go after its closing mark: `**a **` would not be bold.
      const body = top.text;
      const trailing = /\s*$/.exec(body)![0];
      const inner = body.slice(0, body.length - trailing.length);
      let written: string;
      if (top.mark.type === "link") {
        const href = String(top.mark.attrs?.href ?? "");
        written = inner === escapeText(href) && /^https?:\/\//i.test(href) && !/[\s()<>]/.test(href) ? href : `[${inner}](${linkTarget(href)})`;
      } else if (!inner) {
        written = "";
      } else {
        const delimiter = OPEN[top.mark.type] ?? "";
        written = `${delimiter}${inner}${delimiter}`;
      }
      append(written + trailing);
    }
  };
  const append = (text: string) => {
    if (open.length) open[open.length - 1]!.text += text;
    else out += text;
  };
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      close(open.length);
      out += "\n";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = [...(node.marks ?? [])]
      .filter((mark) => ORDER.includes(mark.type))
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    // Close what this text no longer has, and everything opened after it.
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!.mark, marks[keep]!)) keep++;
    close(open.length - keep);
    const code = marks.some((mark) => mark.type === "code");
    let text = node.text;
    // Spaces before a mark's start go before it: `** a**` would not be bold.
    const opening = marks.slice(keep).filter((mark) => mark.type !== "code");
    if (opening.length) {
      const leading = /^\s*/.exec(text)![0];
      append(leading);
      text = text.slice(leading.length);
    }
    for (const mark of marks.slice(keep)) if (mark.type !== "code") open.push({ mark, text: "" });
    append(code ? codeSpan(text) : escapeText(text));
  }
  close(open.length);
  return out;
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join("\n");
}

function blockMarkdown(node: DocNode): string | null {
  switch (node.type) {
    case "paragraph": {
      const line = inlineMarkdown(node.content ?? []);
      return line
        .split("\n")
        .map((part) => escapeLineStart(part))
        .join("\n");
    }
    case "codeBlock": {
      const text = (node.content ?? []).map((child) => child.text ?? "").join("");
      const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longest + 1);
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case "blockquote": {
      const inner = blocksMarkdown(node.content ?? []);
      return inner
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const start = ordered ? Number(node.attrs?.start ?? 1) || 1 : 1;
      return (node.content ?? [])
        .map((item, index) => {
          const marker = ordered ? `${start + index}. ` : "- ";
          const inner = blocksMarkdown(item.content ?? [], true);
          return prefixLines(inner, marker, " ".repeat(marker.length));
        })
        .join("\n");
    }
    default:
      return null;
  }
}

function blocksMarkdown(nodes: DocNode[], tight = false): string {
  let out = "";
  let previous: string | null = null;
  for (const node of nodes) {
    const text = blockMarkdown(node);
    if (text == null) continue;
    if (previous != null) {
      // A line follows a line, and in a list item everything does; anything else stands apart by a blank line.
      out += tight || (previous === "paragraph" && node.type === "paragraph") ? "\n" : "\n\n";
    }
    out += text;
    previous = node.type;
  }
  return out;
}

/** The composer's document as the Markdown a message is sent as. */
export function docToMarkdown(doc: DocNode): string {
  return blocksMarkdown(doc.content ?? [])
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}
