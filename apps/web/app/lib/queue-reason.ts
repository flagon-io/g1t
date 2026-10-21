/**
 * How a merge queue entry's reason reads on its card. An entry still in
 * the queue with a reason is waiting on something that ends by itself (a
 * repository being copied into a fork takes no writes), so it says it is
 * waiting, in a warning's colour; one that left says why, as a failure.
 */
import type { QueueState } from "@g1t/contracts";

export type QueueReason = { label: string | null; text: string; waiting: boolean };

export function queueReason(state: QueueState, error: string | null | undefined): QueueReason | null {
  if (!error) return null;
  const waiting = state === "waiting" || state === "passed";
  return { label: waiting ? "Waiting:" : null, text: error, waiting };
}
