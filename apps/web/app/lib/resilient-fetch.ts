/**
 * A page left open refreshes itself (lib/refresh.ts, lib/use-repo-live.ts),
 * and any of those reads can meet a moment without a network: Wi-Fi
 * changing, a laptop waking, a connection cut during a deploy. The browser
 * says only "Failed to fetch", and the router would show the error page in
 * place of a page that was fine. So the router's own reads (its `.data`
 * requests and route manifest) are asked again until they arrive: a little
 * later each time, sooner once the browser says it is back online. While
 * one is waiting, `useReconnecting` says so (components/connection-toast.tsx).
 *
 * A refresh of the page already showing keeps trying for as long as it
 * takes: the page stays as it is meanwhile, and a click elsewhere cancels
 * it. A read for another page (a click) tries for `PATIENCE_MS`, then
 * reaches the error page, which keeps trying on its own (lib/reconnect.ts).
 * A read the router gave up on itself (its signal aborted) stops at once.
 * Writes are never sent again: one that failed may have arrived, and
 * sending it twice could do it twice.
 */
import { useSyncExternalStore } from "react";

/** How long a read keeps trying; under lib/stuck.ts's `STUCK_NAVIGATION_MS`, so a click still lands on an error page that recovers rather than a whole-page load that cannot. */
export const PATIENCE_MS = 45_000;

/** The wait before try `attempt` (1 is the first retry): 0.25 s, 0.5 s, 1 s, 2 s, then every 5 s. */
export function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 5000);
}

/** What browsers throw when a request never got an answer, by browser. */
const NETWORK_MESSAGES = new Set([
  "failed to fetch", // Chromium
  "networkerror when attempting to fetch resource.", // Firefox
  "load failed", // Safari
  "network connection was lost.", // Safari
  "the network connection was lost.",
  "the internet connection appears to be offline.",
]);

/** Whether `error` means the request got no answer at all (not an error the server sent, nor an abort). */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return NETWORK_MESSAGES.has(error.message.trim().toLowerCase());
}

/** Whether a request is one of the router's reads, safe to send again. */
export function retriable(url: URL, method: string, origin: string): boolean {
  if (method.toUpperCase() !== "GET" || url.origin !== origin) return false;
  return url.pathname.endsWith(".data") || url.pathname === "/__manifest";
}

/**
 * Whether a `.data` read is for the page already showing (a refresh), not
 * one being navigated to: the same path (the root's is `/_root.data`) and
 * the same query, besides the router's own `_routes`.
 */
export function refreshesCurrent(url: URL, current: { pathname: string; search: string }): boolean {
  if (!url.pathname.endsWith(".data")) return false;
  const path = url.pathname.slice(0, -".data".length);
  if ((path === "/_root" ? "/" : path.replace(/\/$/, "")) !== (current.pathname.replace(/\/$/, "") || "/")) return false;
  const query = (search: string) => {
    const params = new URLSearchParams(search);
    params.delete("_routes");
    params.sort();
    return params.toString();
  };
  return query(url.search) === query(current.search);
}

// ── Whether a read is waiting on the network ─────────────────────────────

let waiting = 0;
const listeners = new Set<() => void>();
function setWaiting(change: number) {
  waiting += change;
  for (const listener of listeners) listener();
}

/** True while any of the router's reads is waiting for the network to come back. */
export function useReconnecting(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => waiting > 0,
    () => false,
  );
}

/** Waits `ms`, or less once the browser is back online; rejects when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      reject(signal?.reason);
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done, { once: true });
    signal?.addEventListener("abort", stop, { once: true });
  });
}

let installed = false;

/** Wraps the browser's `fetch` so the router's reads survive a moment offline. Browser only; once. */
export function installResilientFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    let url: URL;
    try {
      url = new URL(request ? request.url : String(input), window.location.href);
    } catch {
      return original(input, init);
    }
    const method = init?.method ?? request?.method ?? "GET";
    if (!retriable(url, method, window.location.origin)) return original(input, init);
    const signal = init?.signal ?? request?.signal;
    const patient = refreshesCurrent(url, window.location);
    const started = Date.now();
    let counted = false;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          // A Request's body is read once; a GET has none, but clone so each try is whole.
          return await original(request ? (request.clone() as RequestInfo) : input, init);
        } catch (error) {
          const wait = retryDelay(attempt);
          if (!isNetworkFailure(error) || signal?.aborted) throw error;
          if (!patient && Date.now() - started + wait > PATIENCE_MS) throw error;
          // The first miss may be nothing; from the second, say so.
          if (attempt === 2 && !counted) {
            counted = true;
            setWaiting(1);
          }
          if (attempt === 1) console.warn(`g1t: ${url.pathname} got no answer; trying again`);
          await pause(wait, signal);
        }
      }
    } finally {
      if (counted) setWaiting(-1);
    }
  };
}
