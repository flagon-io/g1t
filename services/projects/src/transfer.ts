/**
 * A repository moved: transferred to another workspace, or renamed within
 * its own. Its projects go with it.
 *
 * A project lives in the workspace its repository is in, so each of the
 * repository's projects under a stale path's workspace moves to the
 * workspace the repository is in now, keeping its id (deployments,
 * secrets and the rest are keyed by it) and its slug. Projects elsewhere
 * that build from the repository only learn its new path. Dependencies are
 * within a workspace, so those between a moved project and one that stayed
 * behind are dropped.
 *
 * Renamed, the repository's own project (its primary one, named after it)
 * takes the new name as its slug, so its pages at `/<workspace>/<name>`
 * follow, unless the workspace already has a project of that slug; it
 * keeps its old slug then. Its display name follows when it was still the
 * repository's old name.
 *
 * Each statement changes nothing once the rows have moved, so a repeated
 * or late delivery is harmless.
 */

import type { Statement } from "./rename";

/** A name as an address: lowercase letters, digits, `-`, `_` and `.`. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

/** `stale` and `current` are `namespace/name` paths. */
export function moveStatements(stale: string[], current: string, repoId: string): Statement[] {
  const [workspace, name] = current.split("/") as [string, string];
  const moves = [...new Set(stale.map((path) => path.split("/")[0]!))]
    .filter((from) => from !== workspace)
    .map((from) => ({
      // A project of the same slug already in the destination keeps it; the
      // moving one is given a free slug afterwards (see `strandedQuery`).
      sql: "UPDATE OR IGNORE projects SET workspace = ?, repo_namespace = ? WHERE repo_id = ? AND workspace = ?",
      params: [workspace, workspace, repoId, from],
    }));
  const renames = [...new Set(stale.map((path) => path.split("/")[1]!))]
    .filter((old) => old !== name)
    .flatMap((old) => {
      const statements: Statement[] = [];
      const [from, to] = [slugOf(old), slugOf(name)];
      if (from && to && from !== to) {
        // Ignored when the workspace already has a project called `to`.
        statements.push({
          sql: "UPDATE OR IGNORE projects SET slug = ? WHERE repo_id = ? AND is_primary = 1 AND workspace = ? AND slug = ?",
          params: [to, repoId, workspace, from],
        });
      }
      statements.push({
        sql: "UPDATE projects SET name = ? WHERE repo_id = ? AND is_primary = 1 AND name = ?",
        params: [name, repoId, old],
      });
      return statements;
    });
  return [
    ...moves,
    ...renames,
    {
      sql: "UPDATE projects SET repo_namespace = ?, repo_name = ? WHERE repo_id = ?",
      params: [workspace, name, repoId],
    },
    {
      sql: `DELETE FROM dependencies
            WHERE (project_id IN (SELECT id FROM projects WHERE repo_id = ?)
                   AND depends_on_id IN (SELECT id FROM projects WHERE workspace <> ?))
               OR (depends_on_id IN (SELECT id FROM projects WHERE repo_id = ?)
                   AND project_id IN (SELECT id FROM projects WHERE workspace <> ?))`,
      params: [repoId, workspace, repoId, workspace],
    },
  ];
}

/**
 * The repository's projects still under a stale workspace after the moves:
 * those whose slug the destination already had. Null for a rename within
 * the workspace, which moves no project between workspaces.
 */
export function strandedQuery(stale: string[], current: string, repoId: string): Statement | null {
  const workspace = current.split("/")[0]!;
  const from = [...new Set(stale.map((path) => path.split("/")[0]!))].filter((ns) => ns !== workspace);
  if (from.length === 0) return null;
  return {
    sql: `SELECT * FROM projects WHERE repo_id = ? AND workspace IN (${from.map(() => "?").join(", ")})`,
    params: [repoId, ...from],
  };
}
