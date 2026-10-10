import { data } from "react-router";

import type { Route } from "./+types/spend-pill";
import { managesBilling, requireUser, roleIn } from "../../lib/session.server";
import { loadPill } from "../../lib/spend.server";

/**
 * The top bar's spend pill, read after the page draws (components/spend.tsx
 * `SpendPill`): the viewer's month, and the workspace's for owners and
 * billing managers.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  return data(await loadPill(viewer, slug, managesBilling(viewer, slug)), { headers: { "Cache-Control": "private, no-store" } });
}
