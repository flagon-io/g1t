/**
 * What the artifacts service tells the rest of g1t: `doc.page.*` events on the
 * bus (packages/contracts events.ts), through the EVENTS binding when it
 * has one. Published with no `repoId`, so a page never reaches a
 * repository's timeline or webhooks. Never throws: an event that can't be
 * told is logged, and the change it is about still happened.
 */
import { eventsClient, type DocPageEventData, type EventPayloads, type ServiceBinding } from "@g1t/contracts";

type DocEventType = "doc.page.created" | "doc.page.updated" | "doc.page.archived" | "doc.page.stale";

/** The id in a member key (`user:<id>`, `agent:<id>`), as an event's actor. */
export function actorOf(key: string | null | undefined): string | null {
  if (!key) return null;
  const at = key.indexOf(":");
  return at > 0 ? key.slice(at + 1) || null : null;
}

export async function publishDocEvent<T extends DocEventType>(events: ServiceBinding | undefined, type: T, data: EventPayloads[T] & DocPageEventData, actor: string | null): Promise<void> {
  if (!events) return;
  try {
    await eventsClient(events).publish([{ type, source: "docs", repoId: null, actor: actorOf(actor), data } as never]);
  } catch (error) {
    console.error("docs could not publish", type, String(error));
  }
}
