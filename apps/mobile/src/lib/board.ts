import type { ApiWorkspaceSession, Harness, PullStatus } from "./sessions";
import type { ApiWorkItem } from "./work";

/**
 * Work's board: where each work item stands as it moves, read from the
 * item, its pull requests and the sessions on it. Done is closed as
 * completed in the last two weeks (not planned is left out); Landing has landed in some targets but not all; In
 * review has an open pull request; In progress has someone on it (an
 * assignee, a claim, a live session) or a draft; Backlog has nobody.
 * The first that holds, in that order, is its stage.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

export type Stage = "backlog" | "in_progress" | "in_review" | "landing" | "done";

/** The stages in the order work moves through them. */
export const STAGES: Stage[] = ["backlog", "in_progress", "in_review", "landing", "done"];

const NAMES: Record<Stage, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  in_review: "In review",
  landing: "Landing",
  done: "Done",
};

export function stageName(stage: Stage): string {
  return NAMES[stage];
}

/** How long a closed item stays in Done. */
export const DONE_DAYS = 14;

export type BoardItem = Pick<ApiWorkItem, "number" | "state" | "assignees" | "repos" | "closed_at"> &
  Partial<Pick<ApiWorkItem, "reason">> & {
    /** Someone has claimed it. */
    claimed?: boolean;
  };

/** A pull request for a work item, by the item's number in the workspace. */
export type BoardPull = { item: number | null; status: PullStatus };

export type BoardSession = Pick<ApiWorkspaceSession, "item" | "state" | "actor" | "harness" | "pull" | "pull_status">;

export type BoardContext = {
  pulls: BoardPull[];
  sessions: BoardSession[];
  now?: number;
};

/** Someone on an item: an assignee, or who runs a live session on it and in what. */
export type OnIt = { name: string; harness: Harness | null };

export type Card<T extends BoardItem> = { item: T; stage: Stage; people: OnIt[] };

/** The stage of one item, or null for one closed too long ago to show. */
export function stageOf(item: BoardItem, context: BoardContext): Stage | null {
  const now = context.now ?? Date.now();
  if (item.state === "closed") {
    // Closed as not planned (a duplicate, say) did not ship: not Done.
    if (item.reason === "not_planned") return null;
    const closed = item.closed_at ? Date.parse(item.closed_at) : NaN;
    return !Number.isNaN(closed) && now - closed <= DONE_DAYS * 86_400_000 ? "done" : null;
  }
  const targets = item.repos.filter((repo) => repo.role === "target");
  if (targets.some((repo) => repo.landed) && targets.some((repo) => !repo.landed)) return "landing";
  const statuses = pullsOf(item.number, context);
  if (statuses.includes("open")) return "in_review";
  const live = context.sessions.some((session) => session.item === item.number && session.state !== "ended");
  if (item.assignees.length > 0 || item.claimed || live || statuses.includes("draft")) return "in_progress";
  return "backlog";
}

/** Who is on an item: its assignees, then whoever runs a live session on it. */
export function peopleOn(item: BoardItem, sessions: BoardSession[]): OnIt[] {
  const people: OnIt[] = item.assignees.map((name) => ({ name, harness: null }));
  for (const session of sessions) {
    if (session.item !== item.number || session.state === "ended" || !session.actor) continue;
    const known = people.find((one) => one.name.toLowerCase() === session.actor!.toLowerCase() && (one.harness === null || one.harness === session.harness));
    if (known) known.harness ??= session.harness;
    else people.push({ name: session.actor, harness: session.harness });
  }
  return people;
}

/**
 * The board: every item in its stage, in the order given, Done newest
 * closed first. Items closed too long ago are left out; an item given
 * twice is shown once.
 */
export function boardOf<T extends BoardItem>(items: T[], context: BoardContext): Record<Stage, Card<T>[]> {
  const board: Record<Stage, Card<T>[]> = { backlog: [], in_progress: [], in_review: [], landing: [], done: [] };
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.number)) continue;
    seen.add(item.number);
    const stage = stageOf(item, context);
    if (stage) board[stage].push({ item, stage, people: peopleOn(item, context.sessions) });
  }
  board.done.sort((a, b) => (b.item.closed_at ?? "").localeCompare(a.item.closed_at ?? ""));
  return board;
}

/** An item's pull requests' statuses: from the pull requests read, and those sessions name. */
function pullsOf(number: number, context: BoardContext): PullStatus[] {
  const statuses = context.pulls.filter((pull) => pull.item === number).map((pull) => pull.status);
  for (const session of context.sessions) {
    if (session.item === number && session.pull && session.pull_status) statuses.push(session.pull_status);
  }
  return statuses;
}
