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
 * A refresh of the page already showing keeps the page as it is while it
 * tries, and a click elsewhere cancels it. It waits out the browser being
 * offline for as long as that lasts, but not a network that is up and
 * still never answers (an extension or proxy blocking g1t, broken DNS):
 * that is no blip, so after `REFRESH_PATIENCE_MS` of it the error is shown.
 * A read for another page (a click) tries for `PATIENCE_MS`. Either way the
 * error page then keeps trying on its own, on its own slower schedule
 * (lib/reconnect.ts): while it shows, reads are not retried here as well.
 * Nothing is retried from a tab out of view; it waits to be looked at.
 * A read the router gave up on itself (its signal aborted) stops at once.
 * Writes are never sent again: one that failed may have arrived, and
 * sending it twice could do it twice.
 */
import { useSyncExternalStore } from "react";
import { BUILD_HEADER } from "./build-version.ts";

/** How long a read keeps trying; under lib/stuck.ts's `STUCK_NAVIGATION_MS`, so a click still lands on an error page that recovers rather than a whole-page load that cannot. */
export const PATIENCE_MS = 45_000;

/** How long a refresh keeps the page while the browser says it is online and nothing answers. */
export const REFRESH_PATIENCE_MS = 120_000;

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

/** What a read has been through, to decide whether to try it again after `wait`. */
export type Tried = {
  /** A refresh of the page already showing, not a navigation. */
  refresh: boolean;
  /** Since the read started. */
  elapsedMs: number;
  /** Waited between tries while the browser said it was online. */
  onlineMs: number;
  /** Whether the error page is showing, trying on its own. */
  erroring: boolean;
};

/** Whether to try a read again after `wait`: never twice over, never forever on a network that is up. */
export function keepTrying(tried: Tried, wait: number): boolean {
  if (tried.erroring) return false;
  if (tried.refresh) return tried.onlineMs + wait <= REFRESH_PATIENCE_MS;
  return tried.elapsedMs + wait <= PATIENCE_MS;
}

/** Set by the error page while it tries on its own (lib/reconnect.ts). */
let erroring = false;
export function setErroring(on: boolean) {
  erroring = on;
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

/**
 * Waits `ms`, or less once the browser is back online, and then for as long
 * as the tab is out of view; rejects when `signal` aborts.
 */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("online", due);
      document.removeEventListener("visibilitychange", shown);
      signal?.removeEventListener("abort", stop);
    };
    let elapsed = false;
    function due() {
      elapsed = true;
      if (document.visibilityState !== "visible") return;
      cleanup();
      resolve();
    }
    // Only once the wait is over: coming into view does not cut it short.
    function shown() {
      if (elapsed) due();
    }
    function stop() {
      cleanup();
      reject(signal?.reason);
    }
    const timer = setTimeout(due, ms);
    window.addEventListener("online", due);
    document.addEventListener("visibilitychange", shown);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

let installed = false;
type NavigationLocation = { pathname: string; search: string };
let navigationLocation: () => NavigationLocation | undefined = () => undefined;

/** Read router state synchronously: React effects run after a navigation's fetch starts. */
export function watchBuildNavigation(read: () => NavigationLocation | undefined) {
  navigationLocation = read;
  return () => {
    if (navigationLocation === read) navigationLocation = () => undefined;
  };
}

/** Wraps the browser's `fetch` so the router's reads survive a moment offline. Browser only; once. */
export function installResilientFetch(build?: string) {
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
    const refresh = refreshesCurrent(url, window.location);
    // Switch builds only on a navigation, never from a background refresh
    // that could interrupt someone editing the current page.
    const destination = navigationLocation();
    if (build && !refresh && destination && refreshesCurrent(url, destination)) {
      const headers = new Headers(init?.headers ?? request?.headers);
      headers.set(BUILD_HEADER, build);
      init = { ...init, headers };
    }
    const signal = init?.signal ?? request?.signal;
    const started = Date.now();
    let onlineMs = 0;
    let counted = false;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          // A Request's body is read once; a GET has none, but clone so each try is whole.
          signal?.throwIfAborted();
          const response = await original(request ? (request.clone() as RequestInfo) : input, init);
          // A late manifest response can trigger a document redirect before
          // the router checks cancellation. Never hand it an abandoned read.
          if (signal?.aborted) {
            void response.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return response;
        } catch (error) {
          const wait = retryDelay(attempt);
          if (!isNetworkFailure(error) || signal?.aborted) throw error;
          if (!keepTrying({ refresh, elapsedMs: Date.now() - started, onlineMs, erroring }, wait)) throw error;
          if (navigator.onLine) onlineMs += wait;
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
