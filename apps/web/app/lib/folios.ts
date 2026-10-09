/**
 * Artifacts mode's pure helpers (code says "folio", people see
 * "artifact"; docs/ARTIFACTS_MODE.md): sidebar trees, the home list's
 * days, cursor colours, covers, roles, how search snippets mark their
 * matches, and projects' docs folders. No Workers or DOM imports, so it is
 * tested under Node.
 */
import type { DocRole, FolioKind, FolioListQuery, FolioTreeNode } from "@g1t/contracts";

const KINDS: readonly string[] = ["doc", "slides", "design", "dashboard"];

/**
 * The home list's query, from an address's search
 * (`?tab=&kind=&space=&owner=&project=&q=&cursor=`). `owner` is passed
 * through as written: Home turns a username into a member key.
 */
export function listQuery(q: URLSearchParams): FolioListQuery {
  const tab = q.get("tab");
  const kind = q.get("kind") ?? "";
  return {
    tab: tab === "yours" || tab === "shared" ? tab : "all",
    kinds: KINDS.includes(kind) ? [kind as FolioKind] : null,
    space_id: q.get("space") || null,
    owner: q.get("owner") || null,
    project: q.get("project") || null,
    q: q.get("q")?.trim() || null,
    cursor: q.get("cursor") || null,
    limit: 30,
  };
}

export type TreeItem = FolioTreeNode & { children: TreeItem[]; depth: number };

type TreeNode = Pick<FolioTreeNode, "id" | "parent_id" | "position">;

/** A flat list of folios as a tree, each level in position order. */
export function buildTree(nodes: FolioTreeNode[]): TreeItem[] {
  const byParent = new Map<string | null, FolioTreeNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    // One whose parent isn't in the list (in the trash, or not readable) shows at the top.
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

/** Every folio in a tree, depth first, as a move dialog lists them. */
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
export function pathTo(nodes: TreeNode[], id: string | null): string[] {
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

/** A day of the home list: Today, Yesterday, then `Oct 7`, with the year when it isn't this year. */
export type DayGroup<T> = { key: string; label: string; items: T[] };

/** The calendar day of `at` in `zone`, as `YYYY-MM-DD`. */
export function dayKey(at: string | number | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Items grouped by the day `at` gives each, in `zone` (the viewer's), in
 * the order they come: lists arrive newest first, so the days do too.
 */
export function dayGroups<T>(items: readonly T[], at: (item: T) => string, zone: string, now: Date = new Date()): DayGroup<T>[] {
  const today = dayKey(now, zone);
  const yesterday = dayKey(now.getTime() - 86_400_000, zone);
  const year = today.slice(0, 4);
  const out: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(at(item), zone);
    let group = out.find((g) => g.key === key);
    if (!group) {
      const [y, m, d] = key.split("-").map(Number) as [number, number, number];
      // Noon UTC names the same calendar day in any zone's words.
      const date = new Date(Date.UTC(y, m - 1, d, 12));
      const label =
        key === today
          ? "Today"
          : key === yesterday
            ? "Yesterday"
            : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(key.slice(0, 4) === year ? {} : { year: "numeric" }) }).format(date);
      group = { key, label, items: [] };
      out.push(group);
    }
    group.items.push(item);
  }
  return out;
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

/** The covers a doc can take without an upload. */
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

/** How many words a doc has, and the minutes it takes to read. */
export function readingTime(markdown: string): { words: number; minutes: number } {
  const words = markdown.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, minutes: Math.max(1, Math.round(words / 230)) };
}

/**
 * Where a citation links: the file or folder in Code at the commit it was
 * cited at, or the default branch (`HEAD`). A glob links to the folder it
 * starts from. Mirrors `citationHref` in services/docs src/citations.ts.
 */
export function citationHref(c: { repo: string; path: string; ref: string | null }): string {
  const parts = c.path.split("/").filter(Boolean);
  const globAt = parts.findIndex((p) => /[*?]/.test(p));
  const glob = globAt >= 0;
  const shown = (glob ? parts.slice(0, globAt) : parts).map(encodeURIComponent).join("/");
  const kind = glob || !/\.[A-Za-z0-9]{1,10}$/.test(c.path) ? "tree" : "blob";
  return `/${c.repo}/${kind}/${encodeURIComponent(c.ref || "HEAD")}${shown ? `/${shown}` : ""}`;
}

/** A project's docs file's address in Artifacts. */
export function repoFilePath(workspace: string, repo: string, path: string): string {
  return `/${workspace}/-/artifacts/repo/${repo}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A space's address in Artifacts. */
export function spacePath(workspace: string, space: string): string {
  return `/${workspace}/-/artifacts/spaces/${space}`;
}

/** A folder of a project's docs, as the sidebar shows it: files, then folders, each by name. */
export type RepoFolder = { name: string; path: string; files: { path: string; title: string }[]; folders: RepoFolder[] };

/** A project's docs files as folders: README and `docs/` at the top, `docs/a/b.md` under `a`. */
export function repoFolders(files: { path: string; title: string }[]): RepoFolder {
  const root: RepoFolder = { name: "", path: "", files: [], folders: [] };
  for (const file of files) {
    // `docs/` is the space itself: its files sit at the top beside the README.
    const parts = file.path.replace(/^docs\//i, "").split("/");
    parts.pop();
    let at = root;
    for (const part of parts) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: at.path ? `${at.path}/${part}` : part, files: [], folders: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.files.push(file);
  }
  const sort = (f: RepoFolder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The artifact ids a chat message links to in this workspace, in order, once each. */
export function linkedArtifacts(body: string, workspace: string): string[] {
  const out: string[] = [];
  const re = /\/([A-Za-z0-9_.-]+)\/-\/artifacts\/(?:[a-z0-9-]*-)?(fol_[0-9a-hjkmnp-tv-z]{26})(?![0-9a-z])/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1]!.toLowerCase() === workspace.toLowerCase() && !out.includes(m[2]!)) out.push(m[2]!);
  }
  return out;
}
