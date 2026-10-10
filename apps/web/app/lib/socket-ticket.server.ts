import { env } from "cloudflare:workers";

import type { User } from "@g1t/contracts";

import { getViewer, roleIn } from "./session.server";
import { identity } from "./services.server";
import { issueTicket, socketPath, ticketViewer } from "./socket-ticket";
import { bearerToken, websiteUser } from "./website-token";

let isolateSecret: string | null = null;

/**
 * What tickets are sealed with: the site's `USERCONTENT_KEY`, from which
 * lib/socket-ticket.ts derives a key of their own. Without it (a local
 * run), a key made for this isolate, which is enough where one process
 * serves the site.
 */
export function ticketSecret(): string {
  if (env.USERCONTENT_KEY) return env.USERCONTENT_KEY;
  if (!isolateSecret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    isolateSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return isolateSecret;
}

/**
 * A socket ticket minted with a page, for a page opened with an access
 * token: what `GET /-/live/ticket?path=` would answer, so the page's
 * first socket opens without that round trip (lib/live-socket.ts
 * `offerTicket`). Null for a session (its sockets carry the cookie) and
 * for a path that is not one of the site's sockets, or not the viewer's
 * workspace's.
 */
export async function socketTicketFor(context: Parameters<typeof getViewer>[0], request: Request, path: string): Promise<{ ticket: string; expires_at: string } | null> {
  const viewer = getViewer(context);
  const token = bearerToken(request);
  if (!viewer || !token || !viewer.token?.website) return null;
  const socket = socketPath(path);
  if (!socket || (socket.workspace && !roleIn(viewer, socket.workspace))) return null;
  return issueTicket(ticketSecret(), { token, userId: viewer.id, path: socket.path });
}

/**
 * Who opens a live socket: the session or token the request carries, as
 * on any page, or else the person a socket ticket was made for
 * (lib/socket-ticket.ts), whose token is checked again now.
 */
export async function socketViewer(context: Parameters<typeof getViewer>[0], request: Request): Promise<User | null> {
  const viewer = getViewer(context);
  if (viewer) return viewer;
  return ticketViewer(request, ticketSecret(), async (token) => websiteUser(await identity.userForAccessToken(token)));
}
