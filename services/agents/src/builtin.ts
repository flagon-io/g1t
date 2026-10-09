/**
 * Making sure a workspace has its built-in @g1t (docs/WORKSPACE.md, "g1t,
 * the orchestrator"). Kept apart from the service so it is tested with a
 * stand-in database.
 */
import { newId } from "../../../packages/contracts/src/ids.ts";
import { builtinDefinition } from "./orchestrator.ts";
import { insertAgent, versionStatement } from "./store.ts";

/** Workspaces whose @g1t this isolate has seen made, so it is not written again. */
const ensured = new Set<string>();

/**
 * Makes the workspace's built-in @g1t if it does not exist yet: an
 * ordinary agent row, marked builtin, at version 1, with its first
 * version recorded. Safe to call on every request: the insert is ignored
 * when the workspace has one (one builtin per workspace, by index), and
 * once seen, an isolate does not write again.
 */
export async function ensureBuiltin(db: D1Database, workspaceId: string, memo: Set<string> = ensured): Promise<void> {
  if (!workspaceId || memo.has(workspaceId)) return;
  const definition = builtinDefinition();
  const id = newId("agt");
  const now = new Date().toISOString();
  // Ignored when the workspace has one already (one builtin per workspace, by index).
  const made = await insertAgent(db, id, workspaceId, definition, { version: 1, builtin: 1, created_by: "g1t", created_at: now, updated_at: now }, true).run();
  if (made.meta.changes) await versionStatement(db, id, 1, definition, "g1t", now).run();
  if (memo.size > 10_000) memo.clear();
  memo.add(workspaceId);
}
