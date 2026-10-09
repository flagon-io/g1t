/**
 * Every state change in g1t is published as an event. Services react to
 * each other through events rather than direct calls, and the same stream
 * feeds timelines, webhooks and workflows.
 *
 * The envelope follows CloudEvents: `type` says what happened, `subject`
 * says to what, `data` is the type-specific payload.
 */

import type { Release } from "./about";
import type { RepoRole } from "./access";
import type { CheckRunEventData, CheckSuiteEventData, StatusEventData } from "./checks";
import type { DeploymentStatus, RepoDeployment } from "./deployments";
import type { TeamRole, TeamVisibility } from "./teams";
import type { AgentRef, Confidence, Verdict } from "./work";

/** What every `package.*` event names. */
export type PackageEventData = {
  packageId: string;
  workspace: string;
  ecosystem: string;
  name: string;
  repoId: string | null;
};

/** What `deployment.succeeded` and `deployment.failed` carry. */
export type DeploymentEventData = {
  deploymentId: string;
  projectId: string;
  repoId: string;
  workspace: string;
  project: string;
  kind: "production" | "preview";
  branch: string | null;
  number: number | null;
  commit: string;
  path: string;
  error: string | null;
  recovered: boolean;
  /** A username, or `g1t`. */
  triggeredBy: string;
};

/** What every `release.*` event carries. */
export type ReleaseEventData = {
  releaseId: string;
  repoId: string;
  tagName: string;
  release: Release;
  /** On `release.edited`: what the title and notes were before. */
  changes?: { name?: { from: string | null }; body?: { from: string } };
  /** Set when a workflow job's token made the change: the run's id. */
  causedByJob?: string;
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
/** A team asked to review a pull request. */
export type TeamRequested = { team: string; notified: string[]; assigned: string[] };

/** The payload of the `team.*` events; each sets the fields that apply. */
export type TeamChangedData = {
  workspace: string;
  teamId: string;
  team: string;
  name: string;
  visibility: TeamVisibility | null;
  parent?: string;
  changes?: string[];
  username?: string;
  role?: TeamRole;
  previousRole?: TeamRole;
  repoId?: string;
  repo?: string;
  repoRole?: RepoRole;
  previousRepoRole?: RepoRole;
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
  /**
   * An account was deleted, by the person or by g1t's staff; staff can
   * restore it until `purgeAfter`. Its sessions, tokens and keys have ended
   * and it has left every workspace. Services stop what they do for it and
   * keep their rows; `user.restored` undoes that, and `user.deleted` follows
   * once `purgeAfter` passes.
   */
  "user.deleting": { userId: string; username: string; byStaff: boolean; purgeAfter: string };
  /** Staff brought a deleted account back. Services undo what they did on `user.deleting`. */
  "user.restored": { userId: string; username: string };
  /**
   * An account is gone for good. Services drop what they keep for it alone
   * and show what it wrote as `ghost` (`GHOST_USERNAME`, `GHOST_ID`).
   * Ledgers, invoices and audit logs keep its username, which is never given
   * to anyone again.
   */
  "user.deleted": { userId: string; username: string };
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
  /**
   * `before` is where the ref pointed before; absent for a new branch or
   * tag. `causedByJob` is set when a workflow job's token pushed: the run's id.
   */
  "git.push": { repoId: string; ref: string; before?: string; after: string; defaultBranch: boolean; causedByJob?: string };
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
  /** The people an issue is assigned to changed; `assignees` is the new set, `added` those newly assigned. */
  "issue.assigned": { issueId: string; repoId: string; number: number; assignees: string[]; added?: string[] };
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
  /** A closed pull request was opened again. `commit` is its head. */
  "pull.reopened": { pullId: string; repoId: string; number: number; issue?: number; commit?: string; confidence?: Confidence };
  /** A pull request that was ready for review was turned back into a draft. */
  "pull.converted_to_draft": { pullId: string; repoId: string; number: number; issue?: number; confidence?: Confidence };
  /** People were assigned to a pull request: `assignees` is the new set, `added` those newly assigned. */
  "pull.assigned": { pullId: string; repoId: string; number: number; issue?: number; assignees: string[]; added: string[] };
  /** Reviewers were asked for a pull request (`reviewers`), or no longer are. */
  "pull.review_requested": {
    pullId: string;
    repoId: string;
    number: number;
    issue?: number;
    reviewers?: string[];
    /** Teams asked: `team` is `workspace/slug`, `notified` who is told, `assigned` who review assignment picked. */
    teams?: TeamRequested[];
    /** Asked because they own files it changes (its CODEOWNERS file). */
    codeOwners?: boolean;
  };
  "pull.review_request_removed": {
    pullId: string;
    repoId: string;
    number: number;
    issue?: number;
    reviewers?: string[];
    teams?: TeamRequested[];
  };
  /** g1t stopped seeing a pull request through until a person steps in; `detail` says why. */
  "pull.stalled": { pullId: string; repoId: string; number: number; issue?: number; detail: string };
  /** A pull request g1t had stopped on is going again. */
  "pull.resumed": { pullId: string; repoId: string; number: number; issue?: number };
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
  /** A status was set on a commit through the API. */
  "status.created": StatusEventData;
  /** A check run was reported on a commit through the API, completed, asked to run again, or had one of its buttons pressed (`requestedAction`). */
  "check_run.created": CheckRunEventData;
  "check_run.completed": CheckRunEventData;
  "check_run.rerequested": CheckRunEventData;
  "check_run.requested_action": CheckRunEventData;
  /** A reporter's check runs on a commit all completed, or it was asked to run them again. */
  "check_suite.completed": CheckSuiteEventData;
  "check_suite.rerequested": CheckSuiteEventData;
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
  /** A team of a workspace was created, changed (`changes` says what) or deleted. */
  "team.created": TeamChangedData;
  "team.edited": TeamChangedData;
  "team.deleted": TeamChangedData;
  /** Someone joined a team, had their role in it changed, or left it. */
  "team.member_added": TeamChangedData;
  "team.member_role_changed": TeamChangedData;
  "team.member_removed": TeamChangedData;
  /** A team was given a role on a repository, had it changed, or lost it. */
  "team.repo_added": TeamChangedData;
  "team.repo_role_changed": TeamChangedData;
  "team.repo_removed": TeamChangedData;
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
    /**
     * Set when one of the workspace's agents wrote it, as itself; the
     * event's actor is then the person it acted for (`actingFor`).
     */
    agent?: AgentRef;
    actingFor?: { id: string; username: string };
    /** An agent's review: its verdict is advisory and counts toward nothing. */
    advisory?: boolean;
  };
  /** A comment's text changed; `changes.body.from` is what it said before. */
  "comment.edited": {
    commentId: string;
    repoId: string;
    number: number;
    /** Set when the comment is on a pull request. */
    pullId?: string;
    changes: { body: { from: string } };
  };
  /** A comment was deleted; `comment` is the comment as it was. */
  "comment.deleted": {
    commentId: string;
    repoId: string;
    number: number;
    /** Set when the comment was on a pull request. */
    pullId?: string;
    comment: {
      id: string;
      body: string;
      author: { id: string; username: string };
      createdAt: string;
      path: string | null;
      line: number | null;
    };
  };
  "session.appended": { pullId: string; repoId: string; number: number; count: number };
  /**
   * A build of a project finished, for production or one pull request's
   * preview (`number`). `path` is the deployment's page on the site;
   * `recovered`, on a success, says the build before it failed.
   */
  "deployment.succeeded": DeploymentEventData;
  "deployment.failed": DeploymentEventData;
  /**
   * A deployment was made, wherever it runs: reported through the API, by
   * a g1t Actions job with an `environment:`, or a g1t.page build. Its
   * `payload` is left out: read the deployment for it.
   */
  "deployment.created": { repoId: string; deployment: Omit<RepoDeployment, "payload">; causedByJob?: string };
  /**
   * A deployment has a new status; `deployment` is as it is now.
   * `causedByJob` (as on every event a workflow job's token causes) is the
   * run whose job made it, so no workflow starts for it.
   */
  "deployment_status.created": {
    repoId: string;
    deployment: Omit<RepoDeployment, "payload">;
    deploymentStatus: DeploymentStatus;
    causedByJob?: string;
  };
  /**
   * A release changed, one event per GitHub release activity it amounts
   * to: made (`created`; a published one is also `published`, and
   * `released` or `prereleased`), a draft published, edited, made a draft
   * again (`unpublished`) or deleted. `release` is as it is now (as it was,
   * for `release.deleted`).
   */
  "release.created": ReleaseEventData;
  "release.published": ReleaseEventData;
  "release.released": ReleaseEventData;
  "release.prereleased": ReleaseEventData;
  "release.edited": ReleaseEventData;
  "release.unpublished": ReleaseEventData;
  "release.deleted": ReleaseEventData;
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
  /**
   * Docs (services/docs): a page was made. Published with no `repoId`, so
   * a page (which may be in a private space) never reaches a repository's
   * timeline or webhooks; `actor` is the user's or agent's id. Readers
   * check access with the docs service before showing anything of it.
   */
  "doc.page.created": DocPageEventData;
  /**
   * A page's content changed: at most once per page every ten minutes of
   * editing (when its history records a version), and for every agent
   * edit, accepted suggestion and restore. `authors` are member keys
   * (`user:<id>`, `agent:<id>`) of everyone whose changes are in it.
   */
  "doc.page.updated": DocPageEventData & { versionId: string; kind: "edit" | "agent" | "suggestion" | "restore"; authors: string[] };
  /** A page went to the trash (with every page under it; one event for the page asked about). */
  "doc.page.archived": DocPageEventData;
  /**
   * A page became possibly out of date: a merged pull request or a push to
   * a repository's default branch changed code it cites. `repoId` is in
   * `data`, not on the event, for the same reason as above. `owners` are
   * member keys; an agent that owns the page can update it
   * (`stalePagesForAgent` in docs.ts).
   */
  "doc.page.stale": DocPageEventData & { repoId: string; repo: string; commit: string; pull: number | null; paths: string[]; owners: string[] };
};

/** What every `doc.page.*` event carries. */
export type DocPageEventData = {
  workspace: string;
  workspaceId: string;
  pageId: string;
  spaceId: string;
  title: string;
  /** The page's address on the site. */
  path: string;
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
  /** Only events by this account id. */
  actor?: string;
  /** Only events about these issues or pull requests (`number`, or the `issue` a comment or review is on). */
  numbers?: number[];
  /** Only events at or after this RFC 3339 time. */
  since?: string;
  limit?: number;
};

/** The event bus and its durable log. */
export interface EventsApi {
  publish(events: NewEvent[]): Promise<void>;
  /** Newest first. */
  list(query: EventQuery): Promise<G1tEvent[]>;
}
