import type { Pull } from "@g1t/contracts";

/** g1t's own name: its agent's, and the system's. */
export const G1T = "g1t";

/**
 * Whether g1t's own agent made a pull request: in a fork of its own, not
 * on a branch someone pushed.
 */
export function madeByG1t(pull: Pick<Pull, "agent" | "branch">): boolean {
  return pull.agent === G1T && !pull.branch;
}

/**
 * Who shows as having opened a pull request. g1t for one its agent made,
 * with the person who asked for the work as `requestedBy`; anyone else's
 * is its author's, with no `requestedBy`. Only the face: who may change
 * the pull request is still decided by its stored author.
 */
export function openedBy(pull: Pick<Pull, "agent" | "branch" | "author">): { name: string; requestedBy: string | null } {
  if (!madeByG1t(pull)) return { name: pull.author.username, requestedBy: null };
  // Work g1t started itself, such as a security update's code change, was asked for by nobody else.
  return { name: G1T, requestedBy: pull.author.username === G1T ? null : pull.author.username };
}
