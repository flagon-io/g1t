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
  progress: { label: "In progress", hint: "Claimed or assigned, a live session on it, or a draft pull request" },
  review: { label: "In review", hint: "A pull request for it is open" },
  landing: { label: "Landing", hint: "Landed in some of its repositories, still missing in others" },
  done: { label: "Done", hint: "Closed in the last 14 days" },
};

/** How long a closed work item stays in Done. */
export const DONE_DAYS = 14;

/** What is known of a work item's pull requests: their statuses. */
export type ItemPulls = Record<number, PullStatus[]>;

/** Who or what is on a work item, for its card. */
export type OnIt = {
  /** People: assignees, claimants and whoever runs a live session on it, each once. */
  people: string[];
  /** Live sessions on it. */
  sessions: WorkspaceSession[];
};

/**
 * The stage a work item is in, the first that holds: closed recently is
 * Done; landed in some target repositories and not others is Landing; an
 * open pull request is In review; claimed, assigned, a live session or a
 * draft is In progress; anything else open is Backlog. Null for one closed
 * longer ago than [`DONE_DAYS`], which the board leaves out.
 */
export function stageOf(item: WorkItem, facts: { pulls?: PullStatus[]; claimed?: boolean; live?: boolean }, now: number): Stage | null {
  if (item.state === "closed") {
    const closed = item.closedAt ? Date.parse(item.closedAt) : 0;
    return now - closed <= DONE_DAYS * 86_400_000 ? "done" : null;
  }
  const targets = item.repos.filter((repo) => repo.role === "target");
  if (targets.some((repo) => repo.landed) && targets.some((repo) => !repo.landed)) return "landing";
  const pulls = facts.pulls ?? [];
  if (pulls.includes("open")) return "review";
  if (facts.claimed || facts.live || item.assignees.length > 0 || pulls.includes("draft")) return "progress";
  return "backlog";
}

export type BoardCard = { item: WorkItem; stage: Stage; on: OnIt };

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
    // A live session's pull request counts as one of the item's.
    const known = [...(pulls[item.number] ?? []), ...live.flatMap((session) => (session.pullStatus ? [session.pullStatus] : []))];
    const stage = stageOf(item, { pulls: known, claimed: claimed.length > 0, live: live.length > 0 }, now);
    if (!stage) continue;
    const people = [...item.assignees, ...claimed.map((claim) => claim.actor.username), ...live.flatMap((session) => (session.actor ? [session.actor] : []))];
    board[stage].push({ item, stage, on: { people: [...new Set(people)], sessions: live } });
  }
  for (const stage of STAGES) {
    const at = (card: BoardCard) => Date.parse(stage === "done" ? (card.item.closedAt ?? card.item.updatedAt) : card.item.updatedAt);
    board[stage].sort((a, b) => at(b) - at(a));
  }
  return board;
}

/**
 * The repositories whose open pull requests the board reads: every one an
 * open work item is linked to, each once, so an item's pull request moves
 * it wherever it was opened. A repository deleted before work items, with
 * no path kept, has none to read.
 */
export function pullRepos(items: readonly { state: string; repos: readonly { path: string }[] }[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.state !== "open") continue;
    for (const repo of item.repos) if (repo.path && !seen.has(repo.path.toLowerCase())) seen.set(repo.path.toLowerCase(), repo.path);
  }
  return [...seen.values()];
}

/** Each work item's pull requests' statuses, from pull requests that name their item. */
export function pullsByItem(pulls: { item: number | null; status: PullStatus }[]): ItemPulls {
  const by: ItemPulls = {};
  for (const pull of pulls) {
    if (pull.item == null) continue;
    (by[pull.item] ??= []).push(pull.status);
  }
  return by;
}

/** The stage a phone shows, from the address: a known one, else the first with anything in it, else Backlog. */
export function shownStage(asked: string | null, board: Board): Stage {
  if (asked && (STAGES as string[]).includes(asked)) return asked as Stage;
  return STAGES.find((stage) => board[stage].length > 0) ?? "backlog";
}
