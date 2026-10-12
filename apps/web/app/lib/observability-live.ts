/**
 * A project's live tail in the browser: the socket the site forwards to
 * the project's store (routes/repo/observability-live.ts), opened while
 * a page follows it, and opened again after it drops.
 */
import { useEffect, useRef, useState } from "react";

import type { LiveItem } from "@g1t/contracts";

export type LiveState = "off" | "connecting" | "live" | "dropped";

export function useTelemetryLive(path: string, on: boolean, onItems: (items: LiveItem[], dropped: number) => void): LiveState {
  const [state, setState] = useState<LiveState>("off");
  const handler = useRef(onItems);
  handler.current = onItems;
  useEffect(() => {
    if (!on) {
      setState("off");
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let wait = 1000;
    const open = () => {
      setState("connecting");
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
      ws.onopen = () => {
        wait = 1000;
        setState("live");
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data === "pong") return;
        try {
          const message = JSON.parse(event.data) as { type: string; items?: LiveItem[]; dropped?: number };
          if (message.type === "items" && message.items) handler.current(message.items, message.dropped ?? 0);
        } catch {}
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        setState("dropped");
        retry = setTimeout(open, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
    };
  }, [path, on]);
  return state;
}
