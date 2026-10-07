/**
 * What the inbox panel in the top bar shows (components/inbox.tsx), fetched
 * when it opens and for each tab: the newest items under the tab, and the
 * unread counts. `?only=counts` is the bell's count alone, asked for every
 * minute while a page is in view.
 */
import type { InboxCounts, InboxItem } from "@g1t/contracts";

import type { Route } from "./+types/inbox-json";
import { type InboxTab, inboxTab, severityOf } from "../lib/inbox";
import { inbox } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

/** As many items as the panel shows; the rest are on /inbox. */
const PANEL_ITEMS = 30;

export type InboxPanelData = {
  tab: InboxTab;
  /** Null when only the counts were asked for, or the list could not be read. */
  items: InboxItem[] | null;
  counts: InboxCounts | null;
};

export async function loader({ request, context }: Route.LoaderArgs) {
  // Never kept: it changes as people work through it.
  const headers = { "cache-control": "private, no-store" };
  const user = getViewer(context);
  if (!user) return Response.json(null, { status: 401, headers });
  const url = new URL(request.url);
  const tab = inboxTab(url.searchParams.get("tab"));
  const [page, counts] = await Promise.all([
    url.searchParams.get("only") === "counts"
      ? null
      : inbox.list(user, { severity: severityOf(tab), limit: PANEL_ITEMS }).catch(() => null),
    inbox.counts(user.username).catch(() => null),
  ]);
  const data: InboxPanelData = { tab, items: page?.items ?? null, counts };
  return Response.json(data, { headers });
}
