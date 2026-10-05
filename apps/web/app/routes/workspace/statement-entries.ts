import { data } from "react-router";

import type { Route } from "./+types/statement-entries";
import { billing } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/** One statement line's entries, 50 at a time, for the billing page to open. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const query = new URL(request.url).searchParams;
  const entries = await billing.statementEntries(params.owner, getViewer(context), {
    month: query.get("month") ?? "",
    kind: query.get("kind") ?? "",
    day: query.get("day"),
    project: query.get("project"),
    before: query.get("before"),
  });
  if (!entries.ok) throw data({ error: entries.error.message }, { status: 404 });
  return Response.json(entries.value, { headers: { "cache-control": "no-store" } });
}
