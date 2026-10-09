/**
 * The page tree: order within a parent, moving, and the paths a space's
 * export uses. Pure.
 *
 * Order is a number per page (`position`), compared within one parent. A
 * page moved between two others takes the midpoint, so a move writes one
 * row; when two neighbours get too close, the parent's children are
 * renumbered.
 */

export type TreeRow = { id: string; parent_id: string | null; position: number };

/** The gap between consecutive positions after renumbering. */
export const STEP = 1024;
/** Below this gap, midpoints lose precision: renumber instead. */
const MIN_GAP = 1e-6;

/** The children of `parent`, in order. */
export function childrenOf<T extends TreeRow>(rows: T[], parent: string | null): T[] {
  return rows.filter((r) => r.parent_id === parent).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** A position at the end of `parent`'s children. */
export function lastPosition(rows: TreeRow[], parent: string | null): number {
  const kids = childrenOf(rows, parent);
  return kids.length ? kids[kids.length - 1]!.position + STEP : STEP;
}

/**
 * Where `id` goes to sit under `parent` before `beforeId` (null: at the
 * end): its new position, and any siblings that had to be renumbered to
 * make room (`renumber`), as id → position.
 */
export function placeBefore(
  rows: TreeRow[],
  id: string,
  parent: string | null,
  beforeId: string | null,
): { position: number; renumber: Map<string, number> } {
  const siblings = childrenOf(rows, parent).filter((r) => r.id !== id);
  const at = beforeId ? siblings.findIndex((r) => r.id === beforeId) : -1;
  if (at < 0) {
    const last = siblings[siblings.length - 1];
    return { position: last ? last.position + STEP : STEP, renumber: new Map() };
  }
  const next = siblings[at]!.position;
  const prev = at > 0 ? siblings[at - 1]!.position : next - 2 * STEP;
  if (next - prev > MIN_GAP * 2) return { position: (prev + next) / 2, renumber: new Map() };
  // Too close: renumber every sibling, leaving a slot before `beforeId`.
  const renumber = new Map<string, number>();
  let position = 0;
  let mine = 0;
  for (let i = 0; i < siblings.length; i++) {
    if (i === at) {
      position += STEP;
      mine = position;
    }
    position += STEP;
    renumber.set(siblings[i]!.id, position);
  }
  return { position: mine, renumber };
}

/** Whether making `parent` the parent of `id` would put a page under itself. */
export function wouldCycle(rows: TreeRow[], id: string, parent: string | null): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let at = parent;
  const seen = new Set<string>();
  while (at) {
    if (at === id) return true;
    if (seen.has(at)) return true;
    seen.add(at);
    at = byId.get(at)?.parent_id ?? null;
  }
  return false;
}

/** `id` and every page under it. */
export function descendants(rows: TreeRow[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const r of rows) if (r.parent_id === out[i]) out.push(r.id);
  }
  return out;
}

/** A page's ancestors, root first (not the page itself). */
export function ancestors<T extends TreeRow>(rows: T[], id: string): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  const seen = new Set<string>([id]);
  let at = byId.get(id)?.parent_id ?? null;
  while (at && !seen.has(at)) {
    seen.add(at);
    const row = byId.get(at);
    if (!row) break;
    out.unshift(row);
    at = row.parent_id;
  }
  return out;
}

/**
 * Paths for a space's export: each page at `<title>.md`, and a page with
 * children also as a folder of the same name holding them. Names are made
 * safe for file systems and unique among siblings.
 */
export function exportPaths<T extends TreeRow & { title: string }>(rows: T[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (parent: string | null, dir: string) => {
    const used = new Set<string>();
    for (const row of childrenOf(rows, parent)) {
      const base = fileName(row.title);
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      used.add(name.toLowerCase());
      out.set(row.id, `${dir}${name}.md`);
      walk(row.id, `${dir}${name}/`);
    }
  };
  walk(null, "");
  return out;
}

/** A title as a file name: no path separators or characters file systems refuse. */
export function fileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
  return name || "Untitled";
}
