import { data } from "react-router";

import type { Route } from "./+types/actions-log";
import { actions } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/** A job's log after `?after=`, for the run page to fetch as it grows. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const log = await actions.logs(
    { namespace: params.owner, name: params.repo },
    getViewer(context),
    params.job,
    Number.isFinite(after) && after > 0 ? after : 0,
  );
  if (!log.ok) throw data({ error: log.error.message }, { status: log.error.code === "not_found" ? 404 : 400 });
  return Response.json(log.value, { headers: { "cache-control": "no-store" } });
}
