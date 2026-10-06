/**
 * Agents at work and what they remember, kept by the work service. Mirrors
 * `g1t_contracts::agents`.
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { Confidence, Pull, PullStatus, SessionEntry } from "./work";

/** The work a run does. checks, queue and mergecheck run commands, not a model. */
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

/** Whether a message reaches the agent while it runs, at its next step. */
export function takesMessages(kind: RunKind): boolean {
  return kind === "implement" || kind === "revise" || kind === "answer";
}

export function isAgentKind(kind: RunKind): boolean {
  return kind !== "checks" && kind !== "queue" && kind !== "mergecheck";
}

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
  /** How sure g1t was of the change as this run left it, for a run that made or revised one. */
  confidence?: Confidence | null;
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

export type MemoryScope = "project" | "workspace";
export type MemoryKind = "fact" | "convention" | "decision" | "gotcha";
export const MEMORY_KINDS: MemoryKind[] = ["fact", "convention", "decision", "gotcha"];

export type MemorySource = {
  /** `person`, `agent` or `run`; for captured memory `review`, `pr` or `doc` too (see `./context`). */
  kind: string;
  runId: string | null;
  repo: RepoPath | null;
  number: number | null;
  /** What it was captured from: `run:<id>`, `comment:<id>`, `pull:<repo id>#<n>`, `doc:<repo id>:<path>`. */
  reference?: string | null;
  /** What it was learned from, quoted. */
  evidence?: string | null;
};

/** Kept memories are given to agents; candidates wait for review; dismissed ones are never suggested again. */
export type MemoryStatus = "candidate" | "kept" | "dismissed";

export type Memory = {
  id: string;
  scope: MemoryScope;
  workspace: string;
  repo: RepoPath | null;
  text: string;
  kind: MemoryKind;
  source: MemorySource;
  createdBy: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Absent from services that predate capture: `kept`. */
  status?: MemoryStatus;
  /** 0 to 1: how sure its source was. Null for what people wrote. */
  confidence?: number | null;
  /** How many independent sources said it. */
  seen?: number;
};

export type Memories = { project: Memory[]; workspace: Memory[] };

export type NewMemory = {
  scope: MemoryScope;
  repo?: RepoPath | null;
  text: string;
  kind?: MemoryKind;
  pinned?: boolean;
};

export type MemoryChange = { text?: string; kind?: MemoryKind; pinned?: boolean };

export interface AgentsApi {
  /** For the runner: records a sandbox it is starting. */
  openRun(input: OpenRunInput): Promise<Result<AgentRunTicket>>;
  /** For the runner: ends a run when its sandbox stops. Refused once it has ended. */
  closeRun(runId: string, token: string, outcome: "succeeded" | "failed", error?: string): Promise<Result<AgentRunStatus>>;
  /** Marks a run stopped and says where its sandbox is. Members only. */
  stopRun(actor: User, repo: RepoPath, id: string): Promise<Result<{ run: AgentRun; sandbox: string }>>;
  listRuns(viewer: Viewer, filter: RunFilter): Promise<Result<AgentRun[]>>;
  getRun(viewer: Viewer, repo: RepoPath, id: string): Promise<Result<AgentRun>>;
  listSessions(viewer: Viewer, repo: RepoPath, filter?: SessionFilter): Promise<Result<SessionSummary[]>>;
  getSession(viewer: Viewer, repo: RepoPath, number: number): Promise<Result<SessionView>>;
  listMemories(viewer: Viewer, workspace: string, repo?: RepoPath | null): Promise<Result<Memories>>;
  addMemory(actor: User, workspace: string, memory: NewMemory): Promise<Result<Memory>>;
  updateMemory(actor: User, workspace: string, id: string, change: MemoryChange): Promise<Result<Memory>>;
  deleteMemory(actor: User, workspace: string, id: string): Promise<Result<boolean>>;
  /**
   * For the runner: what to tell an agent starting in `repo`, marked used.
   * `requester` is the person the run acts for: one who is not a member of
   * the workspace (an outside collaborator) is given the project's memory
   * only, never the workspace's.
   */
  memoryContext(repo: RepoPath, budget?: number, requester?: User | null): Promise<{ text: string | null; count: number }>;
  /** For the runner: agent runs the workspace has queued or running, for its plan's cap. */
  activeAgents(workspace: string): Promise<number>;
  /** For the runner: what an issue's agents have spent; `number` may be one of its pull requests. */
  issueSpend(repo: RepoPath, number: number): Promise<Result<IssueSpend>>;
  /** For the runner: gives back a lifecycle step it could not start for want of a slot. */
  waitForSlot(pullId: string, reason: string): Promise<boolean>;
  /** For the runner: a comment from g1t on an issue or pull request. */
  agentComment(repo: RepoPath, number: number, body: string): Promise<boolean>;
  /** For the runner: a run a person asked for, waiting for a slot. */
  addWait(workspace: string, kind: string, payload: unknown): Promise<Result<boolean>>;
  waitingWorkspaces(): Promise<string[]>;
  /** The oldest run waiting in a workspace, taken out of the queue. */
  takeWait(workspace: string): Promise<AgentWait | null>;
  /** What a run's model cost, in dollars, with the run's token. */
  runCost(runId: string, token: string): Promise<number | null>;
}

/** What an issue's agents have spent so far. Mirrors `IssueSpend` in agents.rs. */
export type IssueSpend = { issue: number; spentMicros: number };

/** A run waiting for one of its workspace's agent slots. */
export type AgentWait = { id: string; workspace: string; kind: string; payload: unknown; createdAt: string };

/** The agents and memory methods of the work service. */
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
    stopRun: (actor, repo, id) => call("stop_run", { actor, repo, id }),
    listRuns: (viewer, filter) => call("list_runs", { viewer, ...filter }),
    getRun: (viewer, repo, id) => call("get_run", { viewer, repo, id }),
    listSessions: (viewer, repo, filter = {}) => call("list_sessions", { viewer, repo, ...filter }),
    getSession: (viewer, repo, number) => call("get_session", { viewer, repo, number }),
    listMemories: (viewer, workspace, repo) => call("list_memories", { viewer, workspace, repo: repo ?? null }),
    addMemory: (actor, workspace, memory) =>
      call("add_memory", { actor, workspace, repo: memory.repo ?? null, scope: memory.scope, text: memory.text, kind: memory.kind ?? "fact", pinned: memory.pinned ?? false }),
    updateMemory: (actor, workspace, id, change) => call("update_memory", { actor, workspace, id, ...change }),
    deleteMemory: (actor, workspace, id) => call("delete_memory", { actor, workspace, id }),
    memoryContext: (repo, budget, requester) => call("memory_context", { repo, budget, requester: requester ?? null }),
    activeAgents: (workspace) => call("active_agents", { workspace }),
    issueSpend: (repo, number) => call("issue_spend", { repo, number }),
    waitForSlot: (pullId, reason) => call("wait_for_slot", { pullId, reason }),
    agentComment: (repo, number, body) => call("agent_comment", { repo, number, body }),
    addWait: (workspace, kind, payload) => call("add_wait", { workspace, kind, payload }),
    waitingWorkspaces: () => call("waiting_workspaces", {}),
    takeWait: (workspace) => call("take_wait", { workspace }),
    runCost: (runId, token) => call("run_cost", { runId, token }),
  };
}
