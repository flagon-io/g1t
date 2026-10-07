/**
 * Nightly backups (`RunnerService.startBackups`): each sweep claims a few
 * of the backups the repos service queued and starts a sandbox for each,
 * which runs the runner's `backup` mode (crates/runner backup.rs). The
 * flow is in `crates/contracts/src/backups.rs`. Pure, so it is tested on
 * its own.
 */
import type { BackupClaim } from "@g1t/contracts";

/** A backup's time cap: a clone and a bundle of at most 1 GB. */
export const BACKUP_MINUTES = 60;

/** How many backups one sweep starts, and how many may run at once. */
export type BackupPace = { perSweep: number; running: number };

const DEFAULT_PACE: BackupPace = { perSweep: 4, running: 6 };

function count(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * BACKUPS_PER_SWEEP and BACKUPS_RUNNING, or their defaults. `0` per sweep
 * starts none: backups are off.
 */
export function backupPace(perSweep: string | undefined, running: string | undefined): BackupPace {
  return {
    perSweep: count(perSweep, DEFAULT_PACE.perSweep),
    running: count(running, DEFAULT_PACE.running),
  };
}

/** One sandbox per job: asking twice starts nothing twice. */
export function backupSandboxName(claim: BackupClaim): string {
  return `backup-${claim.jobId}`;
}

/** What the sandbox is started with: its job, and nothing that reads git. */
export function backupEnv(claim: BackupClaim, api: string): Record<string, string> {
  return {
    MODE: "backup",
    G1T_API: api,
    BACKUP_JOB: claim.jobId,
    BACKUP_TOKEN: claim.token,
  };
}
