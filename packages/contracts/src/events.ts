/**
 * Every state change in g1t is published as an event. Services react to
 * each other through events rather than direct calls, and the same stream
 * feeds timelines, webhooks and automations.
 *
 * The envelope follows CloudEvents: `type` says what happened, `subject`
 * says to what, `data` is the type-specific payload.
 */
export type EventPayloads = {
  "repo.created": { repoId: string; namespace: string; name: string; isPrivate: boolean };
  "repo.forked": { repoId: string; sourceRepoId: string; attemptId: string };
  /** `after` is the commit the ref points to once the push has landed. */
  "git.push": { repoId: string; ref: string; after: string };
  "intent.opened": { intentId: string; repoId: string; number: number; title: string };
  "intent.closed": { intentId: string; repoId: string; reason: "shipped" | "withdrawn" };
  "attempt.started": { attemptId: string; intentId: string; repoId: string; agent: string };
  "attempt.updated": { attemptId: string; intentId: string; repoId: string; status: string };
  "attempt.submitted": { attemptId: string; intentId: string; repoId: string };
  "session.appended": { attemptId: string; sessionId: string; count: number };
};

export type EventType = keyof EventPayloads;

export type G1tEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    /** The service that published it. */
    source: string;
    /** Milliseconds since the epoch. */
    time: number;
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

/** Implemented by services that consume events from the bus. */
export interface EventSubscriber {
  onEvents(events: G1tEvent[]): Promise<void>;
}
