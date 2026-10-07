/**
 * Every state change in g1t is published as an event. Services react to
 * each other through events rather than direct calls, and the same stream
 * feeds timelines, webhooks and workflows.
 *
 * The envelope follows CloudEvents: `type` says what happened, `subject`
 * says to what, `data` is the type-specific payload.
 */

import type { RepoRole } from "./access";
import type { Confidence, Verdict } from "./work";

/** What every `package.*` event names. */
export type PackageEventData = {
  packageId: string;
  workspace: string;
  ecosystem: string;
  name: string;
  repoId: string | null;
};

/** The payload of the `repo.collaborator_*` events. */
export type RepoCollaboratorData = {
  repoId: string;
  namespace: string;
  name: string;
  username: string;
  role: RepoRole | null;
  previousRole: RepoRole | null;
};
export type EventPayloads = {
  "repo.created": { repoId: string; namespace: string; name: string; isPrivate: boolean };
  "repo.forked": { repoId: string; sourceRepoId: string; pullId: string };
  /**
   * A repository's description, topics or visibility changed.
   * `visibilityChanged` says whether it went public or private, which
   * `repo.visibility_changed` also announces on its own.
   */
  "repo.updated": { repoId: string; namespace: string; name: string; isPrivate: boolean; visibilityChanged: boolean };
  "repo.visibility_changed": { repoId: string; isPrivate: boolean };
  /**
   * A repository's name changed within its workspace `namespace`, from
   * `from` to `to`, keeping its id. A path change like `repo.transferred`:
   * services move rows kept under its path to its *current* path (see
   * `repoMove`, `currentMovedPath`).
   */
  "repo.renamed": { repoId: string; namespace: string; from: string; to: string };
  /**
   * A repository was deleted. It is hidden and git refuses it, but it can
   * be restored until `purgeAfter`: services stop what runs for it and hide
   * it, and keep their rows until `repo.purged`.
   */
  "repo.deleted": {
    repoId: string;
    namespace: string;
    name: string;
    isPrivate: boolean;
    purgeAfter: string;
    /** It went with its workspace (`workspace.deleting`); deployments leaves it to that. */
    withWorkspace?: boolean;
  };
  /** A deleted repository is back, as it was. Services start again what they stopped. */
  "repo.restored": {
    repoId: string;
    namespace: string;
    name: string;
    isPrivate: boolean;
    /** It came back with its workspace (`workspace.restored`). */
    withWorkspace?: boolean;
  };
  /**
   * A deleted repository is gone for good, its git data with it. Services
   * drop every row they keep for it, except a workspace's history (ledgers,
   * invoices, the audit log).
   */
  "repo.purged": { repoId: string; namespace: string; name: string };
  /**
   * A repository was archived (read-only: pushes, merges, agents and
   * workflows refused; issues and pull requests locked; deployments keep
   * serving), or unarchived.
   */
  "repo.archived": { repoId: string; namespace: string; name: string; archived: true };
  "repo.unarchived": { repoId: string; namespace: string; name: string; archived: false };
  /** The default branch is now `to`; `renamed` when `from` was renamed to it. */
  "repo.default_branch_changed": { repoId: string; from: string; to: string; renamed: boolean };
  /** A branch was renamed. Pull requests from it follow. */
  "branch.renamed": { repoId: string; from: string; to: string; defaultBranch: boolean };
  /** An account was made, or changed what its profile shows. Ask identity for the profile. */
  "user.updated": { username: string };
  /** A workspace was made, or its name, description or icon changed. */
  "workspace.updated": { workspaceId: string; slug: string };
  /** Someone, or g1t staff, made an invite. Never the code or the address. */
  "invite.created": { inviteId: string; inviterId: string | null; workspaceId: string | null; bound: boolean };
  /** An invite was used: by a new account, or by an account joining a workspace. */
  "invite.redeemed": {
    inviteId: string;
    userId: string;
    inviterId: string | null;
    workspaceId: string | null;
    createdAccount: boolean;
  };
  /** Someone asked for access while registration is invite-only. The address is not in the event. */
  "waitlist.requested": { entryId: string };
  /**
   * One branch moved by a push. `ref` is the full ref, `after` the commit it
   * points to now, and `defaultBranch` whether it is the default branch.
   */
  /** `before` is where the ref pointed before; absent for a new branch or tag. */
  "git.push": { repoId: string; ref: string; before?: string; after: string; defaultBranch: boolean };
  /**
   * `author` is who opened it: g1t, for one its agent filed while at work,
   * with `requestedBy` the person it was working for. Every issue and pull
   * request event carries both.
   */
  "issue.opened": {
    issueId: string;
    repoId: string;
    number: number;
    title: string;
    author?: { id: string; username: string };
    requestedBy?: { id: string; username: string };
  };
  "issue.updated": { issueId: string; repoId: string; number: number };
  /** The people an issue is assigned to changed; `assignees` is the new set. */
  "issue.assigned": { issueId: string; repoId: string; number: number; assignees: string[] };
  /** `resolvedBy` is the number of the pull request whose merge closed it. */
  "issue.closed": {
    issueId: string;
    repoId: string;
    number: number;
    reason: "completed" | "not_planned";
    resolvedBy?: number;
  };
  "issue.reopened": { issueId: string; repoId: string; number: number };
  /**
   * `issue` is the number of the issue the pull request is for. `author` is
   * who opened it: g1t, for a change g1t made, with `requestedBy` the person
   * who asked for it.
   */
  "pull.opened": {
    pullId: string;
    repoId: string;
    number: number;
    issue?: number;
    agent: string;
    author?: { id: string; username: string };
    requestedBy?: { id: string; username: string };
  };
  /** `confidence`, on a g1t agent's change once g1t has worked it out, is on every pull request event. */
  "pull.ready": { pullId: string; repoId: string; number: number; issue?: number; confidence?: Confidence };
  /** A push moved the head of a pull request that is ready for review. */
  "pull.updated": { pullId: string; repoId: string; number: number; issue?: number; commit: string; confidence?: Confidence };
  /** A merge was asked for while the pull request was behind; it has to catch up first. */
  "pull.merge_requested": { pullId: string; repoId: string; number: number; issue?: number; confidence?: Confidence };
  "pull.closed": { pullId: string; repoId: string; number: number; issue?: number; confidence?: Confidence };
  /**
   * The pull request's head or its target moved and the files both changed
   * overlap: a sandbox should find out whether it still merges cleanly.
   * `commit` is its head.
   */
  "pull.mergecheck": { pullId: string; repoId: string; number: number; issue?: number; commit: string };
  /** Whether the pull request merges cleanly was settled. */
  "pull.mergeability": { pullId: string; repoId: string; number: number; issue?: number };
  /** Another agent asked the agent on a pull request, which was not at work, a question or handed it work. */
  "agent.asked": { pullId: string; repoId: string; number: number; issue?: number };
  "pull.merged": { pullId: string; repoId: string; number: number; issue?: number; commit: string; confidence?: Confidence };
  /** A run of the acceptance checks finished. `commit` is what was checked. */
  "checks.completed": {
    pullId: string;
    repoId: string;
    number: number;
    status: "passed" | "failed" | "errored";
    commit: string;
  };
  /** A g1t agent finished reviewing a pull request; no verdict if it could not. */
  "review.completed": {
    pullId: string;
    repoId: string;
    number: number;
    verdict?: "approve" | "request_changes";
  };
  /** A person was given a role on one repository directly, had it changed, or lost it. `role` is null once removed. */
  "repo.collaborator_added": RepoCollaboratorData;
  "repo.collaborator_removed": RepoCollaboratorData;
  "repo.collaborator_role_changed": RepoCollaboratorData;
  /** A repository's merge queue gained, lost or settled an entry. */
  "queue.changed": { repoId: string };
  /** `number` is the issue or pull request commented on. */
  "comment.created": {
    commentId: string;
    repoId: string;
    number: number;
    /** Set when the comment is on a pull request. */
    pullId?: string;
    /** Set when the comment is a review. */
    verdict?: Verdict;
  };
  "session.appended": { pullId: string; repoId: string; number: number; count: number };
  /**
   * A package version was published, such as an image pushed by
   * `docker push`. `tags` are the tags that now point to it; `repoId` (and
   * the event's) is the repository the package is linked to, if any.
   */
  "package.published": PackageEventData & { version: string; digest: string; size: number; tags: string[] };
  /** One version of a package was deleted, with the tags that pointed to it. */
  "package.version_deleted": PackageEventData & { version: string; digest: string };
  /** A package was deleted with every version it had. */
  "package.deleted": PackageEventData;
  /** A package became public or private. */
  "package.visibility_changed": PackageEventData & { visibility: "public" | "private" };
  /**
   * A workspace's slug changed from `from` to `to`. Services that store a
   * slug move their rows to the workspace's *current* slug (see
   * `currentWorkspaceSlug`), so a repeated or late delivery after a second
   * rename still lands in the right place.
   */
  "workspace.renamed": { workspaceId: string; from: string; to: string };
  /**
   * A repository moved from workspace `from` to `to`, keeping its id and
   * name. Services that store its path or its workspace's slug move those
   * rows to its *current* path (ask repos `path_by_id`), so a repeated or
   * late delivery after a second transfer still lands in the right place.
   */
  "repo.transferred": { repoId: string; name: string; from: string; to: string };
  /**
   * A workspace is gone. Services drop what they keep for it alone; ledgers,
   * invoices and the audit log stay under its slug, which is never reused.
   */
  "workspace.deleted": { workspaceId: string; slug: string };
  /**
   * An owner deleted a workspace; staff can restore it until `purgeAfter`,
   * and nobody can reach it meanwhile. Services hide what they keep for it
   * and stop what runs for it, keeping their rows: repos deletes its
   * repositories softly (`repo.deleted` with `withWorkspace`), deployments
   * pauses its apps, search drops it. `workspace.restored` undoes exactly
   * that; `workspace.deleted` follows once `purgeAfter` passes. `by` is the
   * owner's username.
   */
  "workspace.deleting": { workspaceId: string; slug: string; by: string; purgeAfter: string };
  /**
   * Staff brought a deleted workspace back with its members and tokens.
   * Services undo what they did on `workspace.deleting`, and only that.
   */
  "workspace.restored": { workspaceId: string; slug: string };
  /**
   * A memory was added, changed, reviewed or forgotten. No text: ask the
   * work service for it by id. `repoId` is the project's, or null for the
   * workspace's memory. `status` is `deleted` once forgotten.
   */
  "memory.changed": { memoryId: string; workspace: string; status: "candidate" | "kept" | "dismissed" | "deleted" };
  /**
   * A sandbox was stopped because it looked like it was mining: CPU pinned
   * with little I/O and no progress, or a miner seen by name. For g1t's
   * staff, in sudo; published with no `repoId` so it never reaches a
   * repository's timeline or webhooks. `metrics` is what the sandbox
   * measured (`Verdict` in crates/runner abuse.rs), or null if it could
   * not say.
   */
  "abuse.flagged": {
    workspace: string;
    repo: string | null;
    /** The agent run, when the sandbox had one. */
    run: string | null;
    /** What the sandbox was for: agent, checks, queue, actions, deploy... */
    kind: string;
    sandbox: string;
    metrics: Record<string, unknown> | null;
  };
};

export type EventType = keyof EventPayloads;

export type G1tEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    /** The service that published it. */
    source: string;
    /** RFC 3339. */
    time: string;
    /** The repo the event concerns, used to scope timelines and deliveries. */
    repoId: string | null;
    /** The user or agent that caused it, if any. */
    actor: string | null;
    data: EventPayloads[K];
  };
}[T];

/** What a publisher supplies; the bus fills in `id` and `time`. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: Omit<G1tEvent<K>, "id" | "time">;
}[T];

export type EventQuery = {
  repoId?: string;
  types?: EventType[];
  /** Return events older than this event id. */
  before?: string;
  limit?: number;
};

/** The event bus and its durable log. */
export interface EventsApi {
  publish(events: NewEvent[]): Promise<void>;
  /** Newest first. */
  list(query: EventQuery): Promise<G1tEvent[]>;
}
