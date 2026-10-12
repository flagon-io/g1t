/**
 * Each project's store as a Durable Object: the logic is ./store.ts's
 * `Store`, whose methods are copied onto the object's (and so are
 * callable over RPC; ./index.ts types the stub as a `Store`).
 */
import { DurableObject } from "cloudflare:workers";

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
