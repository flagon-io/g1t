/**
 * Starting work on an issue in a session on the person's own Claude.
 * Mirrors `crates/contracts/src/agent_sessions.rs` (the integrations
 * service's `start_agent_session`, `agent_sessions_setup`,
 * `sync_agent_session`, `agent_session_link` and `stop_agent_session`).
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
  { mode: "review", label: "Review", hint: "Review the issue's pull request." },
];

/** What `start_agent_session` started, or the hand-off to run. */
export type AgentSessionStarted = {
  issue: number;
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

/** What to start: an issue, or a new one from a title and body. */
export type StartAgentSessionInput = {
  issue?: number;
  title?: string;
  body?: string;
  instruction?: string;
  mode?: AgentMode;
  /** true: the Claude Code hand-off only; false: a session on the workspace's account, or a refusal. */
  handoff?: boolean;
};

/** The integrations service's methods for sessions on a workspace's Anthropic account. */
export interface AgentSessionsApi {
  setup(workspace: string, viewer: Viewer): Promise<Result<AgentSessionsSetup>>;
  start(actor: User, repo: RepoPath, input: StartAgentSessionInput): Promise<Result<AgentSessionStarted>>;
  /** Reads the session now (it is otherwise followed every minute). Whether it is still going. */
  sync(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<boolean>>;
  /** Where it opens on the Claude Console. Only whoever started it is told. */
  link(actor: User, repo: RepoPath, id: string): Promise<Result<string>>;
  /** Interrupts it and ends its record. Only whoever started it. */
  stop(actor: User, repo: RepoPath, id: string): Promise<Result<boolean>>;
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
        issue: input.issue ?? null,
        title: input.title ?? null,
        body: input.body ?? null,
        instruction: input.instruction ?? null,
        mode: input.mode ?? null,
        handoff: input.handoff ?? null,
      }),
    sync: (repo, id, viewer) => call("sync_agent_session", { repo, id, viewer }),
    link: (actor, repo, id) => call("agent_session_link", { actor, repo, id }),
    stop: (actor, repo, id) => call("stop_agent_session", { actor, repo, id }),
  };
}
