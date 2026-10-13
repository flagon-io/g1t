import type { Pull } from "@g1t/contracts";

/** g1t's own name: its agent's, and the system's. */
export const G1T = "g1t";

/**
 * Who opened an issue or a pull request, and who asked g1t for it, as
 * stored: g1t for what it made or filed, with the person it was for as
 * `requestedBy`; anyone else's, theirs alone. Who may change it is the
 * same pair read the other way round: `workOwner` in the contracts.
 */
export function openedBy(item: Pick<Pull, "author" | "requestedBy">): { name: string; requestedBy: string | null } {
  return { name: item.author.username, requestedBy: item.requestedBy?.username ?? null };
}
