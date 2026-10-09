/**
 * A chat message's Markdown, parsed into a small tree that React renders
 * as text (components/chat/text.tsx). Nothing in a message is ever HTML:
 * `<b>` is shown as typed, a link goes only to the web, mail or a page on
 * this site, and an image is shown as a link to it. Pure, so it is tested
 * on its own (chat-markdown.test.ts).
 *
 * The dialect is what people and agents write in chat: bold, italic,
 * strikethrough (`~~x~~` or `~x~`), inline and fenced code, links and bare
 * URLs, lists (nested by indenting), quotes, headings and rules, plus what
 * g1t adds: `@mentions`, `#channels` and `#123` references. A line break
 * is kept where it was typed.
 */

export type Span =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Span[] }
  | { t: "em"; c: Span[] }
  | { t: "del"; c: Span[] }
  | { t: "link"; href: string; c: Span[] }
  | { t: "mention"; name: string }
  | { t: "channel"; name: string }
  | { t: "ref"; repo: string | null; number: number };

export type Block =
  | { t: "p"; lines: Span[][] }
  | { t: "heading"; level: number; c: Span[] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

/** Where a link may go: the web, mail, or a page on this site. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  // Control characters and spaces never belong in a link someone can follow.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return null;
  if (/^https?:\/\/[^\s\\]+$/i.test(trimmed)) return trimmed;
  if (/^mailto:[^\s/\\]+$/i.test(trimmed)) return trimmed;
  // A path on this site; `//host` and `/\host` are other sites to a browser.
  if (/^\/(?![/\\])[^\s\\]*$/.test(trimmed)) return trimmed;
  return null;
}

/** The ASCII punctuation a backslash can escape. */
const ESCAPABLE = "\\\\`*_{}\\[\\]()#+\\-.!~>|<=:@";

const INLINE = new RegExp(
  [
    `\\\\([${ESCAPABLE}])`, // 1 an escaped character
    "``\\s?([^\\n]+?)\\s?``(?!`)", // 2 code with two backticks
    "`([^`\\n]+)`", // 3 code
    "\\*\\*([^*\\s](?:[^\\n]*?[^*\\s])?)\\*\\*", // 4 strong
    "(?<![\\w_])__([^_\\s](?:[^\\n]*?[^_\\s])?)__(?![\\w_])", // 5 strong with _
    "~~([^~\\n]+)~~", // 6 del
    "(?<![\\w~])~([^~\\s](?:[^~\\n]*[^~\\s])?)~(?![\\w~])", // 7 del with one ~
    "(?<![\\w*])\\*([^*\\s](?:[^*\\n]*[^*\\s])?)\\*(?![\\w*])", // 8 em with *
    "(?<![\\w_])_([^_\\s](?:[^_\\n]*[^_\\s])?)_(?![\\w_])", // 9 em with _
    "!\\[([^\\]\\n]{0,1000})\\]\\(<?([^)\\s>]{1,2048})>?(?:\\s+\"[^\"\\n]{0,1000}\")?\\)", // 10 alt, 11 src: an image, shown as a link
    "\\[([^\\]\\n]{1,1000})\\]\\(<?([^)\\s>]{1,2048})>?(?:\\s+\"[^\"\\n]{0,1000}\")?\\)", // 12 text, 13 href
    "<(https?:\\/\\/[^\\s<>]+|mailto:[^\\s<>]+)>", // 14 <autolink>
    "(https?:\\/\\/(?:[^\\s<>()]|\\([^\\s<>()]*\\))*(?:[^\\s<>().,;:!?'\"*_~]|\\([^\\s<>()]*\\)))", // 15 bare link
    "(?<![\\w/@])@([A-Za-z0-9][\\w.-]*[A-Za-z0-9_]|[A-Za-z0-9])(?:\\/([A-Za-z0-9][\\w.-]*))?", // 16 mention, 17 team
    "(?<![\\w/])([A-Za-z0-9][\\w.-]*(?:\\/[A-Za-z0-9][\\w.-]*)?)#(\\d+)\\b", // 18 repo, 19 number
    "(?<![\\w&#/])#(\\d+)\\b", // 20 number alone
    "(?<![\\w&#/])#([a-z0-9][a-z0-9_-]*)", // 21 channel
  ].join("|"),
  "g",
);

/** One line of text as spans. */
export function inline(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  const push = (span: Span) => {
    const last = spans[spans.length - 1];
    if (span.t === "text" && last?.t === "text") last.v += span.v;
    else spans.push(span);
  };
  const link = (href: string, inner: Span[], raw: string) => {
    const safe = safeHref(href);
    if (safe) push({ t: "link", href: safe, c: inner });
    else push({ t: "text", v: raw });
  };
  // Its own copy: the spans inside bold and the like are parsed on the way.
  const pattern = new RegExp(INLINE.source, "g");
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > at) push({ t: "text", v: text.slice(at, m.index) });
    at = m.index + m[0].length;
    if (m[1] != null) push({ t: "text", v: m[1] });
    else if (m[2] != null) push({ t: "code", v: m[2] });
    else if (m[3] != null) push({ t: "code", v: m[3] });
    else if (m[4] != null) push({ t: "strong", c: inline(m[4]) });
    else if (m[5] != null) push({ t: "strong", c: inline(m[5]) });
    else if (m[6] != null) push({ t: "del", c: inline(m[6]) });
    else if (m[7] != null) push({ t: "del", c: inline(m[7]) });
    else if (m[8] != null) push({ t: "em", c: inline(m[8]) });
    else if (m[9] != null) push({ t: "em", c: inline(m[9]) });
    else if (m[11] != null) link(m[11], [{ t: "text", v: m[10] || m[11] }], m[0]);
    else if (m[13] != null) link(m[13], plainSpans(inline(m[12]!)), m[0]);
    else if (m[14] != null) link(m[14], [{ t: "text", v: m[14] }], m[0]);
    else if (m[15] != null) push({ t: "link", href: m[15], c: [{ t: "text", v: m[15] }] });
    else if (m[16] != null) push({ t: "mention", name: m[17] ? `${m[16]}/${m[17]}` : m[16] });
    else if (m[18] != null) push({ t: "ref", repo: m[18], number: Number(m[19]) });
    else if (m[20] != null) push({ t: "ref", repo: null, number: Number(m[20]) });
    else if (m[21] != null) push({ t: "channel", name: m[21] });
  }
  if (at < text.length) push({ t: "text", v: text.slice(at) });
  return spans;
}

/** A link's text keeps its formatting, but never a link, mention or reference inside a link. */
function plainSpans(list: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of list.map(plainSpan)) {
    const last = out[out.length - 1];
    if (span.t === "text" && last?.t === "text") last.v += span.v;
    else out.push(span);
  }
  return out;
}

function plainSpan(span: Span): Span {
  switch (span.t) {
    case "link":
      return { t: "text", v: spansText(span.c) };
    case "mention":
      return { t: "text", v: `@${span.name}` };
    case "channel":
      return { t: "text", v: `#${span.name}` };
    case "ref":
      return { t: "text", v: `${span.repo ?? ""}#${span.number}` };
    case "strong":
    case "em":
    case "del":
      return { ...span, c: plainSpans(span.c) };
    default:
      return { ...span };
  }
}

// ---------------------------------------------------------------------------
// Blocks.

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
/** A heading has words after its `#`s: `#general` is a channel. */
const HEADED = /^ {0,3}#{1,6}[ \t]+\S/;
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** A line with up to `width` columns of its indent taken off. */
function dedent(line: string, width: number): string {
  let taken = 0;
  let i = 0;
  while (i < line.length && taken < width) {
    if (line[i] === " ") taken++;
    else if (line[i] === "\t") taken += 4 - (taken % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

/** Whether a line starts a block of its own, ending a paragraph. */
function startsBlock(line: string): boolean {
  if (FENCE.test(line) || HEADED.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  // A numbered list breaks into a paragraph only when it counts from 1.
  const item = ITEM.exec(line);
  return item != null && (!/\d/.test(item[2]!) || Number.parseInt(item[2]!, 10) === 1);
}

/** A paragraph's line without the marks of a hard break at its end. */
function lineText(line: string): string {
  return line.replace(/(?: {2,}|\\)$/, "").trim();
}

function parse(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let paragraph: Span[][] = [];
  const flush = () => {
    if (paragraph.length) out.push({ t: "p", lines: paragraph });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // A blank line ends a paragraph.
      flush();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const [, indent, marks] = fence;
      const close = new RegExp(`^ {0,3}${marks![0] === "`" ? "`" : "~"}{${marks!.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(dedent(lines[i++]!, indent!.length));
      i++; // the closing fence, or the end
      out.push({ t: "code", lang: fence[3] || null, v: body.join("\n") });
      continue;
    }
    const heading = HEADED.test(line) ? HEADING.exec(line) : null;
    if (heading) {
      flush();
      out.push({ t: "heading", level: heading[1]!.length, c: inline((heading[2] ?? "").trim()) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ t: "quote", c: depth < 8 ? parse(quoted, depth + 1) : [{ t: "p", lines: quoted.map((q) => inline(q)) }] });
      continue;
    }
    const item = ITEM.exec(line);
    if (item && depth < 8 && (paragraph.length === 0 || startsBlock(line))) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const base = indentOf(item[1]!);
      const items: Block[][] = [];
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      while (i < lines.length) {
        const head = ITEM.exec(lines[i]!);
        if (!head || /\d/.test(head[2]!) !== ordered || indentOf(head[1]!) > base + 1) break;
        // Where the item's text starts: what is indented that far belongs to it.
        const gap = head[3] ? Math.min(indentOf(head[3]), 4) : 1;
        const content = base + head[2]!.length + gap;
        const body = [head[4] ?? ""];
        i++;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === "") {
            // A blank line inside an item, if what follows is still indented under it.
            const after = lines.slice(i + 1).find((l) => l.trim() !== "");
            if (after != null && indentOf(after) > base && !(ITEM.test(after) && indentOf(after) <= base + 1)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) <= base) break;
          if (ITEM.test(next) && indentOf(next) <= base + 1) break;
          body.push(dedent(next, Math.min(indentOf(next), content)));
          i++;
        }
        items.push(parse(body, depth + 1));
        // Blank lines between items keep one list.
        let j = i;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        const following = j < lines.length ? ITEM.exec(lines[j]!) : null;
        if (j > i && following && /\d/.test(following[2]!) === ordered && indentOf(following[1]!) <= base + 1) i = j;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    if (paragraph.length && startsBlock(line)) flush();
    paragraph.push(inline(lineText(line)));
    i++;
  }
  flush();
  return out;
}

/** A message's whole text as blocks: paragraphs, headings, code, lists, quotes and rules. */
export function blocks(text: string): Block[] {
  return parse(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}

// ---------------------------------------------------------------------------
// Plain text.

/** Spans as the words they show. */
export function spansText(list: Span[]): string {
  return list
    .map((span) => {
      switch (span.t) {
        case "text":
        case "code":
          return span.v;
        case "strong":
        case "em":
        case "del":
        case "link":
          return spansText(span.c);
        case "mention":
          return `@${span.name}`;
        case "channel":
          return `#${span.name}`;
        case "ref":
          return `${span.repo ?? ""}#${span.number}`;
      }
    })
    .join("");
}

function blocksText(list: Block[]): string[] {
  const out: string[] = [];
  for (const block of list) {
    switch (block.t) {
      case "p":
        out.push(block.lines.map(spansText).join(" "));
        break;
      case "heading":
        out.push(spansText(block.c));
        break;
      case "code":
        out.push(block.v);
        break;
      case "list":
        block.items.forEach((item, index) => {
          const text = blocksText(item).join(" ");
          out.push(block.ordered ? `${block.start + index}. ${text}` : text);
        });
        break;
      case "quote":
        out.push(...blocksText(block.c));
        break;
      case "hr":
        break;
    }
  }
  return out.filter((line) => line.trim() !== "");
}

/**
 * A message as plain words on one line, for a preview: the Markdown's
 * marks gone, a link as its text, a mention as `@name`. Cut to `max`
 * characters with an ellipsis.
 */
export function plainText(markdown: string, max = Infinity): string {
  const text = blocksText(blocks(markdown)).join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
