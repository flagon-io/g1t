/**
 * What the docs service tells the rest of g1t about folios: `folio.*`
 * events on the bus (packages/contracts events.ts, `FolioEventData`).
 * Published with no `repoId`, so a folio never reaches a repository's
 * timeline or webhooks, and with a title only when the whole workspace
 * can read the folio. Never throws: an event that can't be told is
 * logged, and the change it is about still happened.
 */
import { eventsClient, type EventPayloads, type FolioEventData, type ServiceBinding } from "@g1t/contracts";

import { actorOf } from "../events.ts";

export type FolioEventType = "folio.created" | "folio.updated" | "folio.trashed" | "folio.restored" | "folio.shared" | "folio.stale";

export async function publishFolioEvent<T extends FolioEventType>(events: ServiceBinding | undefined, type: T, data: EventPayloads[T] & FolioEventData, actor: string | null): Promise<void> {
  if (!events) return;
  try {
    await eventsClient(events).publish([{ type, source: "docs", repoId: null, actor: actorOf(actor), data } as never]);
  } catch (error) {
    console.error("folios could not publish", type, String(error));
  }
}
