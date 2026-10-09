/**
 * Docs mode's pure helpers: page trees, addresses, cursor colours, covers
 * and how search snippets mark their matches. No Workers or DOM imports,
 * so it is tested under Node.
 */
import type { DocRole, DocTreeNode } from "@g1t/contracts";

export type TreeItem = DocTreeNode & { children: TreeItem[]; depth: number };

/** A space's flat page list as a tree, each level in position order. */
export function buildTree(nodes: DocTreeNode[]): TreeItem[] {
  const byParent = new Map<string | null, DocTreeNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    // A page whose parent is gone (in the trash) shows at the top.
    const parent = node.parent_id && ids.has(node.parent_id) ? node.parent_id : null;
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): TreeItem[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .filter((n) => !seen.has(n.id) && seen.add(n.id))
      .map((n) => ({ ...n, depth, children: build(n.id, depth + 1) }));
  return build(null, 0);
}

/** Every page in a tree, depth first, as a move dialog lists them. */
export function flatten(tree: TreeItem[]): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (items: TreeItem[]) => {
    for (const item of items) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(tree);
  return out;
}

/** The ids on the way to `id` (its ancestors), so the sidebar opens them. */
export function pathTo(nodes: DocTreeNode[], id: string | null): string[] {
  if (!id) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let at = byId.get(id)?.parent_id ?? null;
  while (at && !out.includes(at)) {
    out.unshift(at);
    at = byId.get(at)?.parent_id ?? null;
  }
  return out;
}

/** The words of a title as an address: `release-plan`. */
export function titleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** A page's address, from its space and current title; the id at the end is what is read. */
export function pagePath(workspace: string, space: string, title: string, id: string): string {
  const words = titleSlug(title);
  return `/${workspace}/-/docs/${space}/${words ? `${words}-${id}` : id}`;
}

/** The page id at the end of a page's address segment. */
export function pageIdOf(segment: string | undefined): string | null {
  return /(pag_[0-9a-hjkmnp-tv-z]{26})$/.exec(segment ?? "")?.[1] ?? null;
}

/** A search snippet's parts: `[[word]]` marks a match. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let at = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > at) out.push({ text: snippet.slice(at, m.index), match: false });
    out.push({ text: m[1]!, match: true });
    at = m.index + m[0].length;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), match: false });
  return out;
}

/** Cursor colours: distinct, readable on the dark page. */
export const CURSOR_COLOURS = ["#b8a6ff", "#7dd3fc", "#86efac", "#fcd34d", "#fca5a5", "#f9a8d4", "#a5b4fc", "#5eead4", "#fdba74", "#c4b5fd"];

/** A person's cursor colour, stable for their name. */
export function cursorColour(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return CURSOR_COLOURS[Math.abs(hash) % CURSOR_COLOURS.length]!;
}

/** The covers a page can take without an upload. */
export const COVER_GRADIENTS = [
  "linear-gradient(120deg, #2a2340 0%, #4b3d7a 50%, #8f7ee0 100%)",
  "linear-gradient(120deg, #11222c 0%, #1f4b5c 55%, #4fb3c8 100%)",
  "linear-gradient(120deg, #1d1f17 0%, #3d4a24 55%, #a3c45a 100%)",
  "linear-gradient(120deg, #2b1a1a 0%, #5c2e2e 55%, #d9776a 100%)",
  "linear-gradient(120deg, #241a2b 0%, #5a2d5f 55%, #d27bd8 100%)",
  "linear-gradient(120deg, #1a1d2b 0%, #2c3466 55%, #7a8cf0 100%)",
];

/** A cover's CSS background: one of the gradients, or an image. */
export function coverStyle(cover: string | null | undefined): string | null {
  if (!cover) return null;
  const gradient = /^gradient:(\d{1,2})$/.exec(cover);
  if (gradient) return COVER_GRADIENTS[Number(gradient[1]) % COVER_GRADIENTS.length]!;
  if (/^https:\/\//.test(cover)) return `center / cover no-repeat url("${cover.replace(/["\\]/g, "")}")`;
  return null;
}

const RANK: Record<DocRole, number> = { view: 1, comment: 2, edit: 3, manage: 4 };

export function canDo(role: DocRole | null | undefined, need: DocRole): boolean {
  return !!role && RANK[role] >= RANK[need];
}

/** How many words a page has, and the minutes it takes to read. */
export function readingTime(markdown: string): { words: number; minutes: number } {
  const words = markdown.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, minutes: Math.max(1, Math.round(words / 230)) };
}

/** A Markdown file's name for a page. */
export function markdownFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Untitled"}.md`;
}
