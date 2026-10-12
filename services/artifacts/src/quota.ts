/**
 * What a workspace without the g1t plan may keep in files put in its pages
 * and artifacts (images, attachments): `FREE_DOC_FILES_BYTES` (1 GiB, a
 * wrangler var; `0` is no cap). Past it, a new upload is refused with a
 * message saying so; nothing already kept is touched. Billing is asked
 * only once the workspace is past the cap, and when it does not answer the
 * upload goes ahead.
 */
import type { ServiceBinding } from "@g1t/contracts";

export const DEFAULT_FREE_DOC_FILES_BYTES = 1024 * 1024 * 1024;

export type QuotaEnv = { BILLING?: ServiceBinding; FREE_DOC_FILES_BYTES?: string };

/** The cap from its var: the default when unset or not a whole number; 0 is none. */
export function freeFilesCap(raw: string | undefined): number {
  const value = Number((raw ?? "").trim());
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_FREE_DOC_FILES_BYTES;
}

/** `1 GB`, `1.5 GB`, `300 MB`. */
export function shownBytes(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  if (bytes >= gb) {
    const tenths = Math.ceil((bytes * 10) / gb);
    return tenths % 10 === 0 ? `${tenths / 10} GB` : `${(tenths / 10).toFixed(1)} GB`;
  }
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** What a free workspace is told when `adding` would take it past `cap`; null while it fits. */
export function filesRefusal(held: number, adding: number, cap: number): string | null {
  if (cap <= 0 || held + adding <= cap) return null;
  return `This workspace's files hold ${shownBytes(held)} of the ${shownBytes(cap)} a workspace on the free plan keeps, so this file is not kept. Delete files you no longer need, or start the g1t plan, which has no such cap.`;
}

/** Why an upload of `adding` bytes to `workspace` is refused, or null. */
export async function uploadRefused(
  db: D1Database,
  env: QuotaEnv,
  workspace: { id: string; slug: string },
  adding: number,
): Promise<string | null> {
  const cap = freeFilesCap(env.FREE_DOC_FILES_BYTES);
  if (cap <= 0) return null;
  const row = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM files WHERE workspace_id = ?1)
            + (SELECT COALESCE(SUM(bytes), 0) FROM folio_files WHERE workspace_id = ?1) AS bytes`,
    )
    .bind(workspace.id)
    .first<{ bytes: number }>();
  const why = filesRefusal(row?.bytes ?? 0, adding, cap);
  if (!why || !env.BILLING) return null;
  try {
    // Loaded here, so the rules above test under Node without the contracts' runtime.
    const { billingClient } = await import("@g1t/contracts");
    const free = await billingClient(env.BILLING).freeWorkspaces([workspace.slug]);
    return free.map((slug) => slug.toLowerCase()).includes(workspace.slug.toLowerCase()) ? why : null;
  } catch (error) {
    console.error("artifacts: billing did not say whether the workspace is free", workspace.slug, error);
    return null;
  }
}
