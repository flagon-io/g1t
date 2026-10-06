/**
 * How the site speaks of a workspace's trial credit. Pure, so it can be
 * tested.
 */

import type { Trial } from "@g1t/contracts";

/** "November 1", in UTC, when new trials start again. */
export function resumesOn(at: string): string {
  return new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Why the trial cannot pay for anything now, in a sentence, or null when it
 * can: no card check yet (`verify`), used, or this month's pool given out.
 */
export function trialClosed(trial: Trial | null | undefined, workspace: string): string | null {
  if (!trial || trial.open) return null;
  // `verify` is newer than the contract's list of reasons: the trial waits for a card check.
  if ((trial.reason as string | null) === "verify")
    return `${workspace} needs a card check before its trial starts. The card is never charged.`;
  if (trial.reason === "used") return `${workspace} has used its trial credit on g1t.`;
  if (trial.reason === "pool")
    return trial.waitsUntil
      ? `This month's free trials are all given out; new ones start on ${resumesOn(trial.waitsUntil)}.`
      : "This month's free trials are all given out; new ones start next month.";
  if (trial.reason === "ended") return "The free allowance on g1t's models has ended.";
  return null;
}
