/**
 * Extensions installed in a workspace (docs.g1t.sh/guides/marketplace/):
 * the version an install keeps, its plan, who installed it, whether it is
 * switched on (the kill switch), and its monthly spend cap. Kept in
 * `extension_installs`; one live install per workspace and extension.
 *
 * Only a published listing installs: one whose manifest is `available`,
 * with a source and a version. The catalog of manifests is passed in
 * (`Catalog`): today g1t's own (@g1t/contracts FIRST_PARTY_EXTENSIONS),
 * later every published listing. Who may do what, the audit log and
 * telling people are index.ts's; this file is the rules and the table,
 * tested on SQLite.
 */
import type { ExtensionInstall, ExtensionManifest, FailureCode, Result } from "@g1t/contracts";
import { FREE_PLAN, listingRef, parseListing } from "@g1t/contracts/marketplace";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** Finds an extension's manifest by id. */
export type Catalog = (id: string) => ExtensionManifest | undefined;

type Row = {
  id: string;
  listing: string;
  version: string;
  plan: string;
  installed_by: string;
  installed_at: string;
  enabled: number;
  disabled_by: string | null;
  disabled_at: string | null;
  budget_monthly_micros: number | null;
};

const COLUMNS = "id, listing, version, plan, installed_by, installed_at, enabled, disabled_by, disabled_at, budget_monthly_micros";

function toInstall(row: Row): ExtensionInstall {
  return { ...row, enabled: row.enabled === 1 };
}

/** The workspace's live installs, oldest first. */
export async function listInstalls(db: D1Database, workspaceId: string): Promise<ExtensionInstall[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM extension_installs WHERE workspace_id = ? AND uninstalled_at IS NULL ORDER BY installed_at`).bind(workspaceId).all<Row>();
  return results.map(toInstall);
}

/** Installs a published extension at its current version, on the free plan. A conflict when it is installed already. */
export async function install(db: D1Database, catalog: Catalog, workspaceId: string, id: string, extensionId: string, by: string, now = new Date()): Promise<Result<ExtensionInstall>> {
  const manifest = catalog(extensionId);
  if (!manifest) return fail("not_found", "There is no such extension.");
  if (manifest.status !== "available" || !manifest.version || !manifest.source) return fail("invalid", `${manifest.name} isn't published yet, so it can't be installed.`);
  const row: Row = {
    id,
    listing: listingRef("extension", manifest.id),
    version: manifest.version,
    plan: FREE_PLAN,
    installed_by: by,
    installed_at: now.toISOString(),
    enabled: 1,
    disabled_by: null,
    disabled_at: null,
    budget_monthly_micros: null,
  };
  const inserted = await db
    .prepare(
      `INSERT INTO extension_installs (id, workspace_id, listing, version, plan, installed_by, installed_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING RETURNING id`,
    )
    .bind(row.id, workspaceId, row.listing, row.version, row.plan, row.installed_by, row.installed_at)
    .first<{ id: string }>();
  return inserted ? ok(toInstall(row)) : fail("conflict", `${manifest.name} is installed already.`);
}

/** Switches an install on or off. Off is the kill switch: it takes effect at once. */
export async function setEnabled(db: D1Database, workspaceId: string, listing: string, enabled: boolean, by: string, now = new Date()): Promise<Result<ExtensionInstall>> {
  const row = await db
    .prepare(
      `UPDATE extension_installs SET enabled = ?, disabled_by = ?, disabled_at = ?
       WHERE workspace_id = ? AND listing = ? AND uninstalled_at IS NULL RETURNING ${COLUMNS}`,
    )
    .bind(enabled ? 1 : 0, enabled ? null : by, enabled ? null : now.toISOString(), workspaceId, listing)
    .first<Row>();
  return row ? ok(toInstall(row)) : fail("not_found", "That extension isn't installed.");
}

/** Sets an install's monthly spend cap; null leaves it to the workspace's limit. */
export async function setBudget(db: D1Database, workspaceId: string, listing: string, micros: number | null): Promise<Result<ExtensionInstall>> {
  if (micros !== null && (!Number.isSafeInteger(micros) || micros < 0)) return fail("invalid", "A budget is a whole, non-negative number of micro-dollars.");
  const row = await db
    .prepare(`UPDATE extension_installs SET budget_monthly_micros = ? WHERE workspace_id = ? AND listing = ? AND uninstalled_at IS NULL RETURNING ${COLUMNS}`)
    .bind(micros, workspaceId, listing)
    .first<Row>();
  return row ? ok(toInstall(row)) : fail("not_found", "That extension isn't installed.");
}

/** Removes an install, keeping its row with who removed it and when. */
export async function uninstall(db: D1Database, workspaceId: string, listing: string, by: string, now = new Date()): Promise<Result<null>> {
  const row = await db
    .prepare("UPDATE extension_installs SET uninstalled_by = ?, uninstalled_at = ?, enabled = 0 WHERE workspace_id = ? AND listing = ? AND uninstalled_at IS NULL RETURNING id")
    .bind(by, now.toISOString(), workspaceId, listing)
    .first<{ id: string }>();
  return row ? ok(null) : fail("not_found", "That extension isn't installed.");
}

/** The extension id in an `extension:<id>` reference, or null. */
export function extensionIdOf(listing: unknown): string | null {
  const parsed = parseListing(listing);
  return parsed?.kind === "extension" ? parsed.id : null;
}
