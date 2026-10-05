/**
 * Who may read what in the context hub. A workspace is the boundary: no
 * search ever reads another's rows. Inside it, members (and the workspace's
 * own agents, whose token makes them members of it and nothing else) read
 * everything; anyone else reads only what comes from public projects, and
 * never memory. Pure, so the rules are tested apart from the index.
 */

import type { SearchHit, SearchKind } from "@g1t/contracts";

export type Reader = {
  workspace: string;
  member: boolean;
  /** For someone who is not a member: the slugs of the projects they may see. */
  visible: Set<string>;
};

/** The metadata every row of the search index carries. */
export type IndexMeta = {
  workspace: string;
  kind: string;
  project: string;
  private: boolean;
  title: string;
  snippet: string;
  url: string;
  source: string;
  by: string;
  at: string;
};

/** The search index's filter for a reader: their workspace always, public rows unless a member. */
export function indexFilter(
  reader: Reader,
  options: { project?: string | null; kinds?: SearchKind[] | null },
): Record<string, unknown> {
  const filter: Record<string, unknown> = { workspace: reader.workspace };
  if (!reader.member) filter.private = false;
  if (options.project) filter.project = options.project;
  const kinds = allowedKinds(reader, options.kinds);
  if (kinds) filter.kind = { $in: kinds };
  return filter;
}

/** The kinds a reader may ask for: all of them, less memory for someone not a member. Null for all. */
export function allowedKinds(reader: Reader, kinds?: SearchKind[] | null): SearchKind[] | null {
  const wanted = kinds?.length ? kinds : null;
  if (reader.member) return wanted;
  const all: SearchKind[] = ["project", "app", "api", "package", "language", "owner", "environment", "integration", "doc", "issue", "pull"];
  return (wanted ?? all).filter((kind) => kind !== "memory");
}

/** Whether a row from the index may be shown to a reader: checked again, whatever the filter did. */
export function readable(meta: Pick<IndexMeta, "workspace" | "kind" | "project" | "private">, reader: Reader): boolean {
  if (meta.workspace !== reader.workspace) return false;
  if (reader.member) return true;
  if (meta.kind === "memory" || meta.private) return false;
  // A project made private since it was indexed is hidden at once.
  return !meta.project || reader.visible.has(meta.project);
}

/** Semantic hits first, then text matches not already among them, at most `limit`. */
export function merge(semantic: SearchHit[], text: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of [...semantic.sort((a, b) => b.score - a.score), ...text]) {
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
