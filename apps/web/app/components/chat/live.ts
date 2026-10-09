import { useEffect, useRef, useState } from "react";

import type { ChatLiveEvent } from "@g1t/contracts";

import { backoff } from "../../lib/chat";

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
    const connect = () => {
      if (closed) return;
      timer = null;
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${scheme}//${location.host}/${slug}/-/chat/live?channel=${encodeURIComponent(channelId)}`);
      } catch {
        schedule();
        return;
      }
      socket.current = ws;
      ws.onopen = () => {
        const again = opened;
        opened = true;
        attempt = 0;
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
      if (closed || socket.current || document.visibilityState !== "visible") return;
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
      socket.current?.close();
      socket.current = null;
    };
  }, [slug, channelId]);

  const send = (message: object) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  return { state, send };
}
