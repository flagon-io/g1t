/**
 * Starting work on a work item in a session on the person's own Claude.
 * Mirrors `crates/contracts/src/agent_sessions.rs` (the integrations
 * service's `start_agent_session`, `agent_sessions_setup`,
 * `sync_agent_session`, `agent_session_link`, `stop_agent_session`,
 * `agent_session_approvals`, `answer_agent_session`,
 * `message_agent_session` and `follow_agent_session`).
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { WorkSession } from "./work";

/** What kind of work a session is asked for. */
export type AgentMode = "plan" | "implement" | "review";

export const AGENT_MODES: { mode: AgentMode; label: string; hint: string }[] = [
  { mode: "implement", label: "Implement", hint: "Make the change and open a pull request." },
  { mode: "plan", label: "Plan", hint: "Work out how, and report the plan. No code." },
  { mode: "review", label: "Review", hint: "Review the work item's pull request." },
];

/** What `start_agent_session` started, or the hand-off to run. */
export type AgentSessionStarted = {
  /** The work item it works on, by number in the workspace: for a pull request with none, its number; 0 for one asked from Chat, on none. */
  item: number;
  /** The pull request it carries on with, when it was started on one. */
  pull?: number | null;
  session: WorkSession | null;
  sessionUrl: string | null;
  provider: string | null;
  providerSessionId: string | null;
  providerSessionUrl: string | null;
  handoff: boolean;
  command: string | null;
  prompt: string;
};

/** Whether sessions can start on the workspace's Anthropic account. */
export type AgentSessionsSetup = {
  available: boolean;
  connectionName: string | null;
  model: string | null;
  problem: string | null;
};

/** What to start: a work item, a new one from a title and body, or what someone asked in Chat. */
export type StartAgentSessionInput = {
  item?: number;
  title?: string;
  body?: string;
  instruction?: string;
  /**
   * Without `item` or `title`: what someone asked in Chat's New, as they
   * wrote it. The session works in the repository on that, tied to no
   * work item, and none is opened for it. At most `MAX_PROMPT_CHARS`.
   */
  prompt?: string;
  mode?: AgentMode;
  /** true: the Claude Code hand-off only; false: a session on the workspace's account, or a refusal. */
  handoff?: boolean;
};

/**
 * How long a hosted session's tool call waits for someone to allow or deny
 * it before g1t declines it (`APPROVAL_WAIT_MS` in the Rust contracts).
 */
export const APPROVAL_WAIT_MS = 10 * 60 * 1000;

/** The most characters of a message sent to a running session. */
export const MAX_SESSION_MESSAGE_CHARS = 4000;

/** The most characters of what someone asks a new session in Chat (`MAX_PROMPT_CHARS` in the Rust contracts). */
export const MAX_PROMPT_CHARS = 8000;

/**
 * The least time between two reads of a running hosted session from
 * Anthropic for the pages following it, however many there are
 * (`FOLLOW_EVERY_MS` in the Rust contracts).
 */
export const FOLLOW_EVERY_MS = 2000;

/** Where a hosted session stands for a page following it (`follow_agent_session`). */
export type AgentSessionFollowed = {
  /** Whether it still goes. */
  running: boolean;
  /** How far it was read: changes whenever anything new was read, or it ended. */
  mark: string;
  /**
   * Asked with `waiting` (g1t's card for it in Chat): whether a call of it
   * waits, in time, for an approval the viewer may answer. False otherwise,
   * and once it ended.
   */
  waiting: boolean;
};

/** Where a call that waited for approval stands. */
export type ApprovalStatus = "waiting" | "allowed" | "denied" | "expired" | "ended";

/** An answer to a call that waits for approval. */
export type ApprovalAnswer = "allow" | "deny";

/**
 * A tool call of a hosted session that waits for someone to allow or deny
 * it. What it would do is one line, as the transcript shows a call, with
 * secrets hidden; never its whole input.
 */
export type AgentApproval = {
  /** The g1t session at the top of its tree. */
  sessionId: string;
  /** `owner/name`. */
  repo: string;
  item: number | null;
  /** The call's id with the provider: what an answer names. */
  toolUseId: string;
  tool: string;
  summary: string;
  status: ApprovalStatus;
  /** Who started the session (username). */
  startedBy: string;
  answeredBy: string | null;
  askedAt: string;
  /** When g1t declines it if nobody answers. */
  expiresAt: string;
};

/** The integrations service's methods for sessions on a workspace's Anthropic account. */
export interface AgentSessionsApi {
  setup(workspace: string, viewer: Viewer): Promise<Result<AgentSessionsSetup>>;
  start(actor: User, repo: RepoPath, input: StartAgentSessionInput): Promise<Result<AgentSessionStarted>>;
  /** Reads the session now (it is otherwise followed every minute). Whether it is still going. */
  sync(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<boolean>>;
  /**
   * For a page following a running session: reads it from Anthropic when
   * nobody did in the last `FOLLOW_EVERY_MS`, and says whether it goes and
   * how far it was read; with `waiting`, also whether a call of it waits on
   * the viewer's approval.
   */
  follow(repo: RepoPath, id: string, viewer: Viewer, waiting?: boolean): Promise<Result<AgentSessionFollowed>>;
  /** Where it opens on the Claude Console. Only whoever started it is told. */
  link(actor: User, repo: RepoPath, id: string): Promise<Result<string>>;
  /** Interrupts it and ends its record. Only whoever started it. */
  stop(actor: User, repo: RepoPath, id: string): Promise<Result<boolean>>;
  /**
   * The calls waiting for approval in the workspace's hosted sessions that
   * the viewer may answer, newest first; with `session`, that session's only.
   * Whoever started a session may answer it, and so may the workspace's
   * members with write access to its repository.
   */
  approvals(viewer: Viewer, workspace: string, session?: string): Promise<Result<AgentApproval[]>>;
  /**
   * Allows or denies a call that waits for approval. Refused once the session
   * ended, the call waited its time out, or someone else answered it.
   */
  answer(actor: User, repo: RepoPath, id: string, toolUseId: string, answer: ApprovalAnswer, note?: string): Promise<Result<AgentApproval>>;
  /** Sends a running session a message, as its next instruction. */
  message(actor: User, repo: RepoPath, id: string, text: string): Promise<Result<boolean>>;
}

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function agentSessionsClient(service: ServiceBinding): AgentSessionsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    setup: (workspace, viewer) => call("agent_sessions_setup", { workspace, viewer }),
    start: (actor, repo, input) =>
      call("start_agent_session", {
        actor,
        repo,
        item: input.item ?? null,
        title: input.title ?? null,
        body: input.body ?? null,
        instruction: input.instruction ?? null,
        prompt: input.prompt ?? null,
        mode: input.mode ?? null,
        handoff: input.handoff ?? null,
      }),
    sync: (repo, id, viewer) => call("sync_agent_session", { repo, id, viewer }),
    follow: (repo, id, viewer, waiting = false) => call("follow_agent_session", { repo, id, viewer, waiting }),
    link: (actor, repo, id) => call("agent_session_link", { actor, repo, id }),
    stop: (actor, repo, id) => call("stop_agent_session", { actor, repo, id }),
    approvals: (viewer, workspace, session) => call("agent_session_approvals", { viewer, workspace, session: session ?? null }),
    answer: (actor, repo, id, toolUseId, answer, note) => call("answer_agent_session", { actor, repo, id, tool_use_id: toolUseId, answer, note: note ?? null }),
    message: (actor, repo, id, text) => call("message_agent_session", { actor, repo, id, text }),
  };
}
