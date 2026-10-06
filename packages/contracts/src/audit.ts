/**
 * Run credentials and the audit log. Mirrors `crates/contracts/src/credentials.rs`
 * and `crates/contracts/src/audit.rs`.
 *
 * Every sandbox run gets its own tokens, bound to the run, its repository
 * and what its kind of work needs, and acting as an agent on behalf of the
 * person who started the work. Everything done with them is recorded in
 * the workspace's audit log, with the rule that allowed or refused it.
 */

import type { ServiceBinding } from "./clients";
import type { RepoPath } from "./repos";
import type { User } from "./identity";

/** What a run does, as far as its credentials are concerned. */
export type RunCredentialKind =
  | "implement"
  | "revise"
  | "review"
  | "answer"
  | "update"
  | "plan"
  | "checks"
  | "queue"
  | "mergecheck"
  | "deploy";

/**
 * `runner`: g1t's runner in the sandbox, which clones, pushes and records
 * the session, acting downstream as the person. `tools`: the agent's own
 * MCP tools, acting as the agent.
 */
export type CredentialUse = "runner" | "tools";

/** A repository a run may push to; `branch` null means any branch of it. */
export type GitGrant = { repo: RepoPath; branch?: string | null };

/** What binds an agent's token to one run. */
export type RunBinding = {
  kind: RunCredentialKind;
  use: CredentialUse;
  runId?: string | null;
  number?: number | null;
  agent: string;
  read: RepoPath[];
  push: GitGrant[];
};

/** Set on an agent resolved from its token: the composite identity. */
export type Acting = {
  credentialId: string;
  agent: string;
  onBehalfOf: { id: string; username: string };
  scope: { repo: RepoPath; operations: string[]; run?: RunBinding };
};

export type CreateRunCredentialInput = {
  onBehalfOf: User;
  repo: RepoPath;
  kind: RunCredentialKind;
  use: CredentialUse;
  /** The pull request the run works on. */
  number?: number | null;
  /** Repositories it may clone besides those it may push to. */
  read?: RepoPath[];
  push?: GitGrant[];
  /** The run's timeout. */
  ttlSeconds: number;
  /** Defaults to `g1t-agent`. */
  agent?: string | null;
};

export type ActorKind = "person" | "agent" | "workspace" | "runner";
export type AuditOutcome = "allowed" | "denied";
/** Where it came in: the API, MCP, git, or g1t.sh's own pages. */
export type AuditSurface = "rest" | "mcp" | "git" | "web";

export type AuditEntry = {
  id: string;
  /** RFC 3339. */
  time: string;
  actorKind: ActorKind;
  /** A person's username, the agent's name, or a workspace's slug. */
  actor: string;
  actorId: string;
  agent: string | null;
  /** The person an agent acted for. */
  onBehalfOf: string | null;
  runId: string | null;
  runKind: string | null;
  credentialId: string | null;
  /** An operation such as `create_issue`, or `git.push` and `git.fetch`. */
  action: string;
  surface: AuditSurface;
  workspace: string;
  /** `owner/name`. */
  repo: string | null;
  number: number | null;
  gitRef: string | null;
  path: string | null;
  outcome: AuditOutcome;
  /** The rule that allowed or refused it, such as `run:implement/tools` or `scope:repository`. */
  rule: string;
  /** `ok`, or the failure's code. */
  result: string | null;
  message: string | null;
  requestId: string;
};

/**
 * Which of a workspace's entries the viewer may see: an owner everything;
 * a member what was done to its projects, and what they did or had done
 * on their behalf.
 */
export type AuditVisibility = { kind: "all" } | { kind: "projects"; username: string };

export type AuditQuery = {
  workspace: string;
  visibility: AuditVisibility;
  actor?: string | null;
  agent?: string | null;
  action?: string | null;
  repo?: string | null;
  number?: number | null;
  outcome?: AuditOutcome | null;
  actorKind?: ActorKind | null;
  runIds?: string[];
  /** RFC 3339, inclusive. */
  since?: string | null;
  /** RFC 3339, exclusive. */
  until?: string | null;
  before?: string | null;
  /** At most 500. */
  limit?: number | null;
};

export type AuditPage = { entries: AuditEntry[]; next: string | null };

export interface AuditApi {
  /** Newest first. The caller has checked who may see the workspace's log. */
  list(query: AuditQuery): Promise<AuditPage>;
}

/** The audit log, which the events service keeps. */
export function auditClient(events: ServiceBinding): AuditApi {
  return {
    list: async (query) => {
      const response = await events.fetch("https://service/rpc/audit_list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      });
      if (!response.ok) throw new Error(`audit_list failed with status ${response.status}`);
      return (await response.json()) as AuditPage;
    },
  };
}

/** How an actor is shown: "g1t-agent on behalf of syntaqx". */
export function describeActor(entry: Pick<AuditEntry, "actor" | "agent" | "onBehalfOf">): string {
  return entry.onBehalfOf ? `${entry.agent ?? entry.actor} on behalf of ${entry.onBehalfOf}` : entry.actor;
}
