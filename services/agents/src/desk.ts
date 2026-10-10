/**
 * An agent's desk: one Durable Object per agent, by its id, where
 * everything addressed to it arrives.
 *
 * Two kinds of work arrive: messages to answer (replies), and sessions to
 * advance by a step. They are worked in two lanes from one alarm, each at
 * most the agent's capacity at once, so a long session step never keeps
 * the agent from answering a quick question, and a burst of messages never
 * runs more replies in parallel than the agent is allowed. Both queues live
 * in the desk's storage, so nothing handed over is lost if the object
 * moves; a session step that never finished is picked up again by the
 * sweep (sessions.ts). While it works, the agent's row says so
 * (`busy_until`), which is how the Agents page shows it as working without
 * asking every desk.
 */
import { DurableObject } from "cloudflare:workers";

import { DEFAULT_CAPACITY, MAX_CAPACITY } from "./definition.ts";
import { type DeskWork, type ReplyEnv, reply } from "./reply.ts";
import { type SessionEnv, advance } from "./sessions.ts";

/** Messages a desk holds at most; past this the oldest are dropped, as nobody is waiting on them any more. */
const MAX_QUEUE = 50;
/** Sessions waiting for a step a desk holds at most. */
const MAX_SESSIONS = 200;
/** How long a batch says the agent is working, renewed per batch. */
const BUSY_MS = 3 * 60_000;
/** How long a lane with nothing to do waits for the other before it looks again. */
const IDLE_MS = 400;

export class Desk extends DurableObject<ReplyEnv> {
  /** Queues a message for the agent and makes sure the desk is working. Returns at once. */
  async take(delivery: DeskWork): Promise<void> {
    const queue = (await this.ctx.storage.get<DeskWork[]>("queue")) ?? [];
    if (queue.some((held) => held.message_id === delivery.message_id)) return;
    queue.push(delivery);
    await this.ctx.storage.put("queue", queue.slice(-MAX_QUEUE));
    await this.ctx.storage.put("agent", delivery.agent_id);
    await this.start();
  }

  /** Queues a session for its next step. Returns at once. */
  async session(id: string, agentId: string): Promise<void> {
    const sessions = (await this.ctx.storage.get<string[]>("sessions")) ?? [];
    if (!sessions.includes(id)) sessions.push(id);
    await this.ctx.storage.put("sessions", sessions.slice(-MAX_SESSIONS));
    await this.ctx.storage.put("agent", agentId);
    await this.start();
  }

  private running = false;

  private async start(): Promise<void> {
    if (this.running) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Works both lanes until both are empty. */
  async alarm(): Promise<void> {
    this.running = true;
    const agent = (await this.ctx.storage.get<string>("agent")) ?? null;
    // A lane with nothing to do waits while the other works, since work can
    // arrive for it meanwhile; once both are idle, the alarm ends.
    const idle = [false, false];
    const lane = async (index: number, work: () => Promise<boolean>) => {
      for (;;) {
        if (await work()) {
          idle[index] = false;
          continue;
        }
        idle[index] = true;
        if (idle.every(Boolean)) break;
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      }
    };
    try {
      await Promise.all([lane(0, () => this.replies()), lane(1, () => this.steps())]);
    } finally {
      this.running = false;
      if (agent) await this.busy(agent, null);
      // Anything that arrived as the lanes closed is worked by a fresh alarm.
      if (await this.pending()) await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  private async pending(): Promise<boolean> {
    const [queue, sessions] = await Promise.all([this.ctx.storage.get<DeskWork[]>("queue"), this.ctx.storage.get<string[]>("sessions")]);
    return (queue?.length ?? 0) > 0 || (sessions?.length ?? 0) > 0;
  }

  private async capacity(agent: string): Promise<number> {
    const row = await this.env.DB.prepare("SELECT capacity FROM agents WHERE id = ?").bind(agent).first<{ capacity: number }>();
    return Math.min(MAX_CAPACITY, Math.max(1, row?.capacity ?? DEFAULT_CAPACITY));
  }

  /** One batch of replies; false when there were none. */
  private async replies(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<DeskWork[]>("queue")) ?? [];
    if (!queue.length) return false;
    const agent = queue[0].agent_id;
    const batch = queue.slice(0, await this.capacity(agent));
    await this.busy(agent, new Date(Date.now() + BUSY_MS).toISOString());
    // `reply` records every way it ends and never throws; this is a last guard.
    await Promise.allSettled(batch.map((delivery) => reply(this.env, delivery)));
    // Taken off only once worked: what arrived meanwhile stays queued.
    const done = new Set(batch.map((delivery) => delivery.message_id));
    const left = ((await this.ctx.storage.get<DeskWork[]>("queue")) ?? []).filter((held) => !done.has(held.message_id));
    await this.ctx.storage.put("queue", left);
    return true;
  }

  /** One batch of session steps; false when there were none. */
  private async steps(): Promise<boolean> {
    const sessions = (await this.ctx.storage.get<string[]>("sessions")) ?? [];
    if (!sessions.length) return false;
    const agent = (await this.ctx.storage.get<string>("agent")) ?? null;
    const batch = sessions.slice(0, agent ? await this.capacity(agent) : DEFAULT_CAPACITY);
    // Taken off before the step: a session woken again during it (steering, a helper's result) is queued anew.
    const taken = new Set(batch);
    await this.ctx.storage.put("sessions", ((await this.ctx.storage.get<string[]>("sessions")) ?? []).filter((id) => !taken.has(id)));
    if (agent) await this.busy(agent, new Date(Date.now() + BUSY_MS).toISOString());
    await Promise.allSettled(
      batch.map((id) => advance(this.env as unknown as SessionEnv, id).catch((error: unknown) => console.error("agents: a session step threw", id, String(error)))),
    );
    return true;
  }

  private async busy(agent: string, until: string | null): Promise<void> {
    await this.env.DB.prepare("UPDATE agents SET busy_until = ? WHERE id = ?").bind(until, agent).run().catch(() => undefined);
  }
}
