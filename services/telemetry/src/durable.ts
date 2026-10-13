/**
 * Each project's store as a Durable Object: the logic is ./store.ts's
 * `Store`, whose methods are copied onto the object's (and so are
 * callable over RPC; ./index.ts types the stub as a `Store`). Each
 * workspace's meter likewise: ./meter.ts's `WorkspaceMeter`.
 */
import { DurableObject } from "cloudflare:workers";

import { WorkspaceMeter } from "./meter.ts";
import { TELEMETRY_MICROS_PER_GB, freeMonthlyBytes, telemetryCost, telemetryDetail } from "./quota.ts";
import { Store } from "./store.ts";

export class TelemetryStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => Store.prototype.open.call(this, ctx));
  }
}

for (const name of Object.getOwnPropertyNames(Store.prototype)) {
  if (name === "constructor") continue;
  Object.defineProperty(TelemetryStore.prototype, name, Object.getOwnPropertyDescriptor(Store.prototype, name)!);
}

type MeterEnv = {
  BILLING?: { fetch: typeof fetch };
  FREE_TELEMETRY_BYTES_PER_MONTH?: string;
};

export class TelemetryMeter extends DurableObject<MeterEnv> {
  constructor(ctx: DurableObjectState, env: MeterEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => WorkspaceMeter.prototype.open.call(this, ctx));
  }

  /** Reports the month's total to billing, at cost past the free amount. */
  async alarm(): Promise<void> {
    const billing = this.env.BILLING;
    if (!billing) return;
    const free = freeMonthlyBytes(this.env.FREE_TELEMETRY_BYTES_PER_MONTH);
    await (this as unknown as WorkspaceMeter).note(async (workspace, month, bytes) => {
      const { billingClient } = await import("@g1t/contracts");
      const client = billingClient(billing as never);
      const book = await client.prices().catch(() => null);
      const perGb = book?.prices.find((p) => p.meter === "telemetry_gb")?.costMicros ?? TELEMETRY_MICROS_PER_GB;
      // Any answer is billing's to keep (a month it has charged already is
      // refused for good); only a failure to reach it is tried again.
      await client.notePending(workspace, "telemetry", telemetryCost(bytes, free, perGb), telemetryDetail(bytes, free), month);
      return true;
    });
  }
}

for (const name of Object.getOwnPropertyNames(WorkspaceMeter.prototype)) {
  if (name === "constructor") continue;
  Object.defineProperty(TelemetryMeter.prototype, name, Object.getOwnPropertyDescriptor(WorkspaceMeter.prototype, name)!);
}
