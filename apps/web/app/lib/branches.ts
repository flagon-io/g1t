/**
 * How far a branch has moved from the default branch: commits it has that
 * the default branch does not (ahead), and commits the default branch has
 * that it does not (behind), the way `git rev-list --left-right --count`
 * says it. Worked out from what was read of the two histories, merges
 * included; when what was read stops short of where they meet, there is no
 * answer rather than a guess.
 */
export type Drift = { ahead: number; behind: number };

/** A commit as far as counting needs it. */
export type Link = { hash: string; parents: string[] };

/**
 * `commits` is everything read of either history, in any order, repeats
 * allowed. Null when either head is missing from it, or when a commit only
 * one side reaches has a parent that was not read: that parent's history
 * could change either count.
 */
export function drift(branch: string, main: string, commits: Iterable<Link>): Drift | null {
  const parents = new Map<string, string[]>();
  for (const commit of commits) parents.set(commit.hash, commit.parents);
  if (!parents.has(branch) || !parents.has(main)) return null;
  const fromBranch = reach(branch, parents);
  const fromMain = reach(main, parents);
  let ahead = 0;
  let behind = 0;
  for (const [hash, above] of parents) {
    const onBranch = fromBranch.has(hash);
    const onMain = fromMain.has(hash);
    if (onBranch === onMain) continue;
    if (above.some((parent) => !parents.has(parent))) return null;
    if (onBranch) ahead++;
    else behind++;
  }
  return { ahead, behind };
}

/** Every commit read that `head` descends from, itself included. */
function reach(head: string, parents: Map<string, string[]>): Set<string> {
  const seen = new Set([head]);
  const next = [head];
  for (let hash = next.pop(); hash != null; hash = next.pop()) {
    for (const parent of parents.get(hash) ?? []) {
      if (parents.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        next.push(parent);
      }
    }
  }
  return seen;
}

/** `load` over each of `items`, at most `limit` at a time, answers in order. */
export async function bounded<T, R>(items: readonly T[], limit: number, load: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let taken = 0;
  const worker = async () => {
    while (taken < items.length) {
      const index = taken++;
      out[index] = await load(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
