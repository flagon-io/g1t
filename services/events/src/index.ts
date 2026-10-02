import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type EventQuery,
  type EventsApi,
  type G1tEvent,
  type NewEvent,
  newId,
} from "@g1t/contracts";

export interface EventsEnv {
  DB: D1Database;
  BUS: Queue<G1tEvent>;
  /** Every `SUBSCRIBER_*` binding is a queue that receives all events. */
  [subscriber: `SUBSCRIBER_${string}`]: Queue<G1tEvent>;
}

type EventRow = {
  id: string;
  type: string;
  source: string;
  time: number;
  repo_id: string | null;
  actor: string | null;
  data: string;
};

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function toEvent(row: EventRow): G1tEvent {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    time: row.time,
    repoId: row.repo_id,
    actor: row.actor,
    data: JSON.parse(row.data),
  } as G1tEvent;
}

/**
 * The event bus. Publishing enqueues; the queue consumer below writes the
 * durable log and fans each batch out to every subscriber's own queue.
 */
export default class EventsService
  extends WorkerEntrypoint<EventsEnv>
  implements EventsApi
{
  async publish(events: NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    const now = Date.now();
    await this.env.BUS.sendBatch(
      events.map((event) => ({
        body: { ...event, id: newId("evt", now), time: now } as G1tEvent,
      })),
    );
  }

  /** Callers must have checked that the viewer may see `query.repoId`. */
  async list(query: EventQuery): Promise<G1tEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.repoId) {
      where.push("repo_id = ?");
      params.push(query.repoId);
    }
    if (query.types?.length) {
      where.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      params.push(...query.types);
    }
    if (query.before) {
      where.push("id < ?");
      params.push(query.before);
    }
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ?`,
    )
      .bind(...params, limit)
      .all<EventRow>();
    return results.map(toEvent);
  }

  async queue(batch: MessageBatch<G1tEvent>): Promise<void> {
    const events = batch.messages.map((message) => message.body);
    const insert = this.env.DB.prepare(
      // Redelivered batches must not duplicate log rows.
      `INSERT OR IGNORE INTO events (id, type, source, time, repo_id, actor, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    await this.env.DB.batch(
      events.map((event) =>
        insert.bind(
          event.id,
          event.type,
          event.source,
          event.time,
          event.repoId,
          event.actor,
          JSON.stringify(event.data),
        ),
      ),
    );

    const subscribers = Object.entries(this.env)
      .filter(([name]) => name.startsWith("SUBSCRIBER_"))
      .map(([, queue]) => queue as Queue<G1tEvent>);
    await Promise.all(
      subscribers.map((queue) =>
        queue.sendBatch(events.map((event) => ({ body: event }))),
      ),
    );
  }
}
