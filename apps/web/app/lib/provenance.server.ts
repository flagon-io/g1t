import type { Pull, RepoPath, Viewer } from "@g1t/contracts";

import { repos, work } from "./services.server";

/** How far back the default branch is read to place a commit. */
const HISTORY_READ = 300;

/**
 * The merged pull request a commit arrived in: the one whose head it is,
 * or else the one whose stretch of the default branch's history holds it,
 * from its head back to where it started. One read of pull requests and at
 * most one of history, however many pull requests there are.
 */
export async function pullForCommit(path: RepoPath, viewer: Viewer, hash: string): Promise<Pull | null> {
  const closed = await work.listPulls(path, viewer, "closed");
  if (!closed.ok) return null;
  const merged = closed.value.filter((pull) => pull.status === "merged" && pull.headCommit);
  const direct = merged.find((pull) => pull.headCommit === hash);
  if (direct) return direct;

  const log = await repos.log(path, viewer, null, HISTORY_READ);
  if (!log.ok) return null;
  const position = new Map(log.value.map((commit, index) => [commit.hash, index]));
  const at = position.get(hash);
  if (at == null) return null;
  // Newest first: a pull request's commits sit at or after its head and
  // before the commit it started from.
  let best: { pull: Pull; head: number } | null = null;
  for (const pull of merged) {
    const head = position.get(pull.headCommit!);
    if (head == null || head > at) continue;
    const base = pull.mergeBase ? position.get(pull.mergeBase) : undefined;
    if (base != null && base <= at) continue;
    if (!best || head > best.head) best = { pull, head };
  }
  return best?.pull ?? null;
}
