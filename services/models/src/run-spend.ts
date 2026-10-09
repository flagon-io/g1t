/**
 * One run's model spend, as a Durable Object named by its model session.
 *
 * Why an object per run: the count must agree across every isolate the
 * run's requests reach, at once, or an agent that sends many requests in
 * parallel spends the cap once per isolate. A per-isolate count written
 * back now and then has exactly that hole, and the proxy has no database
 * of its own to count in (billing's token count is written after each
 * answer, for usage views, and read nowhere near this fast). One object
 * per run is the natural unit: a run is one model session, its object sees
 * every one of its requests in order, and it costs two short requests per
 * model answer (admit and settle) plus one storage write, far below what
 * the answer itself costs. The object forgets the run a while after its
 * session has lapsed.
 */
import { DurableObject } from "cloudflare:workers";

import { type Admission, SpendTally } from "./spend.ts";

/** How long after its first answer a run's count is kept: longer than a model session lives (3 hours). */
const FORGET_MS = 4 * 60 * 60_000;

export class RunSpend extends DurableObject<object> {
  private tally = new SpendTally();

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.tally = new SpendTally((await ctx.storage.get<number>("spent")) ?? 0);
    });
  }

  /** Whether the run may start another answer under `cap`, in millionths of a dollar. */
  async admit(cap: number): Promise<Admission> {
    const admission = this.tally.admit(cap, Date.now());
    if (admission.ok && admission.spent === 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FORGET_MS);
    }
    return admission;
  }

  /** An answer has ended, costing `micros`. Returns what the run has spent. */
  async settle(ticket: string, micros: number): Promise<number> {
    const before = this.tally.spent;
    const spent = this.tally.settle(ticket, micros);
    if (spent !== before) await this.ctx.storage.put("spent", spent);
    return spent;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.tally = new SpendTally();
  }
}
