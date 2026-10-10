/**
 * Opening the site's live sockets from the browser. A page signed in by a
 * session opens them at once, its cookie going along as always. A page
 * opened with an access token has no cookie, and a socket cannot carry the
 * token's header, so it first asks for a socket ticket and adds it to the
 * address (lib/socket-ticket.ts). Browser-only.
 */

/** As lib/socket-ticket.ts's, kept apart so the page does not load its sealing code. */
const TICKET_PARAM = "ticket";
const TICKET_ROUTE = "/-/live/ticket";

let viaToken = false;

/** Set by the root as it renders: whether this page was opened with an access token. */
export function setLiveViaToken(on: boolean): void {
  viaToken = on;
}

/** A ticket a page's loader minted with the page, as routes/notify/ticket.ts would have. */
export type OfferedTicket = { ticket: string; expires_at: string };

const offered = new Map<string, OfferedTicket>();

/**
 * A ticket minted on the server with the page (the root loader's for the
 * feed, an artifact's for its room), so the first socket opens without
 * first asking `/-/live/ticket`: one round trip less before anything is
 * live. Each is used once, and never past its minute.
 */
export function offerTicket(path: string, ticket: OfferedTicket | null | undefined): void {
  if (ticket) offered.set(path, ticket);
}

/** The offered ticket for `path`, if one is left and still good. */
export function takeOfferedTicket(path: string, now = Date.now()): string | null {
  const found = offered.get(path);
  if (!found) return null;
  offered.delete(path);
  return Date.parse(found.expires_at) - now > 5_000 ? found.ticket : null;
}

/** `wss://<this site><path>?<params>`, with a ticket when one was given. */
export function liveAddress(path: string, params: Record<string, string | null | undefined>, ticket: string | null): string {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  for (const [name, value] of Object.entries(params)) if (value != null && value !== "") url.searchParams.set(name, value);
  if (ticket) url.searchParams.set(TICKET_PARAM, ticket);
  return url.toString();
}

async function ticketFor(path: string): Promise<string | null> {
  try {
    const answer = await fetch(`${TICKET_ROUTE}?path=${encodeURIComponent(path)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { ticket?: unknown };
    return typeof body.ticket === "string" ? body.ticket : null;
  } catch {
    return null;
  }
}

/**
 * Calls `open` with the address of the socket at `path`: at once for a
 * session, after fetching a fresh ticket for a token's page (each attempt
 * gets its own, as one lasts a minute). `params` is read when the address
 * is made, so it sees any change meanwhile. Nothing is opened once
 * `cancelled` says so.
 */
export function openLive(
  path: string,
  params: () => Record<string, string | null | undefined>,
  open: (address: string) => void,
  cancelled: () => boolean,
): void {
  if (!viaToken) {
    open(liveAddress(path, params(), null));
    return;
  }
  const minted = takeOfferedTicket(path);
  if (minted) {
    open(liveAddress(path, params(), minted));
    return;
  }
  void ticketFor(path).then((ticket) => {
    if (!cancelled()) open(liveAddress(path, params(), ticket));
  });
}
