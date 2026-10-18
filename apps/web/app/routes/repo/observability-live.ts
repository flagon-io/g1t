import { env } from "cloudflare:workers";

import type { Route } from "./+types/observability-live";
import { observed } from "../../lib/observability.server";

/**
 * A project's live tail: `wss://<site>/<owner>/<project>/observability/live`.
 * The site checks the viewer may read the project's observability and that
 * the page asking is its own, then hands the upgrade to the project's store
 * (services/telemetry), which sends each request, log line and span as it
 * arrives. Nothing of the browser's goes on.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This address takes a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Cross-origin socket refused", { status: 403 });
  const { projectId } = await observed(context, params, request);
  if (!env.TELEMETRY) return new Response("Observability is not set up here.", { status: 503 });
  return env.TELEMETRY.fetch(new Request(`https://telemetry/live?project_id=${encodeURIComponent(projectId)}`, { headers: { upgrade: "websocket" } }));
}
