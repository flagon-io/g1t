/**
 * Who may read what in the context hub. A workspace is the boundary: no
 * search ever reads another's rows. Inside it, someone who can read every
 * repository (an owner, a member while the workspace's base permission is
 * Read or more, and the workspace's own agents) reads everything; anyone
 * else reads what comes from the projects whose repositories they can read:
 * public ones, and private ones granted to them. Memory is for members.
 * Pure, so the rules are tested apart from the index.
 */

import type { EntityKind, RepoPath, SearchHit, SearchKind } from "@g1t/contracts";

export type Reader = {
  workspace: string;
  /** Belongs to the workspace: reads its memory. */
  member: boolean;
  /** Can read every repository in the workspace. */
  full: boolean;
  /** For someone who cannot read every repository: the slugs of the projects they may see. */
  visible: Set<string>;
  /** Whether any of `visible` is private: the index is then not narrowed to public rows. */
  privateVisible?: boolean;
  /** For someone who cannot read every repository: the `namespace/name` of those they can, lowercased. */
  repos?: Set<string>;
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

/**
 * The search index's filter for a reader: their workspace always; public
 * rows only for someone who may read nothing private there (memory is
 * private, so not for a member). `readable` checks each row again.
 */
export function indexFilter(
  reader: Reader,
  options: { project?: string | null; kinds?: SearchKind[] | null },
): Record<string, unknown> {
  const filter: Record<string, unknown> = { workspace: reader.workspace };
  if (!reader.full && !reader.member && !reader.privateVisible) filter.private = false;
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
  if (reader.full) return true;
  if (meta.kind === "memory") {
    if (!reader.member) return false;
    // Workspace memory is for every member; a project's, for those who can read it.
    return !meta.project || reader.visible.has(meta.project);
  }
  // A private row needs its project readable: one with none is hidden.
  if (meta.private) return !!meta.project && reader.visible.has(meta.project);
  // A project made private since it was indexed is hidden at once.
  return !meta.project || reader.visible.has(meta.project);
}

/** Whether a memory may be shown to a reader: a member's, and a project's only to those who can read its repository. */
export function memoryReadable(repo: RepoPath | null | undefined, reader: Reader): boolean {
  if (!reader.member) return false;
  if (reader.full || !repo) return true;
  return !!reader.repos?.has(`${repo.namespace}/${repo.name}`.toLowerCase());
}

/**
 * Whether a memory may go into the prompt of an agent run acting for
 * someone. `reader` is theirs; null is the workspace's own step, which is
 * told everything. A member is told what they could read themselves; anyone
 * else (an outside collaborator) only the memory of the repository the run
 * is in, `repo` (`namespace/name`), never the workspace's.
 */
export function runMemoryReadable(
  memory: { scope?: string | null; repo?: RepoPath | null },
  reader: Reader | null,
  repo: string,
): boolean {
  if (!reader) return true;
  if (reader.member) return memoryReadable(memory.repo, reader);
  return memory.scope !== "workspace" && !!memory.repo && `${memory.repo.namespace}/${memory.repo.name}`.toLowerCase() === repo.toLowerCase();
}

/**
 * Entity counts by kind over the rows a reader may see, from rows grouped by
 * kind, project and privacy.
 */
export function countVisible<K extends string>(
  rows: { kind: K; project: string | null; private: number; n: number }[],
  reader: Reader,
): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const row of rows) {
    if (!readable({ workspace: reader.workspace, kind: "entity", project: row.project ?? "", private: !!row.private }, reader)) continue;
    counts[row.kind] = (counts[row.kind] ?? 0) + row.n;
  }
  return counts;
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
