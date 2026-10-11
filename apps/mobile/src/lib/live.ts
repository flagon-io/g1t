import type { Client } from "./client";
import { socketUrl } from "./server";

/**
 * One of the site's live sockets, kept open: a conversation's
 * (`/<workspace>/-/chat/live`) or the person's feed (`/-/live`). A socket
 * cannot carry the `Authorization` header, so each opening asks
 * `GET /-/live/ticket?path=<path>` for a ticket (good for a minute, for
 * that socket alone; apps/web/app/lib/socket-ticket.ts) and adds it to
 * the address. A dropped socket opens again, with a new ticket, waiting
 * longer each time up to half a minute; a `ping` every 25 s keeps it
 * from being taken for gone.
 */

export type SocketStatus = "connecting" | "live" | "offline";

type Handlers = {
  onMessage: (data: unknown) => void;
  onStatus?: (status: SocketStatus) => void;
  /** Opened again after a drop: what was missed meanwhile should be read again. */
  onReconnect?: () => void;
  onOpen?: (send: (frame: unknown) => void) => void;
};

const PING_MS = 25_000;

export function openSocket(client: Client, path: string, query: Record<string, string>, handlers: Handlers) {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let opened = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const send = (frame: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  };

  const again = () => {
    if (ping) clearInterval(ping);
    ping = null;
    if (closed) return;
    handlers.onStatus?.("offline");
    attempts += 1;
    retry = setTimeout(open, Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)));
  };

  async function open() {
    if (closed) return;
    handlers.onStatus?.("connecting");
    let ticket: string;
    try {
      const token = await client.token();
      const response = await fetch(`${client.server.site}/-/live/ticket?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!response.ok) throw new Error(`ticket ${response.status}`);
      ticket = ((await response.json()) as { ticket: string }).ticket;
    } catch {
      return again();
    }
    if (closed) return;
    const address = `${socketUrl(client.server, path)}?${new URLSearchParams({ ...query, ticket })}`;
    const next = new WebSocket(address);
    socket = next;
    next.onopen = () => {
      const wasOpened = opened;
      opened = true;
      attempts = 0;
      handlers.onStatus?.("live");
      ping = setInterval(() => send("ping"), PING_MS);
      handlers.onOpen?.(send);
      if (wasOpened) handlers.onReconnect?.();
    };
    next.onmessage = (event) => {
      if (event.data === "pong") return;
      try {
        handlers.onMessage(JSON.parse(String(event.data)));
      } catch {
        // Not JSON: nothing for the app.
      }
    };
    next.onclose = () => {
      if (socket === next) again();
    };
  }

  void open();

  return {
    send,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      socket?.close();
      socket = null;
    },
  };
}
