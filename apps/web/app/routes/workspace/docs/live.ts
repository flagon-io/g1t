import { env } from "cloudflare:workers";

import { DOCS_VIEWER_HEADER } from "@g1t/contracts";

import type { Route } from "./+types/live";
import { getViewer, roleIn } from "../../../lib/session.server";

/**
 * A page's live socket: `wss://<site>/<workspace>/-/docs/live?page=<id>`.
 * The site checks the session and that the page asking is the site's own,
 * then hands the upgrade to the docs service with the viewer, which checks
 * their role in the page's space and gives the socket to the page's room
 * (one Durable Object per page), which enforces that role.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer) return new Response("Sign in to use Docs.", { status: 401 });
  if (!roleIn(viewer, params.owner)) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This address takes a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Cross-origin socket refused", { status: 403 });
  const page = new URL(request.url).searchParams.get("page");
  if (!page) return new Response("Which page?", { status: 400 });
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.set(DOCS_VIEWER_HEADER, JSON.stringify(viewer));
  const target = `https://docs/live?page=${encodeURIComponent(page)}&workspace=${encodeURIComponent(params.owner.toLowerCase())}`;
  try {
    return await env.DOCS.fetch(new Request(target, { method: "GET", headers }));
  } catch (error) {
    console.error("docs: the live socket could not be handed over", error);
    return new Response("Docs didn't answer.", { status: 503 });
  }
}
