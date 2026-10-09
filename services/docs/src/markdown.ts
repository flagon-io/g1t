/**
 * A page's Markdown, derived from its Yjs document: what search indexes,
 * agents read, export writes and the read view renders. Pure.
 *
 * The document is BlockNote's, as y-prosemirror stores it: the fragment
 * holds one `blockGroup` of `blockContainer`s (each with an `id`), each
 * holding one content node (`paragraph`, `heading`, `codeBlock`, ...) and,
 * for nested blocks, a `blockGroup` of children. Inline text is an
 * `XmlText` whose formatting attributes are the marks (`bold: {}`,
 * `link: { href }`, `comment--<hash>: {...}`); inline nodes (mentions,
 * dates) are `XmlElement`s between texts.
 *
 * g1t's own blocks (the editor's schema, apps/web components/docs):
 * `callout` (`kind`: info | warning | success | danger), `mermaid`
 * (`code`), `math` (`expression`), `embed` (`kind`, `title`, `url`), and
 * inline `mention` (`kind`: user | agent | page; `id`: a person's
 * username, an agent's id or a page's id; `name`; `href` for a page),
 * `date` (`date`) and `citation` (`repo`, `path`, `kind`, `label`, `ref`:
 * code the page cites, src/citations.ts).
 */
import type { DocCitation } from "@g1t/contracts";
import * as Y from "yjs";

import { citationMarkdown, cleanCitation } from "./citations.ts";

export type Outline = { id: string; type: string; level: number | null; markdown: string };

/** The callout kinds, as GitHub's alert names. */
export const CALLOUT_ALERTS: Record<string, string> = { info: "NOTE", warning: "WARNING", success: "TIP", danger: "CAUTION" };

/** The top-level blocks: the containers in the fragment's first block group. */
export function topContainers(fragment: Y.XmlFragment): Y.XmlElement[] {
  const group = fragment.toArray().find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "blockGroup");
  if (!group) return [];
  return group.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "blockContainer");
}

/** A container's content node and its children's group. */
export function partsOf(container: Y.XmlElement): { content: Y.XmlElement | null; children: Y.XmlElement[] } {
  let content: Y.XmlElement | null = null;
  let children: Y.XmlElement[] = [];
  for (const node of container.toArray()) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === "blockGroup") children = node.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === "blockContainer");
    else if (!content) content = node;
  }
  return { content, children };
}

type Delta = { insert: string | object; attributes?: Record<string, unknown> };

/** A text run with its marks applied, whitespace kept outside the markers. */
function marked(text: string, attrs: Record<string, unknown> | undefined): string {
  if (!attrs || !text) return text;
  const keys = Object.keys(attrs).map((k) => k.replace(/--[a-zA-Z0-9+/=]{8}$/, ""));
  if (attrs.code !== undefined && attrs.code !== null) {
    const ticks = text.includes("`") ? "``" : "`";
    return `${ticks}${text}${ticks}`;
  }
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  let core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  if (keys.includes("bold")) core = `**${core}**`;
  if (keys.includes("italic")) core = `_${core}_`;
  if (keys.includes("strike")) core = `~~${core}~~`;
  if (keys.includes("underline")) core = `<u>${core}</u>`;
  const link = attrs.link as { href?: string } | undefined;
  if (link?.href) core = `[${core}](${link.href})`;
  return lead + core + trail;
}

/** An inline node (mention, date) as text. */
function inlineNode(node: Y.XmlElement): string {
  const a = node.getAttributes() as Record<string, string | undefined>;
  if (node.nodeName === "mention") {
    if (a.kind === "page") return a.href ? `[${a.name || "Untitled"}](${a.href})` : `[[${a.name || "Untitled"}]]`;
    return `@${a.name ?? ""}`;
  }
  if (node.nodeName === "date") return a.date ?? "";
  if (node.nodeName === "citation") {
    const c = cleanCitation(a as Partial<DocCitation>, "body");
    return c ? citationMarkdown(c) : "";
  }
  // An unknown inline node: its text, if any.
  return node.toArray().map((c) => (c instanceof Y.XmlText ? c.toString() : "")).join("");
}

/** A content node's inline content as Markdown. */
export function inlineMarkdown(node: Y.XmlElement): string {
  let out = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const d of child.toDelta() as Delta[]) {
        if (typeof d.insert === "string") out += marked(d.insert, d.attributes);
      }
    } else if (child instanceof Y.XmlElement) {
      out += inlineNode(child);
    }
  }
  // Hard breaks inside a paragraph.
  return out.replace(/\n/g, "\\\n");
}

/** A content node's plain text. */
export function plainText(node: Y.XmlElement): string {
  let out = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) out += child.toString().replace(/<[^>]+>/g, "");
    else if (child instanceof Y.XmlElement) out += inlineNode(child).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  }
  return out;
}

function codeText(node: Y.XmlElement): string {
  return node
    .toArray()
    .map((c) => (c instanceof Y.XmlText ? (c.toDelta() as Delta[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("") : ""))
    .join("");
}

function fence(body: string, info: string): string {
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}${info}\n${body}\n${ticks}`;
}

function table(node: Y.XmlElement): string {
  const rows = node
    .toArray()
    .filter((r): r is Y.XmlElement => r instanceof Y.XmlElement && r.nodeName === "tableRow")
    .map((row) =>
      row
        .toArray()
        .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
        .map((cell) =>
          cell
            .toArray()
            .filter((p): p is Y.XmlElement => p instanceof Y.XmlElement)
            .map((p) => inlineMarkdown(p).replace(/\\\n/g, " "))
            .join(" ")
            .replace(/\|/g, "\\|"),
        ),
    );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

const LIST = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");
}

/**
 * One block (and its children) as Markdown. `number` is a numbered item's
 * place in its run of numbered items.
 */
export function blockMarkdown(container: Y.XmlElement, number = 1): string {
  const { content, children } = partsOf(container);
  if (!content) return "";
  const a = content.getAttributes() as Record<string, unknown>;
  const kids = () => blocksMarkdown(children);
  const nested = (prefix: string) => {
    const body = kids();
    return body ? `\n${indent(body, " ".repeat(prefix.length))}` : "";
  };
  switch (content.nodeName) {
    case "heading": {
      const level = Math.min(Math.max(Number(a.level) || 1, 1), 6);
      const own = `${"#".repeat(level)} ${inlineMarkdown(content)}`;
      const body = kids();
      return body ? `${own}\n\n${body}` : own;
    }
    case "bulletListItem":
      return `- ${inlineMarkdown(content)}${nested("- ")}`;
    case "numberedListItem": {
      const prefix = `${number}. `;
      return `${prefix}${inlineMarkdown(content)}${nested(prefix)}`;
    }
    case "checkListItem": {
      const checked = a.checked === true || a.checked === "true";
      return `- [${checked ? "x" : " "}] ${inlineMarkdown(content)}${nested("- ")}`;
    }
    case "toggleListItem": {
      const body = kids();
      return `<details>\n<summary>${inlineMarkdown(content)}</summary>\n${body ? `\n${body}\n` : ""}\n</details>`;
    }
    case "quote":
      return `${indent(inlineMarkdown(content), "> ").replace(/^$/gm, ">")}${children.length ? `\n\n${kids()}` : ""}`;
    case "callout": {
      const alert = CALLOUT_ALERTS[String(a.kind ?? "info")] ?? "NOTE";
      return `> [!${alert}]\n${indent(inlineMarkdown(content) || " ", "> ")}${children.length ? `\n\n${kids()}` : ""}`;
    }
    case "codeBlock":
      return fence(codeText(content), String(a.language ?? "") === "text" ? "" : String(a.language ?? ""));
    case "mermaid":
      return fence(String(a.code ?? ""), "mermaid");
    case "math":
      return `$$\n${String(a.expression ?? "")}\n$$`;
    case "divider":
      return "---";
    case "pageBreak":
      return "---";
    case "image": {
      const url = String(a.url ?? "");
      if (!url) return "";
      return `![${String(a.caption ?? a.name ?? "")}](${url})`;
    }
    case "video":
    case "audio":
    case "file": {
      const url = String(a.url ?? "");
      if (!url) return "";
      return `[${String(a.name || a.caption || url)}](${url})`;
    }
    case "embed": {
      const url = String(a.url ?? "");
      const title = String(a.title ?? "") || url;
      return url ? `[${title}](${url})` : title;
    }
    case "table":
      return table(content);
    case "paragraph":
    default: {
      const own = inlineMarkdown(content);
      const body = kids();
      if (!own) return body;
      return body ? `${own}\n\n${body}` : own;
    }
  }
}

/** Sibling blocks as Markdown: list items close together, other blocks a blank line apart. */
export function blocksMarkdown(containers: Y.XmlElement[]): string {
  const parts: string[] = [];
  let prevType: string | null = null;
  let number = 0;
  for (const container of containers) {
    const type = partsOf(container).content?.nodeName ?? "";
    number = type === "numberedListItem" ? (prevType === "numberedListItem" ? number + 1 : Number(partsOf(container).content?.getAttribute("start")) || 1) : 0;
    const text = blockMarkdown(container, number);
    if (text === "" && type === "paragraph") {
      prevType = type;
      continue;
    }
    // One list: items of the same kind (bullets and to-dos mix), close together.
    const family = (t: string) => (t === "numberedListItem" ? "numbered" : "bullet");
    const tight = prevType !== null && LIST.has(type) && LIST.has(prevType) && family(type) === family(prevType);
    parts.push((parts.length ? (tight ? "\n" : "\n\n") : "") + text);
    prevType = type;
  }
  return parts.join("");
}

/** The whole document as Markdown. */
export function documentMarkdown(fragment: Y.XmlFragment): string {
  const text = blocksMarkdown(topContainers(fragment)).trim();
  return text ? `${text}\n` : "";
}

/** The top-level blocks, as agents see them. */
export function outline(fragment: Y.XmlFragment): Outline[] {
  const out: Outline[] = [];
  const tops = topContainers(fragment);
  let number = 0;
  let prev: string | null = null;
  for (const container of tops) {
    const content = partsOf(container).content;
    const type = content?.nodeName ?? "paragraph";
    number = type === "numberedListItem" ? (prev === "numberedListItem" ? number + 1 : 1) : 0;
    prev = type;
    out.push({
      id: String(container.getAttribute("id") ?? ""),
      type,
      level: type === "heading" ? Number(content?.getAttribute("level")) || 1 : null,
      markdown: blockMarkdown(container, number),
    });
  }
  return out;
}

/** Plain text for search: Markdown without its markup. */
export function searchText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n/g, "")
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(details|summary|u)>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ x]\]\s+)?/gm, "")
    .replace(/\[!(NOTE|WARNING|TIP|CAUTION|IMPORTANT)\]/g, "")
    .replace(/[*_~`|]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** The first words of a page, for cards. */
export function excerpt(markdown: string, max = 180): string {
  const text = searchText(markdown).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The people (usernames, lowercased) and agents (agent ids) a document mentions. */
export function mentionedIds(fragment: Y.XmlFragment): { users: string[]; agents: string[] } {
  const users = new Set<string>();
  const agents = new Set<string>();
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "mention") {
        const kind = child.getAttribute("kind");
        const id = String(child.getAttribute("id") ?? "");
        if (kind === "user" && id) users.add(id.toLowerCase());
        if (kind === "agent" && id) agents.add(id);
      } else walk(child);
    }
  };
  walk(fragment);
  return { users: [...users], agents: [...agents] };
}

/** The citation chips in a document, as their attributes say (src/citations.ts cleans them). */
export function citationNodes(fragment: Y.XmlFragment): Partial<DocCitation>[] {
  const out: Partial<DocCitation>[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "citation") out.push(child.getAttributes() as Partial<DocCitation>);
      else walk(child);
    }
  };
  walk(fragment);
  return out;
}
