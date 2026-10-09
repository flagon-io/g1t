import { env } from "cloudflare:workers";

import type { User } from "@g1t/contracts";

import { getViewer } from "./session.server";
import { identity } from "./services.server";
import { ticketViewer } from "./socket-ticket";
import { websiteUser } from "./website-token";

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
 * Who opens a live socket: the session or token the request carries, as
 * on any page, or else the person a socket ticket was made for
 * (lib/socket-ticket.ts), whose token is checked again now.
 */
export async function socketViewer(context: Parameters<typeof getViewer>[0], request: Request): Promise<User | null> {
  const viewer = getViewer(context);
  if (viewer) return viewer;
  return ticketViewer(request, ticketSecret(), async (token) => websiteUser(await identity.userForAccessToken(token)));
}
