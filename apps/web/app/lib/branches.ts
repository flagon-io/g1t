/**
 * Branches as the overview and the Branches page show them, from the
 * repos service's `branch_drift` answer. The counting itself is done
 * there (services/repos/src/drift.rs), kept by the pair of head commits.
 */
import type { Branch, BranchDrifts, Commit, Pull } from "@g1t/contracts";

import type { ActiveBranch } from "../components/branches";
import type { ShownCommit } from "./commit-people";

/**
 * How far a branch has moved from the default branch: commits it has that
 * the default branch does not (ahead), and commits the default branch has
 * that it does not (behind), the way `git rev-list --left-right --count`
 * says it.
 */
export type Drift = { ahead: number; behind: number };

type Preview = { branch?: string | null; number?: number | null; url: string };

type PullOn = Pick<Pull, "branch" | "number" | "title" | "checkStatus" | "status">;

/** A commit's people, as lib/commit-people.ts `showCommit` finds them. */
export type People = (commit: Commit) => Pick<ShownCommit, "author" | "coAuthors">;

/** Nobody matched to an account: the name on the commit. */
const byName: People = (commit) => ({
  author: { kind: "author", name: commit.author.name, username: null, avatar: null },
  coAuthors: [],
});

/** Whether a pull request is still open: ready for review or a draft. */
const isOpen = (pull: Pick<Pull, "status">) => pull.status === "open" || pull.status === "draft";

/**
 * A commit as a branch row shows it: its first line, and its people as
 * `people` finds them (lib/branches.server.ts passes the accounts).
 */
export function summary(commit: Commit | null | undefined, people: People = byName): ActiveBranch["commit"] {
  if (!commit) return null;
  const shown = people(commit);
  return { hash: commit.hash, message: commit.message.split("\n")[0] ?? "", author: shown.author, coAuthors: shown.coAuthors, at: commit.authoredAt };
}

/**
 * The branches other than the default that are read (at most `read`, those
 * with an open pull request first), how many there are, and the default
 * branch's head commit.
 */
export function branchesToRead(
  input: { defaultBranch: string; branches: Branch[]; pulls: Pick<Pull, "branch" | "status">[] },
  read: number,
): { reading: Branch[]; total: number; mainHead: string | null } {
  const pullOn = new Set(input.pulls.flatMap((pull) => (pull.branch && isOpen(pull) ? [pull.branch] : [])));
  const others = input.branches.filter((branch) => branch.name !== input.defaultBranch);
  const reading = [...others.filter((b) => pullOn.has(b.name)), ...others.filter((b) => !pullOn.has(b.name))].slice(0, read);
  const mainHead = input.branches.find((branch) => branch.name === input.defaultBranch)?.hash || null;
  return { reading, total: others.length, mainHead };
}

/**
 * Each branch's pull request: the open one, else the newest that was
 * merged or closed. `pulls` come newest first, as `listPulls` answers.
 */
function pullsByBranch(pulls: PullOn[]): Map<string, PullOn> {
  const found = new Map<string, PullOn>();
  for (const pull of pulls) {
    if (!pull.branch) continue;
    const kept = found.get(pull.branch);
    if (!kept || (!isOpen(kept) && isOpen(pull))) found.set(pull.branch, pull);
  }
  return found;
}

/**
 * Each branch read, newest commit first, with what repos measured (null
 * when that could not be had: no commits, no counts), its pull request and
 * its preview.
 */
export function activeBranches(
  reading: Branch[],
  measured: BranchDrifts | null,
  input: { pulls: PullOn[]; previews: Preview[] },
  people: People = byName,
): ActiveBranch[] {
  const pullOn = pullsByBranch(input.pulls);
  const byHead = new Map((measured?.branches ?? []).map((found) => [found.head, found]));
  return reading
    .map((branch): ActiveBranch => {
      const pull = pullOn.get(branch.name);
      const found = byHead.get(branch.hash);
      return {
        name: branch.name,
        head: branch.hash,
        commit: summary(found?.commit, people),
        drift: found?.drift ?? null,
        pull: pull ? { number: pull.number, title: pull.title, checkStatus: pull.checkStatus, draft: pull.status === "draft", status: pull.status } : null,
        preview: input.previews.find((app) => app.branch === branch.name || (pull != null && isOpen(pull) && app.number === pull.number))?.url ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"));
}

// --- The Branches page: its tabs and sections --------------------------------

/** The Branches page's tabs, kept in the address as `?tab=`. */
export const BRANCH_TABS = ["overview", "yours", "active", "stale", "all"] as const;
export type BranchTab = (typeof BRANCH_TABS)[number];

/** A tab from the address: the overview for anything else. */
export function branchTab(value: string | null | undefined): BranchTab {
  return (BRANCH_TABS as readonly string[]).includes(value ?? "") ? (value as BranchTab) : "overview";
}

/** A branch whose last commit is older than this is stale. */
export const STALE_DAYS = 90;

/** Whether a branch's last commit is more than `STALE_DAYS` old. A branch whose commit was not read is not. */
export function isStale(branch: Pick<ActiveBranch, "commit">, now: number): boolean {
  const at = branch.commit ? Date.parse(branch.commit.at) : Number.NaN;
  return Number.isFinite(at) && at < now - STALE_DAYS * 86_400_000;
}

/** Whether `username` made a branch's latest commit. */
export function isYours(branch: Pick<ActiveBranch, "commit">, username: string | null | undefined): boolean {
  return Boolean(username) && branch.commit?.author.username?.toLowerCase() === username?.toLowerCase();
}

/**
 * Whether deleting a branch loses nothing the default branch lacks: every
 * commit on it is on the default branch, or its pull request was merged.
 * Such a branch is deleted without asking.
 */
export function isMerged(branch: Pick<ActiveBranch, "drift" | "pull">): boolean {
  return branch.drift?.ahead === 0 || branch.pull?.status === "merged";
}

export type BranchSection = {
  tab: Exclude<BranchTab, "overview">;
  title: string;
  /** Under the title, when it needs saying. */
  note?: string;
  branches: ActiveBranch[];
  /** How many more the section's own tab lists. */
  more: number;
};

/** How many branches each section of the overview shows. */
export const OVERVIEW_SHOWN = 5;

/**
 * The sections a tab lists, besides the default branch: the overview
 * shows a few of the viewer's branches, the active ones and the stale ones; each other
 * tab lists its own.
 */
export function branchSections(
  branches: ActiveBranch[],
  tab: BranchTab,
  viewer: { username: string | null; now: number },
  shown = OVERVIEW_SHOWN,
): BranchSection[] {
  const yours = branches.filter((branch) => isYours(branch, viewer.username));
  const active = branches.filter((branch) => !isStale(branch, viewer.now));
  const stale = branches.filter((branch) => isStale(branch, viewer.now));
  const whole = (section: Omit<BranchSection, "more">): BranchSection => ({ ...section, more: 0 });
  switch (tab) {
    case "overview": {
      const few = (section: Omit<BranchSection, "more">): BranchSection => ({
        ...section,
        branches: section.branches.slice(0, shown),
        more: Math.max(0, section.branches.length - shown),
      });
      return [
        ...(yours.length > 0 ? [few({ tab: "yours", title: "Your branches", branches: yours })] : []),
        few({ tab: "active", title: "Active branches", branches: active }),
        ...(stale.length > 0 ? [few({ tab: "stale", title: "Stale branches", branches: stale })] : []),
      ];
    }
    case "yours":
      return [whole({ tab, title: "Your branches", note: "Branches whose latest commit is yours.", branches: yours })];
    case "active":
      return [whole({ tab, title: "Active branches", note: `Commits in the last ${STALE_DAYS} days.`, branches: active })];
    case "stale":
      return [whole({ tab, title: "Stale branches", note: `No commits in the last ${STALE_DAYS} days.`, branches: stale })];
    case "all":
      return [whole({ tab, title: "All branches", branches })];
  }
}

/** The longest behind or ahead count among `branches`, which a full bar stands for. */
export function driftScale(branches: Pick<ActiveBranch, "drift">[]): number {
  return Math.max(1, ...branches.map((branch) => Math.max(branch.drift?.ahead ?? 0, branch.drift?.behind ?? 0)));
}
