/**
 * A repository's branches as its pages show them: each one's head commit,
 * how far it has moved from the default branch, the pull request open on
 * it with its checks, and its preview. The overview shows the newest few;
 * the Branches page shows them all.
 */
import type { Branch, BranchDrifts, Commit, Pull, RepoPath, Viewer } from "@g1t/contracts";

import type { ActiveBranch } from "../components/branches";
import { activeBranches, branchesToRead, summary } from "./branches";
import { addressesToMatch, showCommit } from "./commit-people";
import { emailOwners } from "./commit-people.server";
import { repos } from "./services.server";

type Preview = { branch?: string | null; number?: number | null; url: string };

/**
 * The branches other than the default, at most `read` of them read (those
 * with an open pull request first), newest commit first, and the default
 * branch's head commit with its first line.
 *
 * One call to repos (`branch_drift`, services/repos/src/drift.rs) measures
 * every branch. It keeps each answer by the pair of head commits, so only
 * branches that moved, or every branch once the default branch moved, cost
 * a walk, and that walk reads the default branch's history once for all of
 * them. Before 2026-10-08 this was a `log` call per branch per depth from
 * here, up to twenty on an overview.
 */
export async function readBranches(
  path: RepoPath,
  viewer: Viewer,
  input: { defaultBranch: string; branches: Branch[]; pulls: Pull[]; previews: Preview[] },
  read: number,
): Promise<{ main: string; total: number; shown: ActiveBranch[]; head: ActiveBranch["commit"] }> {
  const { reading, total, mainHead } = branchesToRead(input, read);
  const measured: BranchDrifts | null = mainHead
    ? await repos
        .branchDrift(path, viewer, mainHead, reading.map((branch) => branch.hash).filter(Boolean))
        .then((found) => (found.ok ? found.value : null))
        .catch(() => null)
    : null;
  // Every head commit's people, in one identity call.
  const heads = [measured?.base, ...(measured?.branches ?? []).map((one) => one.commit)].filter((commit): commit is Commit => commit != null);
  const owners = await emailOwners(addressesToMatch(heads));
  const people = (commit: Commit) => showCommit(commit, owners);
  return { main: input.defaultBranch, total, shown: activeBranches(reading, measured, input, people), head: summary(measured?.base, people) };
}
