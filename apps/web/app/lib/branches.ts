/**
 * Active branches as the overview and the Branches page show them, from
 * the repos service's `branch_drift` answer. The counting itself is done
 * there (services/repos/src/drift.rs), kept by the pair of head commits.
 */
import type { Branch, BranchDrifts, Commit, Pull } from "@g1t/contracts";

import type { ActiveBranch } from "../components/branches";

/**
 * How far a branch has moved from the default branch: commits it has that
 * the default branch does not (ahead), and commits the default branch has
 * that it does not (behind), the way `git rev-list --left-right --count`
 * says it.
 */
export type Drift = { ahead: number; behind: number };

type Preview = { branch?: string | null; number?: number | null; url: string };

/** A commit as a branch row shows it: its first line. */
export const summary = (commit: Commit | null | undefined): ActiveBranch["commit"] =>
  commit ? { hash: commit.hash, message: commit.message.split("\n")[0] ?? "", author: commit.author.name, at: commit.authoredAt } : null;

/**
 * The branches other than the default that are read (at most `read`, those
 * with an open pull request first), how many there are, and the default
 * branch's head commit.
 */
export function branchesToRead(
  input: { defaultBranch: string; branches: Branch[]; pulls: Pick<Pull, "branch">[] },
  read: number,
): { reading: Branch[]; total: number; mainHead: string | null } {
  const pullOn = new Set(input.pulls.flatMap((pull) => (pull.branch ? [pull.branch] : [])));
  const others = input.branches.filter((branch) => branch.name !== input.defaultBranch);
  const reading = [...others.filter((b) => pullOn.has(b.name)), ...others.filter((b) => !pullOn.has(b.name))].slice(0, read);
  const mainHead = input.branches.find((branch) => branch.name === input.defaultBranch)?.hash || null;
  return { reading, total: others.length, mainHead };
}

/**
 * Each branch read, newest commit first, with what repos measured (null
 * when that could not be had: no commits, no counts), its pull request and
 * its preview.
 */
export function activeBranches(
  reading: Branch[],
  measured: BranchDrifts | null,
  input: { pulls: Pick<Pull, "branch" | "number" | "title" | "checkStatus" | "status">[]; previews: Preview[] },
): ActiveBranch[] {
  const pullOn = new Map(input.pulls.flatMap((pull) => (pull.branch ? [[pull.branch, pull] as const] : [])));
  const byHead = new Map((measured?.branches ?? []).map((found) => [found.head, found]));
  return reading
    .map((branch): ActiveBranch => {
      const pull = pullOn.get(branch.name);
      const found = byHead.get(branch.hash);
      return {
        name: branch.name,
        commit: summary(found?.commit),
        drift: found?.drift ?? null,
        pull: pull ? { number: pull.number, title: pull.title, checkStatus: pull.checkStatus, draft: pull.status === "draft" } : null,
        preview: input.previews.find((app) => app.branch === branch.name || (pull != null && app.number === pull.number))?.url ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"));
}
