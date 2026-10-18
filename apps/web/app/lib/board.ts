/**
 * Work's Board: the workspace's work items as they move, in columns read
 * from what is so (nothing is dragged): Backlog, In progress, In review,
 * Landing and Done. Pure, so it is tested under Node.
 */
import type { Claim, PullStatus, WorkItem, WorkspaceSession } from "@g1t/contracts";

export type Stage = "backlog" | "progress" | "review" | "landing" | "done";

/** The columns, left to right. */
export const STAGES: Stage[] = ["backlog", "progress", "review", "landing", "done"];

export const STAGE_INFO: Record<Stage, { label: string; hint: string }> = {
  backlog: { label: "Backlog", hint: "Open, and nobody is on it" },
  progress: { label: "In progress", hint: "Claimed or assigned, a live session on it, a draft pull request, or a pull request merged that did not close it" },
  review: { label: "In review", hint: "A pull request for it is open" },
  landing: { label: "Landing", hint: "Landed or merged somewhere, and a target repository is still missing it" },
  done: { label: "Done", hint: "Closed as completed in the last 14 days" },
};

/** How long a closed work item stays in Done, and how far back the board reads merged pull requests. */
export const DONE_DAYS = 14;

/**
 * One of a work item's pull requests, as the board counts it: one for the
 * item (`item`), one that closes it (`closes`), or one that is only part
 * of it (`parts`), which merging does not close.
 */
export type ItemPull = {
  /** `owner/name#number`, any case, so one counted twice is counted once. */
  key: string;
  status: PullStatus;
  /** It is only part of the work item: merging it lands nothing. */
  part: boolean;
};

/** What is known of each work item's pull requests, by the item's number. */
export type ItemPulls = Record<number, ItemPull[]>;

/** Who or what is on a work item, for its card. */
export type OnIt = {
  /** People: assignees, claimants and whoever runs a live session on it, each once. */
  people: string[];
  /** Live sessions on it. */
  sessions: WorkspaceSession[];
};

/**
 * The stage a work item is in, the first that holds:
 *
 * - **Done**: closed as completed in the last [`DONE_DAYS`]. Closed as not
 *   planned (which duplicates are) did not ship, and is left out, as is
 *   one closed longer ago: null.
 * - **Landing**: landed in some target repositories and not others; or a
 *   pull request that closes it merged and a target is still missing it
 *   (it merged somewhere that is not a target).
 * - **In review**: a pull request for it is open.
 * - **In progress**: claimed, assigned, a live session, a draft, or a pull
 *   request merged without closing it (part of it, or into a branch that
 *   is not the default).
 * - **Backlog**: anything else open.
 */
export function stageOf(item: WorkItem, facts: { pulls?: ItemPull[]; claimed?: boolean; live?: boolean }, now: number): Stage | null {
  if (item.state === "closed") {
    if (item.reason === "not_planned") return null;
    const closed = item.closedAt ? Date.parse(item.closedAt) : 0;
    return now - closed <= DONE_DAYS * 86_400_000 ? "done" : null;
  }
  const targets = item.repos.filter((repo) => repo.role === "target");
  const missing = targets.some((repo) => !repo.landed);
  if (missing && targets.some((repo) => repo.landed)) return "landing";
  const pulls = facts.pulls ?? [];
  if (missing && pulls.some((pull) => pull.status === "merged" && !pull.part)) return "landing";
  if (pulls.some((pull) => pull.status === "open")) return "review";
  const merged = pulls.some((pull) => pull.status === "merged");
  if (facts.claimed || facts.live || item.assignees.length > 0 || merged || pulls.some((pull) => pull.status === "draft")) return "progress";
  return "backlog";
}

export type BoardCard = {
  item: WorkItem;
  stage: Stage;
  on: OnIt;
  /** How many of an open work item's pull requests merged in the last [`DONE_DAYS`] (none for a closed one). */
  merged: number;
};

export type Board = Record<Stage, BoardCard[]>;

/**
 * The board of `items`, given the workspace's active claims, its live
 * sessions and what is known of each item's pull requests. Each column
 * keeps the most recently changed first; Done the most recently closed.
 */
export function boardOf(
  items: WorkItem[],
  { claims = [], sessions = [], pulls = {} }: { claims?: Claim[]; sessions?: WorkspaceSession[]; pulls?: ItemPulls },
  now: number,
): Board {
  const board: Board = { backlog: [], progress: [], review: [], landing: [], done: [] };
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.number)) continue;
    seen.add(item.number);
    const claimed = claims.filter((claim) => claim.item === item.number && claim.state === "active");
    const live = sessions.filter((session) => session.item === item.number && session.state !== "ended");
    // A live session's pull request counts as one of the item's, once.
    const known = new Map((pulls[item.number] ?? []).map((pull) => [pull.key, pull]));
    for (const session of live) {
      if (session.pull == null || !session.pullStatus) continue;
      const key = `${session.repo}#${session.pull}`.toLowerCase();
      if (!known.has(key)) known.set(key, { key, status: session.pullStatus, part: false });
    }
    const stage = stageOf(item, { pulls: [...known.values()], claimed: claimed.length > 0, live: live.length > 0 }, now);
    if (!stage) continue;
    const people = [...item.assignees, ...claimed.map((claim) => claim.actor.username), ...live.flatMap((session) => (session.actor ? [session.actor] : []))];
    const merged = item.state === "open" ? [...known.values()].filter((pull) => pull.status === "merged").length : 0;
    board[stage].push({ item, stage, on: { people: [...new Set(people)], sessions: live }, merged });
  }
  for (const stage of STAGES) {
    const at = (card: BoardCard) => Date.parse(stage === "done" ? (card.item.closedAt ?? card.item.updatedAt) : card.item.updatedAt);
    board[stage].sort((a, b) => at(b) - at(a));
  }
  return board;
}

/**
 * The repositories whose pull requests the board reads: every one an open
 * work item is linked to, each once, so an item's pull request moves it
 * wherever it was opened. A deleted one (which can still be restored) has
 * none anyone can read, nor one purged with no path kept.
 */
export function pullRepos(items: readonly { state: string; repos: readonly { path: string; deleted?: boolean }[] }[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.state !== "open") continue;
    for (const repo of item.repos) {
      if (!repo.path || repo.deleted || seen.has(repo.path.toLowerCase())) continue;
      seen.set(repo.path.toLowerCase(), repo.path);
    }
  }
  return [...seen.values()];
}

/** A pull request as the board reads it, with the repository it is in. */
export type ReadPull = { repo: string; number: number; item: number | null; status: PullStatus; closes?: number[]; parts?: number[] };

/**
 * Each work item's pull requests: one counts for every work item it is
 * for (`item`), closes (`closes`) or is part of (`parts`), and only as a
 * part when it does not also close it.
 */
export function pullsByItem(pulls: readonly ReadPull[]): ItemPulls {
  const by: ItemPulls = {};
  const add = (number: number, pull: ItemPull) => {
    const known = (by[number] ??= []);
    if (!known.some((one) => one.key === pull.key)) known.push(pull);
  };
  for (const pull of pulls) {
    const key = `${pull.repo}#${pull.number}`.toLowerCase();
    const closing = new Set([...(pull.item == null ? [] : [pull.item]), ...(pull.closes ?? [])]);
    for (const number of closing) add(number, { key, status: pull.status, part: false });
    for (const number of pull.parts ?? []) if (!closing.has(number)) add(number, { key, status: pull.status, part: true });
  }
  return by;
}

/** A list read page after page: its rows, and whether there may be more than were read. */
export type Paged<T> = { rows: T[]; capped: boolean };

/**
 * Every page of a list that comes newest first by number: `read` gives the
 * page below `before` (none for the first), and a page shorter than `size`
 * is the last. At most `pages` are read; `capped` says there may be more.
 */
export async function readPages<T extends { number: number }>(
  read: (before: number | undefined) => Promise<T[]>,
  size: number,
  pages: number,
): Promise<Paged<T>> {
  const rows: T[] = [];
  let before: number | undefined;
  for (let page = 0; page < pages; page++) {
    const found = await read(before);
    rows.push(...found);
    if (found.length < size) return { rows, capped: false };
    before = Math.min(...found.map((row) => row.number));
  }
  return { rows, capped: true };
}

/** Pages of open work items the board reads at most: 1,000 at 100 a page. */
export const ITEM_PAGES = 10;
/** Pages of each repository's open, and of its recently merged, pull requests the board reads at most. */
export const PULL_PAGES = 3;

/**
 * What the board read only in part, in sentences: the open work items
 * when there were more than it reads (`items`, how many it showed), Done
 * when it holds a full page (`done`), and the repositories with more pull
 * requests than it reads (`pulls`).
 */
export function cappedNotes({ items, done, pulls }: { items: number | null; done: number | null; pulls: string[] }): string[] {
  const notes: string[] = [];
  if (items != null) notes.push(`Showing the newest ${items.toLocaleString("en-US")} open work items. Older ones are on the Work list.`);
  if (done != null) notes.push(`Done shows the ${done} most recently closed.`);
  if (pulls.length > 0) {
    const where = pulls.length === 1 ? pulls[0] : `${pulls.length} repositories`;
    notes.push(`Only the newest pull requests in ${where} were read, so some work items may stand a column early.`);
  }
  return notes;
}

/** The stage a phone shows, from the address: a known one, else the first with anything in it, else Backlog. */
export function shownStage(asked: string | null, board: Board): Stage {
  if (asked && (STAGES as string[]).includes(asked)) return asked as Stage;
  return STAGES.find((stage) => board[stage].length > 0) ?? "backlog";
}
