/**
 * What a project's agent runs did, from the workspace's audit log, as
 * JSON: for the Agent panel on a pull request. Members only; anyone else
 * gets an empty list.
 */
import type { Route } from "./+types/audit-live";
import { runAudit } from "../../lib/audit.server";
import { getViewer } from "../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const runIds = new URL(request.url).searchParams
    .getAll("run")
    .map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .slice(0, 20);
  const entries = await runAudit(viewer, params.owner, runIds);
  return Response.json({ entries }, { headers: { "cache-control": "no-store" } });
}
