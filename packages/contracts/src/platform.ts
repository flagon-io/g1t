/**
 * g1t-wide pauses: staff (or billing's hourly usage watcher) can stop
 * whole kinds of work across the platform while unusual usage is looked
 * into. See the billing service's `platform.rs` and
 * docs.g1t.sh/guides/deploy-to-cloudflare/#spend-guardrails.
 *
 * - `compute`: agents, sandboxes, Actions hosted jobs and builds. Billing's
 *   `reserve` refuses them itself, so every `ComputeGate.admit` caller gets
 *   it without asking here.
 * - `schedules`: Actions' cron-triggered runs, and the runner's sweep that
 *   starts queued agents.
 * - `indexing`: context embeddings and backfills, search backfills.
 * - `renders`: social card rendering, which falls back to a static image.
 *
 * Read through billing's `platform_pause`, kept for 30 seconds in the
 * isolate: never a database read per request. When billing cannot say,
 * nothing is paused (fails open): a pause is pulled on purpose, and a
 * billing outage must not stop the platform with it. The failure is kept
 * for the same 30 seconds.
 *
 * Only type imports, so services' unit tests can load it on its own.
 */
import type { ServiceBinding } from "./clients";

export type PauseLevel = "compute" | "schedules" | "indexing" | "renders";

export const PAUSE_LEVELS: readonly PauseLevel[] = ["compute", "schedules", "indexing", "renders"];

/** Billing's `platform_pause`: which levels are paused now. */
export type PlatformPause = Record<PauseLevel, boolean>;

/** How long an answer is kept in the isolate. */
export const PAUSE_KEPT_MS = 30_000;

const NOTHING_PAUSED: PlatformPause = { compute: false, schedules: false, indexing: false, renders: false };

let kept: { value: PlatformPause; until: number } | null = null;

/** Billing's answer as a pause, anything it does not say as not paused. */
export function readPause(answer: unknown): PlatformPause {
  const raw = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  return {
    compute: raw.compute === true,
    schedules: raw.schedules === true,
    indexing: raw.indexing === true,
    renders: raw.renders === true,
  };
}

/** Every level, kept for 30 seconds. Nothing paused when billing cannot say. Never throws. */
export async function platformPause(billing: ServiceBinding | undefined, now = Date.now()): Promise<PlatformPause> {
  if (!billing) return NOTHING_PAUSED;
  if (kept && kept.until > now) return kept.value;
  let value = NOTHING_PAUSED;
  try {
    const response = await billing.fetch("https://service/rpc/platform_pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`platform_pause failed with status ${response.status}`);
    value = readPause(await response.json());
  } catch (error) {
    console.error("platform pause unreadable, so nothing is paused", String(error));
  }
  kept = { value, until: now + PAUSE_KEPT_MS };
  return value;
}

/** Whether `level` is paused across g1t. */
export async function platformPaused(billing: ServiceBinding | undefined, level: PauseLevel): Promise<boolean> {
  return (await platformPause(billing))[level];
}

/** For tests: forget the kept answer. */
export function forgetPlatformPause(): void {
  kept = null;
}
