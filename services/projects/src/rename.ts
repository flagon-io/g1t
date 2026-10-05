/**
 * A workspace renamed: its projects move to the slug it has now. Each
 * statement takes the current slug and one stale slug, and changes nothing
 * once the rows have moved, so a repeated or late delivery is harmless.
 */

export type Statement = { sql: string; params: string[] };

export function renameStatements(stale: string[], current: string): Statement[] {
  return stale.flatMap((old) => [
    // A project of the same slug made under the new name in the moment
    // before this ran keeps its place; the older one stays put and is
    // reported.
    { sql: "UPDATE OR IGNORE projects SET workspace = ? WHERE workspace = ?", params: [current, old] },
    { sql: "UPDATE projects SET repo_namespace = ? WHERE repo_namespace = ?", params: [current, old] },
    { sql: "UPDATE OR IGNORE backfilled SET workspace = ? WHERE workspace = ?", params: [current, old] },
    { sql: "DELETE FROM backfilled WHERE workspace = ?", params: [old] },
  ]);
}
