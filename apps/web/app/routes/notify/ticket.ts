import type { Route } from "./+types/ticket";
import { getViewer, roleIn } from "../../lib/session.server";
import { issueTicket, socketPath } from "../../lib/socket-ticket";
import { ticketSecret } from "../../lib/socket-ticket.server";
import { bearerToken } from "../../lib/website-token";

const PRIVATE = { "cache-control": "no-store", "x-robots-tag": "noindex" };

/**
 * A socket ticket for a page opened with an access token:
 * `GET /-/live/ticket?path=/<workspace>/-/chat/live` answers
 * `{ ticket, expires_at }`, good for a minute on that socket alone
 * (lib/socket-ticket.ts). Only a request signed in by a token gets one: a
 * session's sockets carry its cookie and need none.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const token = bearerToken(request);
  if (!viewer || !token || !viewer.token?.website) {
    return Response.json(
      { message: "Socket tickets are for pages opened with an access token; a signed-in browser's sockets use its session." },
      { status: viewer ? 400 : 401, headers: PRIVATE },
    );
  }
  const socket = socketPath(new URL(request.url).searchParams.get("path") ?? "");
  if (!socket) return Response.json({ message: "Which socket? `path` is one of the site's live sockets." }, { status: 400, headers: PRIVATE });
  if (socket.workspace && !roleIn(viewer, socket.workspace)) {
    return Response.json({ message: "Not found" }, { status: 404, headers: PRIVATE });
  }
  const issued = await issueTicket(ticketSecret(), { token, userId: viewer.id, path: socket.path });
  return Response.json(issued, { headers: PRIVATE });
}
