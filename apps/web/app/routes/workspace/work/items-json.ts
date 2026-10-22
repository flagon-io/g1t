import { LIST_PAGE } from "@g1t/contracts";

import type { Route } from "./+types/items-json";
import { search, work } from "../../../lib/services.server";
import { getViewer } from "../../../lib/session.server";
import { type ItemChoice, typedNumber } from "../../../lib/work-item-page";

/**
 * What a work item's pickers choose from (Blocked by, Move under another
 * item), read by the picker once it opens: the workspace's newest open
 * work items, and with `q`, the work items search finds for it (a number
 * finds that one, open or closed). `{ items: null }` when the work service
 * could not say, so the picker says so instead of "none".
 *
 * With `plan=1`, the plan's order instead (Now, then Next), which J and K
 * on a work item's page step through when it was not opened from a list.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  const headers = { "cache-control": "private, no-store" };
  if (query.get("plan") === "1") {
    const plan = await work.getPlan(workspace, viewer).catch(() => null);
    const numbers = plan?.ok ? [...plan.value.now, ...plan.value.next].map((item) => item.number) : null;
    return Response.json({ plan: numbers }, { headers });
  }
  const q = (query.get("q") ?? "").trim().slice(0, 200);
  const number = typedNumber(q);
  const [open, one, found] = await Promise.all([
    work.listWorkItems(workspace, viewer, { state: "open", limit: LIST_PAGE }).catch(() => null),
    number ? work.getWorkItem(workspace, number, viewer).catch(() => null) : null,
    // Search finds older ones by their words; only a suggestion, so the picker does without it.
    !number && q.length >= 2 ? search.suggest(viewer, q).catch(() => []) : [],
  ]);
  if (!open) return Response.json({ items: null }, { headers });
  const items = new Map<number, ItemChoice>();
  if (one?.ok) items.set(one.value.item.number, { number: one.value.item.number, title: one.value.item.title, state: one.value.item.state });
  for (const hit of found ?? []) {
    if (hit.kind !== "item" || hit.number == null || hit.workspace?.toLowerCase() !== workspace) continue;
    items.set(hit.number, { number: hit.number, title: hit.title, state: hit.state === "closed" ? "closed" : "open" });
  }
  for (const item of open.ok ? open.value : []) {
    if (!items.has(item.number)) items.set(item.number, { number: item.number, title: item.title, state: item.state });
  }
  return Response.json({ items: [...items.values()] }, { headers });
}
