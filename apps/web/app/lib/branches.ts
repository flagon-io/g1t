/**
 * How far a branch has moved from the default branch, worked out from the
 * two histories alone: commits it has that the default branch does not
 * (ahead), and commits the default branch gained since they last agreed
 * (behind). Each history is read only so far back, so a count that ran
 * past it is a lower bound, said with `aheadMore` and `behindMore`.
 */
export type Drift = { ahead: number; behind: number; aheadMore: boolean; behindMore: boolean };

/** `branch` and `main` are commit hashes, newest first; `limit` is how many each was asked for. */
export function drift(branch: string[], main: string[], limit: number): Drift {
  const onMain = new Set(main);
  let ahead = branch.findIndex((hash) => onMain.has(hash));
  if (ahead === -1) {
    // No shared commit within reach: everything read is ahead, and how far
    // behind it is cannot be told.
    return { ahead: branch.length, behind: 0, aheadMore: branch.length >= limit, behindMore: true };
  }
  const base = branch[ahead];
  const behind = main.indexOf(base);
  return { ahead, behind, aheadMore: false, behindMore: false };
}

/** `12`, `50+` when the count ran past what was read, or `?` when nothing was counted before it did. */
export function count(value: number, more: boolean): string {
  if (more && value === 0) return "?";
  return more ? `${value}+` : String(value);
}
