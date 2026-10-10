import type { AgentRun } from "./agents";
import type { Trial } from "./billing";
import type { User, Viewer } from "./identity";
import type { Result } from "./result";
import type { RepoPath } from "./repos";
import type { DelegateInput, Delegated, Plan, Pull } from "./work";

export type RunHostedInput = {
  /** Extra guidance given to the agent along with the issue. */
  instructions?: string;
};

/**
 * Sandboxes on g1t: agents that work on an issue, reviews, and the merge queue.
 *
 * Nobody who assigns a g1t agent picks a model. g1t routes each kind of
 * work itself, and says in the session which model ran.
 */
/**
 * How a workspace's agents reach a model. The workspace decides: its own
 * provider (`own` names it), or g1t's hosted models paid from its credit.
 */
export type ModelAccess = {
  /** The workspace's own model connection, by name, if it has one. */
  own: string | null;
  /** Whether g1t's hosted models are open to it, on its free allowance or otherwise. */
  hosted: boolean;
  /** Its free allowance, when that is how it reaches g1t's hosted models; null when it needs none. */
  trial: Trial | null;
  /**
   * True when hosted models are closed to it because billing takes no real
   * money yet: until then they are open only to the workspaces g1t lists,
   * and every other workspace uses its own provider.
   */
  preview: boolean;
};

/**
 * The files every g1t agent run in a repository reads as the repository's
 * instructions, as they are on its default branch.
 */
export type RepoInstructions = {
  branch: string;
  /** Null when the repository has no commits yet. */
  commit: string | null;
  files: {
    path: string;
    /** `root` is read by every run, `directory` by runs that touch files under it, `review` by reviews. */
    role: "root" | "directory" | "review";
    text: string;
    /** Longer than agents are given; they get the start of it. */
    truncated: boolean;
    lastChanged: { commit: string; message: string; author: string; at: string } | null;
  }[];
  /** How much of each file, and of all of them, an agent is given. */
  limits: { fileChars: number; totalChars: number };
};

// ── An agent's own computer ────────────────────────────────────────────────

/**
 * What an agent's computer is doing (docs.g1t.sh/guides/agents/, "Its
 * computer"): asleep with its home saved, waking (the container starting
 * and the home restored), awake and metered, or sleeping (the home being
 * saved, then the container stopped).
 */
export type AgentComputerState = "asleep" | "waking" | "awake" | "sleeping";

/** How much the home may hold in v1: a hard cap, with no disk charge. */
export const COMPUTER_DISK_CAP_BYTES = 5_000_000_000;
/** How long a computer stays awake with nothing running before it sleeps. */
export const COMPUTER_IDLE_MINUTES = 10;
/** Where an archived agent's disk is kept before it is deleted. */
export const COMPUTER_KEEP_DAYS = 30;
/** How many of the most recent commands a computer keeps for its page. */
export const COMPUTER_TRANSCRIPTS_KEPT = 50;
/** How much of one command's output a kept transcript holds. */
export const COMPUTER_TRANSCRIPT_BYTES = 64 * 1024;

/** The computer as the runner reports it. Wire shape: snake_case. */
export type AgentComputerStatus = {
  agent_id: string;
  state: AgentComputerState;
  /** RFC 3339: when it entered this state. */
  since: string;
  /** What the home holds, as last measured (live while awake; the snapshot's size while asleep). */
  disk_used_bytes: number;
  disk_cap_bytes: number;
  last_woke_at: string | null;
  last_slept_at: string | null;
  /** The saved home's size and when it was saved; null while there is none. */
  snapshot_bytes: number | null;
  snapshot_at: string | null;
  /** Where it runs. Pinning to a self-hosted runner group comes later. */
  where: "g1t_cloud";
  /** False when this installation has no object storage for homes yet: the computer works, and forgets its home when it sleeps. */
  disk_attached: boolean;
  /** Something the owner should know: the home is over its cap and could not be saved, say. */
  problem: string | null;
  /** When the disk will be deleted, after its agent was archived. */
  delete_after: string | null;
};

/** One command a computer ran, as kept for its page and the session's. */
export type AgentComputerCommand = {
  id: string;
  session_id: string | null;
  asked_by: string | null;
  started_at: string;
  cmd: string;
  cwd: string;
  exit_code: number;
  duration_ms: number;
  /** stdout and stderr lines in order, cut to `COMPUTER_TRANSCRIPT_BYTES`. */
  output: string;
  truncated: boolean;
  timed_out: boolean;
};

export type ComputerWakeArgs = {
  agent_id: string;
  workspace: string;
  /** The agent's handle, which its sandbox time is attributed to on the ledger. */
  agent_handle: string;
  /** Who asked for the session that woke it, by username; null for a routine's. */
  asked_by: string | null;
};

export type ComputerExecArgs = ComputerWakeArgs & {
  cmd: string;
  /** Under the home; the home itself when absent. */
  cwd?: string | null;
  timeout_seconds?: number | null;
  session_id?: string | null;
};

/** What `computer_exec` returns: the command as kept, in full (up to the transcript cap). */
export type ComputerExecResult = { command: AgentComputerCommand; status: AgentComputerStatus };

/** What `computer_wake` and the others return. */
export type ComputerResult<T> = Result<T>;

/**
 * The runner's side of an agent's computer, which the agents service calls
 * through its RUNNER binding (`POST /rpc/computer_*`, snake_case). One
 * Durable Object per agent, named `computer:<agent_id>`.
 */
export interface RunnerComputerApi {
  computerStatus(agentId: string): Promise<Result<AgentComputerStatus>>;
  /** Starts it (restoring the saved home) and begins the meter; `payment_required` when the workspace's plan refuses. */
  computerWake(args: ComputerWakeArgs): Promise<Result<AgentComputerStatus>>;
  /** Runs a command, waking it first if asleep. */
  computerExec(args: ComputerExecArgs): Promise<Result<ComputerExecResult>>;
  /** Reads a small file of the home as text. */
  computerReadFile(args: ComputerWakeArgs & { path: string; session_id?: string | null }): Promise<Result<{ path: string; text: string; bytes: number }>>;
  /** Writes a small file into the home. */
  computerWriteFile(args: ComputerWakeArgs & { path: string; text: string; session_id?: string | null }): Promise<Result<{ path: string; bytes: number }>>;
  /** Saves the home and stops the container; the sandbox time goes on the ledger. */
  computerSleep(agentId: string): Promise<Result<AgentComputerStatus>>;
  /** Stops it if awake, deletes the saved home and its commands. Memory and artifacts are untouched. */
  computerReset(agentId: string): Promise<Result<AgentComputerStatus>>;
  /** An archived agent's: stopped now, its disk deleted after `COMPUTER_KEEP_DAYS`. */
  computerForget(agentId: string): Promise<Result<AgentComputerStatus>>;
  /** The most recent commands, newest first; `session_id` narrows them to one session's. */
  computerCommands(agentId: string, sessionId?: string | null): Promise<Result<AgentComputerCommand[]>>;
}

export interface RunnerApi {
  /**
   * The repository's instructions for agents (`AGENTS.md`, `CLAUDE.md`,
   * `.g1t/review.md`), as they are on its default branch: what every g1t
   * agent run there reads. Whoever can see the repository may ask.
   */
  instructions(viewer: Viewer, repo: RepoPath): Promise<Result<RepoInstructions>>;
  /** How `workspace`'s agents would reach a model now. */
  modelAccess(workspace: string): Promise<ModelAccess>;
  /**
   * Whether `viewer` may put g1t's agents to work: in `repo`'s workspace,
   * or with none named, in any of theirs.
   */
  enabled(viewer: Viewer, repo?: RepoPath): Promise<boolean>;
  /**
   * Assigns the issue to a g1t agent: opens a draft pull request for it,
   * made by an agent in a sandbox of its own. Returns as soon as the
   * sandbox is starting; progress shows up in the pull request's session.
   * Scale comes from assigning many issues, each to its own agent.
   */
  run(actor: User, repo: RepoPath, issue: number, input?: RunHostedInput): Promise<Result<Pull>>;
  /**
   * Puts an agent on something in one step: opens an issue and assigns it
   * to g1t. Refused, with nothing opened, unless `actor` may put
   * agents to work in `repo` (Write). Once opened, the issue stays whatever
   * becomes of the agent: `agent` says whether it started, waits for a
   * free slot, or did not start, why and where to fix it.
   */
  delegate(actor: User, repo: RepoPath, input: DelegateInput): Promise<Result<Delegated>>;
  /**
   * Has an agent read the repository and turn an outcome into a plan: the
   * issues that would get there and the order they have to land in. Returns
   * the plan's id as soon as the sandbox is starting; the plan fills in when
   * the agent has written it. Members of the repository's workspace only.
   */
  plan(actor: User, repo: RepoPath, brief: string): Promise<Result<{ planId: string }>>;
  /**
   * Opens a plan's issues. With `assign`, a g1t agent starts on each that
   * depends on nothing, and on the others as what they depend on merges.
   */
  applyPlan(
    actor: User,
    repo: RepoPath,
    planId: string,
    options?: { assign?: boolean; keep?: number[] },
  ): Promise<Result<Plan>>;
  /**
   * Brings a pull request up to date with the branch it would merge into,
   * in a sandbox. A clean merge is pushed as it is; a conflict is resolved
   * by a g1t agent. Whoever can push to the pull request's source may ask:
   * its author, or for one from a branch, a workspace member.
   */
  update(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
  /**
   * Has a g1t agent review a pull request: line comments, a summary and a
   * verdict, posted as `g1t`.
   */
  review(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>>;
  /**
   * Stops an agent run: marks it stopped, destroys its sandbox, and leaves
   * the pull request it was on for a person. Members of the workspace only.
   */
  stopRun(actor: User, repo: RepoPath, runId: string): Promise<Result<AgentRun>>;
}
