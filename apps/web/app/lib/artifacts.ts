/** How big an artifact is, as people read sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** When an artifact goes, from now: "expires today", "expires in 13 days". */
export function expiresIn(at: string | null, now: number = Date.now()): string {
  if (!at) return "";
  const ms = Date.parse(at) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

/**
 * Artifacts older runners kept in Workers KV. None has been made there
 * since artifacts moved to R2 on 2026-10-08, and KV expires each 14 days
 * after it was made: from 2026-10-22T00:00Z every one is gone. Delete the
 * KV artifact code (here, artifacts.server.ts, and apps/api/src/blobs.rs)
 * after that date.
 */
export const LEGACY_KV_UNTIL = Date.parse("2026-10-22T00:00:00Z");
/** Runs made from this time on kept their artifacts in R2 only. */
export const LEGACY_KV_BEFORE = Date.parse("2026-10-09T00:00:00Z");

/**
 * Whether a run's page asks KV for artifacts an older runner kept there:
 * only for a finished run made before the move, and only until they have
 * all expired. A KV list is the dearest thing KV does, and a run still
 * going refreshes its page every few seconds.
 */
export function legacyArtifactsWorthAsking(run: { createdAt: string; status: string }, now: number = Date.now()): boolean {
  return now < LEGACY_KV_UNTIL && run.status === "completed" && Date.parse(run.createdAt) < LEGACY_KV_BEFORE;
}
