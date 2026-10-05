/**
 * Every state change in g1t is published as an event. Services react to
 * each other through events rather than direct calls, and the same stream
 * feeds timelines, webhooks and workflows.
 *
 * The envelope follows CloudEvents: `type` says what happened, `subject`
 * says to what, `data` is the type-specific payload.
 */

import type { Verdict } from "./work";
export type EventPayloads = {
  "repo.created": { repoId: string; namespace: string; name: string; isPrivate: boolean };
  "repo.forked": { repoId: string; sourceRepoId: string; pullId: string };
  /**
   * One branch moved by a push. `ref` is the full ref, `after` the commit it
   * points to now, and `defaultBranch` whether it is the default branch.
   */
  "git.push": { repoId: string; ref: string; after: string; defaultBranch: boolean };
  "issue.opened": { issueId: string; repoId: string; number: number; title: string };
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
  /** `issue` is the number of the issue the pull request is for. */
  "pull.opened": { pullId: string; repoId: string; number: number; issue?: number; agent: string };
  "pull.ready": { pullId: string; repoId: string; number: number; issue?: number };
  /** A push moved the head of a pull request that is ready for review. */
  "pull.updated": { pullId: string; repoId: string; number: number; issue?: number; commit: string };
  /** A merge was asked for while the pull request was behind; it has to catch up first. */
  "pull.merge_requested": { pullId: string; repoId: string; number: number; issue?: number };
  "pull.closed": { pullId: string; repoId: string; number: number; issue?: number };
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
  "pull.merged": { pullId: string; repoId: string; number: number; issue?: number; commit: string };
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
   * A workspace's slug changed from `from` to `to`. Services that store a
   * slug move their rows to the workspace's *current* slug (see
   * `currentWorkspaceSlug`), so a repeated or late delivery after a second
   * rename still lands in the right place.
   */
  "workspace.renamed": { workspaceId: string; from: string; to: string };
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
