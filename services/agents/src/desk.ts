/**
 * An agent's desk (docs/WORKSPACE.md, "The desk"): one Durable Object per
 * agent, by its id, where everything addressed to it arrives.
 *
 * Today everything that arrives is a message to answer. The desk keeps
 * them in a queue in its storage and works them from an alarm, at most the
 * agent's capacity at once, so a burst of messages never runs more replies
 * in parallel than the agent is allowed, and nothing handed over is lost
 * if the object is moved. While it works, the agent's row says so
 * (`busy_until`), which is how the Agents page shows it as working without
 * asking every desk.
 *
 * Tasks, steering and triggers arrive here later; replies are the first
 * kind of work.
 */
import { DurableObject } from "cloudflare:workers";

import type { AgentDelivery } from "@g1t/contracts";

import { DEFAULT_CAPACITY, MAX_CAPACITY } from "./definition.ts";
import { type ReplyEnv, reply } from "./reply.ts";

/** Messages a desk holds at most; past this the oldest are dropped, as nobody is waiting on them any more. */
const MAX_QUEUE = 50;
/** How long a batch of replies says the agent is working, renewed per batch. */
const BUSY_MS = 3 * 60_000;

export class Desk extends DurableObject<ReplyEnv> {
  /** Queues a message for the agent and makes sure the desk is working. Returns at once. */
  async take(delivery: AgentDelivery): Promise<void> {
    const queue = (await this.ctx.storage.get<AgentDelivery[]>("queue")) ?? [];
    if (queue.some((held) => held.message_id === delivery.message_id)) return;
    queue.push(delivery);
    await this.ctx.storage.put("queue", queue.slice(-MAX_QUEUE));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Works the queue until it is empty, a capacity's worth at a time. */
  async alarm(): Promise<void> {
    let agent: string | null = null;
    for (;;) {
      const queue = (await this.ctx.storage.get<AgentDelivery[]>("queue")) ?? [];
      if (!queue.length) break;
      agent = queue[0].agent_id;
      const row = await this.env.DB.prepare("SELECT capacity FROM agents WHERE id = ?").bind(agent).first<{ capacity: number }>();
      const capacity = Math.min(MAX_CAPACITY, Math.max(1, row?.capacity ?? DEFAULT_CAPACITY));
      const batch = queue.slice(0, capacity);
      await this.busy(agent, new Date(Date.now() + BUSY_MS).toISOString());
      // `reply` records every way it ends and never throws; this is a last guard.
      await Promise.allSettled(batch.map((delivery) => reply(this.env, delivery)));
      // Taken off only once worked: what arrived meanwhile stays queued.
      const done = new Set(batch.map((delivery) => delivery.message_id));
      const left = ((await this.ctx.storage.get<AgentDelivery[]>("queue")) ?? []).filter((held) => !done.has(held.message_id));
      await this.ctx.storage.put("queue", left);
    }
    if (agent) await this.busy(agent, null);
  }

  private async busy(agent: string, until: string | null): Promise<void> {
    await this.env.DB.prepare("UPDATE agents SET busy_until = ? WHERE id = ?").bind(until, agent).run().catch(() => undefined);
  }
}
