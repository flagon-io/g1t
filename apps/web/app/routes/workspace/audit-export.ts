/**
 * The workspace's audit log as a file: `?format=csv` (the default) or
 * `json`, with the same filters as the page. Owners get everything;
 * members what they may see on the page.
 */
import { data } from "react-router";

import type { Route } from "./+types/audit-export";
import { exportName, parseFilters, toCsv, toQuery } from "../../lib/audit";
import { auditAll } from "../../lib/audit.server";
import { requireUser } from "../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const workspace = params.owner.toLowerCase();
  const filters = parseFilters(url.searchParams);
  // The visibility is decided by auditAll; this one is replaced there.
  const { visibility: _, ...query } = toQuery(workspace, { kind: "all" }, filters, 500);
  const entries = await auditAll(viewer, query);
  if (!entries) throw data("Only members of this workspace can read its audit log.", { status: 403 });
  const name = exportName(workspace, format, new Date());
  const headers = {
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
  };
  return format === "json"
    ? new Response(JSON.stringify({ workspace, exportedAt: new Date().toISOString(), entries }, null, 2), {
        headers: { ...headers, "content-type": "application/json; charset=utf-8" },
      })
    : new Response(toCsv(entries), { headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
}
