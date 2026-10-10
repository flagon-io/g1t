import { env } from "cloudflare:workers";

import { DOCS_VIEWER_HEADER } from "@g1t/contracts";

import type { Route } from "./+types/live";
import { roleIn } from "../../../lib/session.server";
import { socketViewer } from "../../../lib/socket-ticket.server";

/**
 * An artifact's live socket: `wss://<site>/<workspace>/-/artifacts/live?folio=<id>`.
 * The site checks the session and that the page asking is the site's own,
 * then hands the upgrade to the artifacts service with the viewer, which checks
 * their role in the folio and gives the socket to its room (one Durable
 * Object per folio, any kind), which enforces that role.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  // A session, or a page opened with a token by its socket ticket.
  const viewer = await socketViewer(context, request);
  if (!viewer) return new Response("Sign in to use Artifacts.", { status: 401 });
  if (!roleIn(viewer, params.owner)) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This address takes a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Cross-origin socket refused", { status: 403 });
  const folio = new URL(request.url).searchParams.get("folio");
  if (!folio) return new Response("Which artifact?", { status: 400 });
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.set(DOCS_VIEWER_HEADER, JSON.stringify(viewer));
  const target = `https://docs/live?folio=${encodeURIComponent(folio)}&workspace=${encodeURIComponent(params.owner.toLowerCase())}`;
  try {
    return await env.ARTIFACTS.fetch(new Request(target, { method: "GET", headers }));
  } catch (error) {
    console.error("artifacts: the live socket could not be handed over", error);
    return new Response("Artifacts didn't answer.", { status: 503 });
  }
}
