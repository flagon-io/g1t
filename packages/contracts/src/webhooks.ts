import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Events, delivered to the addresses a repository or a workspace registers.
 * Mirrors `crates/contracts/src/webhooks.rs`.
 */

/** Every event a webhook can be sent, in the order people are shown them. */
export const EVENT_TYPES = [
  "git.push",
  "branch.renamed",
  "repo.created",
  "repo.forked",
  "repo.updated",
  "repo.visibility_changed",
  "repo.renamed",
  "repo.transferred",
  "repo.default_branch_changed",
  "repo.archived",
  "repo.unarchived",
  "repo.deleted",
  "repo.restored",
  "repo.purged",
  "repo.collaborator_added",
  "repo.collaborator_removed",
  "repo.collaborator_role_changed",
  "issue.opened",
  "issue.updated",
  "issue.assigned",
  "issue.closed",
  "issue.reopened",
  "comment.created",
  "pull.opened",
  "pull.ready",
  "pull.updated",
  "pull.merge_requested",
  "pull.merged",
  "pull.closed",
  "agent.asked",
  "checks.completed",
  "review.completed",
  "workflow.completed",
  "queue.changed",
  "session.appended",
  "package.published",
  "package.version_deleted",
  "package.deleted",
  "package.visibility_changed",
] as const;

export type Hook = {
  id: string;
  scope: "repo" | "workspace";
  workspace: string;
  /** For a repository's webhook: `owner/name`. */
  repo: string | null;
  url: string;
  /** Event types, or `["*"]` for all. */
  events: string[];
  active: boolean;
  secretHint: string;
  createdBy: string;
  createdAt: string;
  lastStatus: "delivered" | "pending" | "failed" | null;
  lastDeliveredAt: string | null;
};

export type HookDelivery = {
  id: string;
  hookId: string;
  eventId: string;
  event: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  /** The JSON that was sent. */
  payload: string;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

/** A repository's webhooks, or with `repo` left out, the workspace's own. */
export type HookOwner = { workspace: string; repo?: RepoPath };

export interface WebhooksApi {
  list(viewer: Viewer, owner: HookOwner): Promise<Result<Hook[]>>;
  create(
    actor: User,
    owner: HookOwner,
    input: { url: string; events?: string[]; secret?: string },
  ): Promise<Result<{ hook: Hook; secret: string | null }>>;
  update(actor: User, owner: HookOwner, id: string, input: { url?: string; events?: string[]; active?: boolean }): Promise<Result<Hook>>;
  delete(actor: User, owner: HookOwner, id: string): Promise<Result<boolean>>;
  ping(actor: User, owner: HookOwner, id: string): Promise<Result<HookDelivery>>;
  deliveries(viewer: Viewer, owner: HookOwner, id: string): Promise<Result<HookDelivery[]>>;
  redeliver(actor: User, owner: HookOwner, deliveryId: string): Promise<Result<HookDelivery>>;
}
