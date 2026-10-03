import type { Hook, HookDelivery, HookOwner, User, Viewer } from "@g1t/contracts";

import { webhooks } from "./services.server";
import { unwrap } from "./session.server";

/** What a webhooks page shows: the webhooks, and one's deliveries if it is open. */
export type WebhooksData = {
  hooks: Hook[];
  open: string | null;
  deliveries: HookDelivery[];
};

export async function loadWebhooks(owner: HookOwner, viewer: Viewer, request: Request): Promise<WebhooksData> {
  const hooks = unwrap(await webhooks.list(viewer, owner));
  const wanted = new URL(request.url).searchParams.get("hook");
  const open = hooks.find((hook) => hook.id === wanted)?.id ?? null;
  const deliveries = open ? unwrap(await webhooks.deliveries(viewer, owner, open)) : [];
  return { hooks, open, deliveries };
}

/** What a webhooks form asked for, done. */
export type WebhooksAction = {
  error?: string;
  /** A webhook just made, and its secret if g1t made it: shown once. */
  created?: { hook: Hook; secret: string | null };
  /** The latest delivery a ping or redelivery made. */
  sent?: HookDelivery;
};

export async function actOnWebhooks(owner: HookOwner, actor: User, form: FormData): Promise<WebhooksAction> {
  const id = String(form.get("id") ?? "");
  switch (form.get("intent")) {
    case "create": {
      const events = form.get("which") === "some" ? form.getAll("event").map(String) : ["*"];
      if (events.length === 0) return { error: "Choose at least one event, or send everything." };
      const created = await webhooks.create(actor, owner, {
        url: String(form.get("url") ?? ""),
        events,
        secret: String(form.get("secret") ?? "").trim() || undefined,
      });
      return created.ok ? { created: created.value } : { error: created.error.message };
    }
    case "toggle": {
      const updated = await webhooks.update(actor, owner, id, { active: form.get("active") === "true" });
      return updated.ok ? {} : { error: updated.error.message };
    }
    case "delete": {
      const removed = await webhooks.delete(actor, owner, id);
      return removed.ok ? {} : { error: removed.error.message };
    }
    case "ping": {
      const sent = await webhooks.ping(actor, owner, id);
      return sent.ok ? { sent: sent.value } : { error: sent.error.message };
    }
    case "redeliver": {
      const sent = await webhooks.redeliver(actor, owner, String(form.get("delivery") ?? ""));
      return sent.ok ? { sent: sent.value } : { error: sent.error.message };
    }
    default:
      return { error: "Nothing to do." };
  }
}
