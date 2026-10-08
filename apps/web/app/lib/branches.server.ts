/**
 * A repository's branches as its pages show them: each one's head commit,
 * how far it has moved from the default branch, the pull request open on
 * it with its checks, and its preview. The overview shows the newest few;
 * the Branches page shows them all.
 */
import type { Branch, Commit, Pull, RepoPath, Viewer } from "@g1t/contracts";

import type { ActiveBranch } from "../components/branches";
import { bounded, drift } from "./branches";
import { immutable } from "./immutable.server";
import { repos } from "./services.server";

/**
 * How deep each history is read, in turn, to find where a branch and the
 * default branch meet: most branches meet it within the first; a branch
 * left long ago needs the default branch's history further back; one far
 * from both reads both deeply. Past the last, the counts are not shown.
 */
const DEPTHS: ReadonlyArray<{ branch: number; main: number }> = [
  { branch: 40, main: 120 },
  { branch: 40, main: 1000 },
  { branch: 1000, main: 1000 },
];
/** Branches counted at once. */
const COUNTING = 8;

type Preview = { branch?: string | null; number?: number | null; url: string };
/** What never changes for a branch head and a default branch head. */
type Measured = { commit: ActiveBranch["commit"]; drift: ActiveBranch["drift"] };

const summary = (commit: Commit | undefined): ActiveBranch["commit"] =>
  commit ? { hash: commit.hash, message: commit.message.split("\n")[0] ?? "", author: commit.author.name, at: commit.authoredAt } : null;

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
  const mainHead = input.branches.find((branch) => branch.name === main)?.hash ?? null;
  const log = async (hash: string, depth: number): Promise<Commit[] | null> => {
    const found = await soft(repos.log(path, viewer, hash, depth));
    return found?.ok && found.value.length > 0 ? found.value : null;
  };
  // The default branch's history, read once per depth for every branch,
  // and not read deeper when a shallower read already reached its start.
  const mainLogs = new Map<number, Promise<Commit[] | null>>();
  const mainLog = (depth: number): Promise<Commit[] | null> => {
    if (!mainHead) return Promise.resolve(null);
    let kept = mainLogs.get(depth);
    if (!kept) {
      const shallower = Math.max(0, ...[...mainLogs.keys()].filter((read) => read < depth));
      const before = mainLogs.get(shallower);
      kept = before
        ? before.then((read) => (read && read.length < shallower ? read : log(mainHead, depth)))
        : log(mainHead, depth);
      mainLogs.set(depth, kept);
    }
    return kept;
  };
  // Reads deeper only while the two histories have not met. Null when a
  // read failed, so a failure is not kept as the answer.
  const measure = async (head: string, main: string): Promise<Measured | null> => {
    let branch: Commit[] | null = null;
    let readTo = 0;
    for (const depth of DEPTHS) {
      // Not read again when no deeper, or when it already reached the start.
      const again: boolean = branch == null || (depth.branch > readTo && branch.length >= readTo);
      const [read, mainRead]: [Commit[] | null, Commit[] | null] = await Promise.all([
        again ? log(head, depth.branch) : branch,
        mainLog(depth.main),
      ]);
      if (!read || !mainRead) return null;
      if (again) readTo = depth.branch;
      branch = read;
      const counted = drift(head, main, [...mainRead, ...read]);
      if (counted) return { commit: summary(read[0]), drift: counted };
    }
    return { commit: summary(branch?.[0]), drift: null };
  };
  // Kept by the pair of heads: neither history can change, so neither can
  // the answer. Without one, the head commit alone.
  const measureOrHead = async (branch: Branch): Promise<Measured> => {
    const kept =
      branch.hash && mainHead
        ? await immutable(`branch-drift:${path.namespace}/${path.name}:${mainHead}:${branch.hash}`, () => measure(branch.hash, mainHead))
        : null;
    if (kept) return kept;
    const head = await log(branch.hash || branch.name, 1);
    return { commit: summary(head?.[0]), drift: null };
  };
  const [mainTop, measured] = await Promise.all([
    mainHead ? log(mainHead, 1) : Promise.resolve(null),
    bounded(reading, COUNTING, measureOrHead),
  ]);
  const shown = reading
    .map((branch, index): ActiveBranch => {
      const pull = pullOn.get(branch.name);
      return {
        name: branch.name,
        commit: measured[index]?.commit ?? null,
        drift: measured[index]?.drift ?? null,
        pull: pull ? { number: pull.number, title: pull.title, checkStatus: pull.checkStatus, draft: pull.status === "draft" } : null,
        preview: input.previews.find((app) => app.branch === branch.name || (pull != null && app.number === pull.number))?.url ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"));
  return { main, total: others.length, shown, head: summary(mainTop?.[0]) };
}
