import { useEffect, useRef, useState } from "react";

import type { ChatLiveEvent } from "@g1t/contracts";

import { backoff } from "../../lib/chat";
import { openLive } from "../../lib/live-socket";
import { heldOpen } from "../../lib/notify-store";

/** How long a conversation's socket stays open after leaving it, while the next one opens. */
const HANDOFF_MS = 1500;

export type LiveState = "connecting" | "open" | "reconnecting";

/**
 * A conversation's live socket (routes/workspace/chat/live.ts): every event
 * goes to `onEvent`; a dropped socket comes back on its own, waiting longer
 * each time up to half a minute, and at once when the tab is shown again or
 * the network returns. `onReconnect` runs after each return, so the page
 * can fetch what it missed. `send` writes to the socket when it is open.
 */
export function useChatLive(
  slug: string,
  channelId: string,
  onEvent: (event: ChatLiveEvent) => void,
  onReconnect: () => void,
): { state: LiveState; send: (message: object) => void } {
  const [state, setState] = useState<LiveState>("connecting");
  const socket = useRef<WebSocket | null>(null);
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  useEffect(() => {
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let opened = false;
    // Between asking for a socket ticket and opening the socket (lib/live-socket.ts).
    let opening = false;
    const connect = () => {
      if (closed || opening) return;
      timer = null;
      opening = true;
      openLive(
        `/${slug}/-/chat/live`,
        () => ({ channel: channelId }),
        (address) => {
          opening = false;
          open(address);
        },
        () => closed,
      );
    };
    const open = (address: string) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(address);
      } catch {
        schedule();
        return;
      }
      socket.current = ws;
      let openedAt: number | null = null;
      ws.onopen = () => {
        const again = opened;
        opened = true;
        openedAt = Date.now();
        setState("open");
        if (again) handlers.current.onReconnect();
      };
      ws.onmessage = (message) => {
        try {
          handlers.current.onEvent(JSON.parse(String(message.data)) as ChatLiveEvent);
        } catch {
          // Not an event this page knows: ignored.
        }
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (closed) return;
        // Only a connection that held starts the backoff over.
        if (heldOpen(openedAt)) attempt = 0;
        setState(opened ? "reconnecting" : "connecting");
        schedule();
      };
      ws.onerror = () => ws.close();
    };
    const schedule = () => {
      if (closed || timer) return;
      timer = setTimeout(connect, backoff(attempt++));
    };
    // Back now, not after the wait: the tab is shown, or the network returned.
    const now = () => {
      if (closed || opening || socket.current || document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = null;
      attempt = 0;
      connect();
    };
    connect();
    document.addEventListener("visibilitychange", now);
    window.addEventListener("online", now);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("online", now);
      // Switching conversations: the next one's socket opens before this
      // one closes, so nothing said in between is missed by either (each
      // channel is its own room). This one stops delivering at once.
      const old = socket.current;
      socket.current = null;
      if (old) {
        old.onmessage = null;
        old.onclose = null;
        old.onerror = null;
        setTimeout(() => old.close(), HANDOFF_MS);
      }
    };
  }, [slug, channelId]);

  const send = (message: object) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  return { state, send };
}
