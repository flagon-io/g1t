import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

export type IntentStatus = "open" | "shipped" | "withdrawn";

/** A goal stated against a repo. Replaces the issue and the pull request. */
export type Intent = {
  id: string;
  repoId: string;
  /** Sequential per repo, shown as `#12`. */
  number: number;
  title: string;
  /** The goal in prose: what an agent is given to work from. */
  brief: string;
  /** Commands that must pass for an attempt to be accepted. */
  checks: string[];
  status: IntentStatus;
  author: User;
  /** RFC 3339. */
  createdAt: string;
  attemptCount: number;
};

export type AttemptStatus = "working" | "submitted" | "shipped" | "abandoned";

/** Where the agent runs: on g1t's sandboxes, or in someone's own session. */
export type AttemptRuntime = "hosted" | "external";

/** One agent's run at an intent, in its own fork. */
export type Attempt = {
  id: string;
  intentId: string;
  repoId: string;
  /** Sequential per intent. */
  number: number;
  /** A label for the agent doing the work, e.g. `claude-code`. */
  agent: string;
  runtime: AttemptRuntime;
  status: AttemptStatus;
  /** The agent's own account of what it did, set on submit. */
  summary: string | null;
  fork: RepoPath;
  /** The fork's repository id. */
  forkRepoId: string;
  headCommit: string | null;
  /**
   * For a shipped attempt, what the branch pointed to before it landed.
   * Comparing against it shows what the attempt changed.
   */
  landedBase: string | null;
  startedBy: User;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339. */
  updatedAt: string;
};

export type SessionEntryKind = "prompt" | "message" | "tool_call" | "tool_result" | "note";

/** One step of an agent's session: the "why" behind an attempt's commits. */
export type SessionEntry = {
  seq: number;
  kind: SessionEntryKind;
  text: string;
  /** For tool calls and results. */
  tool: string | null;
  /** The fork's head commit when this entry was recorded, if known. */
  commit: string | null;
  /** RFC 3339. */
  at: string;
};

export type NewSessionEntry = Pick<SessionEntry, "kind" | "text"> &
  Partial<Pick<SessionEntry, "tool" | "commit">>;

export type IntentDetail = { intent: Intent; attempts: Attempt[] };

export type OpenIntentInput = { title: string; brief: string; checks?: string[] };

export type StartAttemptInput = { agent: string; runtime: AttemptRuntime };

/** Intents, attempts and sessions. */
export interface WorkApi {
  openIntent(actor: User, repo: RepoPath, input: OpenIntentInput): Promise<Result<Intent>>;
  listIntents(repo: RepoPath, viewer: Viewer, status?: IntentStatus): Promise<Result<Intent[]>>;
  getIntent(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<IntentDetail>>;
  withdrawIntent(actor: User, intentId: string): Promise<Result<Intent>>;

  /** Forks the repo for the agent and returns the attempt to push to. */
  startAttempt(actor: User, intentId: string, input: StartAttemptInput): Promise<Result<Attempt>>;
  getAttempt(attemptId: string, viewer: Viewer): Promise<Result<{ attempt: Attempt; intent: Intent }>>;
  submitAttempt(actor: User, attemptId: string, summary: string): Promise<Result<Attempt>>;
  abandonAttempt(actor: User, attemptId: string): Promise<Result<Attempt>>;
  /**
   * Lands the attempt on the repository's default branch and closes its
   * intent as shipped. Only the repository's owner may ship.
   */
  shipAttempt(actor: User, attemptId: string): Promise<Result<Attempt>>;
  /** Attempts in progress that the viewer started, newest first. */
  listActiveAttempts(viewer: Viewer): Promise<{ attempt: Attempt; intent: Intent }[]>;

  appendSession(actor: User, attemptId: string, entries: NewSessionEntry[]): Promise<Result<{ count: number }>>;
  readSession(attemptId: string, viewer: Viewer, afterSeq?: number): Promise<Result<SessionEntry[]>>;
}
