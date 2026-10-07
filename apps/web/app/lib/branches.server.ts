/**
 * A repository's branches as its pages show them: each one's head commit,
 * how far it has moved from the default branch, the pull request open on
 * it with its checks, and its preview. The overview shows the newest few;
 * the Branches page shows them all.
 */
import type { Branch, Pull, RepoPath, Viewer } from "@g1t/contracts";

import type { ActiveBranch } from "../components/branches";
import { drift } from "./branches";
import { repos } from "./services.server";

/** How far back each branch's history, and the default branch's, is read to count ahead and behind. */
export const BRANCH_DEPTH = 40;
export const MAIN_DEPTH = 120;

type Preview = { branch?: string | null; number?: number | null; url: string };

/**
 * The branches other than the default, at most `read` of them read (those
 * with an open pull request first), newest commit first. `main` is the
 * default branch's head commit with its first line.
 */
export async function readBranches(
  path: RepoPath,
  viewer: Viewer,
  input: { defaultBranch: string; branches: Branch[]; pulls: Pull[]; previews: Preview[] },
  read: number,
): Promise<{ main: string; total: number; shown: ActiveBranch[]; head: ActiveBranch["commit"] }> {
  const soft = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
  const main = input.defaultBranch;
  const pullOn = new Map(input.pulls.filter((pull) => pull.branch).map((pull) => [pull.branch as string, pull]));
  const others = input.branches.filter((branch) => branch.name !== main);
  const reading = [...others.filter((b) => pullOn.has(b.name)), ...others.filter((b) => !pullOn.has(b.name))].slice(0, read);
  // By commit hash, not name: history from a commit never changes, so
  // repos keeps it (services/repos/src/store.rs) and only new heads cost a walk.
  const mainHead = input.branches.find((branch) => branch.name === main)?.hash ?? main;
  const [mainLog, ...logs] = await Promise.all([
    soft(repos.log(path, viewer, mainHead, MAIN_DEPTH)),
    ...reading.map((branch) => soft(repos.log(path, viewer, branch.hash || branch.name, BRANCH_DEPTH))),
  ]);
  const mainHistory = mainLog?.ok ? mainLog.value : [];
  const mainHashes = mainHistory.map((c) => c.hash);
  const summary = (commit: (typeof mainHistory)[number] | undefined): ActiveBranch["commit"] =>
    commit ? { hash: commit.hash, message: commit.message.split("\n")[0] ?? "", author: commit.author.name, at: commit.authoredAt } : null;
  const shown = reading
    .map((branch, index): ActiveBranch => {
      const history = logs[index]?.ok ? logs[index].value : [];
      const pull = pullOn.get(branch.name);
      return {
        name: branch.name,
        commit: summary(history[0]),
        ...drift(history.map((c) => c.hash), mainHashes, BRANCH_DEPTH),
        pull: pull ? { number: pull.number, title: pull.title, checkStatus: pull.checkStatus, draft: pull.status === "draft" } : null,
        preview: input.previews.find((app) => app.branch === branch.name || (pull != null && app.number === pull.number))?.url ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"));
  return { main, total: others.length, shown, head: summary(mainHistory[0]) };
}
