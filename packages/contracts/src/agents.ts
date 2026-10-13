/**
 * Runs and recorded sessions, kept by the work service. Mirrors
 * `g1t_contracts::agents`.
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { Pull, PullStatus, SessionEntry } from "./work";

/**
 * The work a run does. Only checks, queue and mergecheck are started now;
 * the others are runs of the agents g1t once ran itself, kept so older
 * runs still read.
 */
export type RunKind =
  | "implement"
  | "revise"
  | "review"
  | "answer"
  | "update"
  | "plan"
  | "checks"
  | "queue"
  | "mergecheck";

export const RUN_KINDS: RunKind[] = ["implement", "revise", "review", "answer", "update", "plan", "checks", "queue", "mergecheck"];

/** How a kind of run reads in a sentence: "is implementing", "a review run". */
export const RUN_KIND_LABEL: Record<RunKind, string> = {
  implement: "Implementing",
  revise: "Revising",
  review: "Reviewing",
  answer: "Answering",
  update: "Catching up",
  plan: "Planning",
  checks: "Checks",
  queue: "Merge queue",
  mergecheck: "Merge check",
};

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export function isActiveRun(status: AgentRunStatus): boolean {
  return status === "queued" || status === "running";
}

export type RunStep = { at: string; text: string };

export type AgentRun = {
  id: string;
  repo: RepoPath;
  number: number | null;
  title: string | null;
  kind: RunKind;
  /** `g1t`, for its own agent and for a sandbox that runs commands. */
  agent: string;
  /** Members only. */
  model: string | null;
  status: AgentRunStatus;
  step: string | null;
  /** Oldest first; empty in lists. */
  steps: RunStep[];
  stepCount: number;
  startedBy: string | null;
  error: string | null;
  /** Members only. */
  costUsd: number | null;
  turns: number | null;
  /** The most it may cost, from its guardrails. Null: no cap, or not a member. */
  budgetUsd?: number | null;
  /** The longest it may take, in minutes, from its guardrails. */
  timeCapMinutes?: number | null;
  /** `budget` or `time` when g1t stopped it for reaching that cap. */
  halted?: "budget" | "time" | "abuse" | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type AgentRunTicket = { runId: string; token: string };

export type OpenRunInput = {
  actor: User;
  repo: RepoPath;
  number?: number | null;
  pullId?: string | null;
  title?: string | null;
  kind: RunKind;
  agent?: string | null;
  model?: string | null;
  sandbox: string;
  startedBy?: string | null;
  /** Its caps, from its guardrails. */
  budgetUsd?: number | null;
  timeCapMinutes?: number | null;
};

export type RunFilter = {
  repo?: RepoPath;
  workspace?: string;
  active?: boolean;
  kind?: RunKind;
  status?: AgentRunStatus;
  number?: number;
  limit?: number;
};

export type SessionSummary = {
  number: number;
  title: string;
  status: PullStatus;
  agent: string;
  entries: number;
  tools: number;
  prompt: string | null;
  kinds: RunKind[];
  runs: number;
  costUsd: number | null;
  active: boolean;
  startedAt: string;
  lastAt: string;
};

export type SessionFilter = { kind?: RunKind; outcome?: PullStatus; number?: number };

export type SessionView = {
  pull: Pull;
  entries: SessionEntry[];
  runs: AgentRun[];
  costUsd: number | null;
};

export interface AgentsApi {
  /** For the runner: records a sandbox it is starting. */
  openRun(input: OpenRunInput): Promise<Result<AgentRunTicket>>;
  /** For the runner: ends a run when its sandbox stops. Refused once it has ended. */
  closeRun(runId: string, token: string, outcome: "succeeded" | "failed", error?: string): Promise<Result<AgentRunStatus>>;
  listRuns(viewer: Viewer, filter: RunFilter): Promise<Result<AgentRun[]>>;
  getRun(viewer: Viewer, repo: RepoPath, id: string): Promise<Result<AgentRun>>;
  listSessions(viewer: Viewer, repo: RepoPath, filter?: SessionFilter): Promise<Result<SessionSummary[]>>;
  getSession(viewer: Viewer, repo: RepoPath, number: number): Promise<Result<SessionView>>;
}

/** The runs and sessions methods of the work service. */
export function agentsClient(service: ServiceBinding): AgentsApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    openRun: (input) => call("open_run", input),
    closeRun: (runId, token, outcome, error) => call("report_run", { runId, token, outcome, error }),
    listRuns: (viewer, filter) => call("list_runs", { viewer, ...filter }),
    getRun: (viewer, repo, id) => call("get_run", { viewer, repo, id }),
    listSessions: (viewer, repo, filter = {}) => call("list_sessions", { viewer, repo, ...filter }),
    getSession: (viewer, repo, number) => call("get_session", { viewer, repo, number }),
  };
}
