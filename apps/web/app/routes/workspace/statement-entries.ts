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
  // Said beside the line that asked. As a 200: a fetcher shows any other
  // status as an error page in place of the whole billing page.
  if (!entries.ok) return Response.json({ error: entries.error.message }, { headers: { "cache-control": "no-store" } });
  return Response.json(entries.value, { headers: { "cache-control": "no-store" } });
}
