import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import { setErroring } from "./resilient-fetch.ts";

/** The wait before the error page's try `attempt` (from 1): 3 s, 6 s, 12 s, then every 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(3000 * 2 ** (attempt - 1), 30_000);
}

/**
 * While `on` (the page fell to its error page because the network was
 * gone), loads the page again: a little later each time, at once when the
 * browser says it is back online or the tab comes back into view. Once a
 * load arrives, the router drops the error and the page is back. Each try
 * is one request (lib/resilient-fetch.ts stands back meanwhile), so a
 * network that never answers costs a request every 30 s, not a loop; one
 * that answers with a real error shows it, and the trying stops.
 */
export function useReconnect(on: boolean) {
  const revalidator = useRevalidator();
  const latest = useRef(revalidator);
  latest.current = revalidator;
  useEffect(() => {
    if (!on) return;
    setErroring(true);
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(retry, reconnectDelay(++attempt));
    };
    const retry = () => {
      if (document.visibilityState === "visible" && latest.current.state === "idle") void latest.current.revalidate();
      schedule();
    };
    const now = () => {
      if (document.visibilityState !== "visible") return;
      attempt = 0;
      clearTimeout(timer);
      retry();
    };
    schedule();
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      setErroring(false);
      clearTimeout(timer);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [on]);
}
