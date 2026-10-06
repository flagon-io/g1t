/**
 * `@g1t` in comments, and rules that put g1t to work by
 * itself. Kept by the work service; mirrors `services/work/src/mentions.rs`.
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { LifecycleJob, PullStatus } from "./work";

/** How g1t's agent is mentioned in a comment. */
export const AGENT_HANDLE = "@g1t";

/** What someone who mentioned `@g1t` wants. */
export type MentionIntent = "work" | "question" | "review";

/** What the runner needs to act on a comment that mentioned `@g1t`. */
export type MentionJob = {
  commentId: string;
  /** Who wrote it, with the memberships they had then. */
  actor: User;
  repo: RepoPath;
  number: number;
  /** The comment as written. */
  body: string;
  intent: MentionIntent;
  /** Whether they belong to the repository's workspace. */
  member: boolean;
  defaultBranch: string;
  /** Set when the comment is on an issue: whether it is still open. */
  issueOpen: boolean | null;
  /** On an issue: the pull request g1t is already working on for it, if any. */
  workingPull: number | null;
  /** Set when the comment is on a pull request. */
  pull: {
    id: string;
    status: PullStatus;
    /** Made by g1t, which sees it through. */
    agentAuthored: boolean;
    /** Where its change is: its fork, or the repository itself. */
    source: RepoPath;
    /** The head is a branch of the repository itself, not a fork. */
    inRepo: boolean;
    branch: string | null;
    headCommit: string | null;
    files: string[];
  } | null;
};

/** A repository's rules for putting g1t to work by itself. */
export type AgentRules = {
  /** When an issue is given this label, g1t takes it. */
  label: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export interface MentionsApi {
  /** For the runner: claims a comment's mention, once. Null when there is none to take. */
  takeMention(commentId: string): Promise<MentionJob | null>;
  /** For the runner: sends the author of a g1t pull request back to address the comment. */
  mentionRevision(commentId: string): Promise<Result<LifecycleJob>>;
  /** For the runner: says something in the mention's thread as g1t, once. */
  replyMention(commentId: string, body: string): Promise<boolean>;
  getAgentRules(repo: RepoPath, viewer: Viewer): Promise<Result<AgentRules>>;
  /** Members only. A null or empty label turns the rule off. */
  setAgentRules(actor: User, repo: RepoPath, rules: { label: string | null }): Promise<Result<AgentRules>>;
}

/** The mention and rule methods of the work service. */
export function mentionsClient(service: ServiceBinding): MentionsApi {
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
    takeMention: (commentId) => call("take_mention", { commentId }),
    mentionRevision: (commentId) => call("mention_revision", { commentId }),
    replyMention: (commentId, body) => call("reply_mention", { commentId, body }),
    getAgentRules: (repo, viewer) => call("get_agent_rules", { repo, viewer }),
    setAgentRules: (actor, repo, rules) => call("set_agent_rules", { actor, repo, label: rules.label }),
  };
}
