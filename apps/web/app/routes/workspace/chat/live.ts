import { env } from "cloudflare:workers";

import { CHAT_VIEWER_HEADER } from "@g1t/contracts";

import type { Route } from "./+types/live";
import { getViewer, roleIn } from "../../../lib/session.server";

/**
 * A conversation's live socket: `wss://<site>/<workspace>/-/chat/live?channel=<id>`.
 * The site checks the session and that the page asking is the site's own,
 * then hands the upgrade to the chat service with the viewer, which checks
 * they may read the channel and keeps the socket (one Durable Object per
 * channel, hibernating while nothing happens).
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer) return new Response("Sign in to use chat.", { status: 401 });
  if (!roleIn(viewer, params.owner)) return new Response("Not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This address takes a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  // Only the site's own pages may open it: a page elsewhere carries the
  // cookie too, so the origin is what tells them apart.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Cross-origin socket refused", { status: 403 });
  const channel = new URL(request.url).searchParams.get("channel");
  if (!channel) return new Response("Which channel?", { status: 400 });
  const headers = new Headers(request.headers);
  // Neither the session nor anything else of the browser's goes on.
  headers.delete("cookie");
  headers.set(CHAT_VIEWER_HEADER, JSON.stringify(viewer));
  headers.set("x-g1t-workspace", params.owner.toLowerCase());
  const target = `https://chat/live?channel=${encodeURIComponent(channel)}&workspace=${encodeURIComponent(params.owner.toLowerCase())}`;
  try {
    return await env.CHAT.fetch(new Request(target, { method: "GET", headers }));
  } catch (error) {
    console.error("chat: the live socket could not be handed over", error);
    return new Response("Chat didn't answer.", { status: 503 });
  }
}
