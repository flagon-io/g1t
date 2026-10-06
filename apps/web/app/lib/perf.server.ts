import { AsyncLocalStorage } from "node:async_hooks";

import type { ServiceBinding } from "@g1t/contracts";

import {
  type Bookmarks,
  type ServiceTiming,
  PRIMARY_WINDOW_SECONDS,
  bookmarkCookie,
  coveredMs,
  mayWrite,
  readBookmarks,
  rpcMethodOf,
  serverTiming,
  serviceDuration,
  databaseTime,
  sessionFor,
  SESSION_SERVICES,
} from "./perf";

/**
 * What one request to the site did: when it started, each service call
 * and how long it took, each loader, and the D1 bookmarks it read with and
 * got back. Kept per request with AsyncLocalStorage, so the service
 * clients, which are shared by every request in the isolate, can record
 * into the right one.
 */
type RequestPerf = {
  started: number;
  /** Not GET or HEAD: an action, a form post. */
  writing: boolean;
  /** A service call that may have written (lib/perf.ts `mayWrite`). */
  wrote: boolean;
  bookmarks: Bookmarks;
  returned: Record<string, string>;
  intervals: [number, number][];
  services: Record<string, ServiceTiming>;
  loaders: { id: string; ms: number; kind: "loader" | "action" }[];
  /** How each session-capable service was asked to read, for the header. */
  sessions: Map<string, string>;
};

const scope = new AsyncLocalStorage<RequestPerf>();

/** Runs `handle` with a fresh record for `request`. */
export function withRequestPerf<T>(request: Request, handle: () => Promise<T>): Promise<T> {
  const writing = request.method !== "GET" && request.method !== "HEAD";
  return scope.run(
    {
      started: Date.now(),
      writing,
      wrote: false,
      bookmarks: readBookmarks(request.headers.get("cookie")),
      returned: {},
      intervals: [],
      services: {},
      loaders: [],
      sessions: new Map(),
    },
    handle,
  );
}

/**
 * `binding` with its calls timed, and, for a service that reads D1 with
 * sessions, the `x-d1-bookmark` each call should carry (lib/perf.ts
 * `sessionFor`). Only `fetch` is wrapped: the clients use nothing else.
 */
export function instrumented(name: string, binding: ServiceBinding): ServiceBinding {
  return {
    async fetch(input: string, init?: RequestInit) {
      const perf = scope.getStore();
      if (!perf) return binding.fetch(input, init);
      const session = sessionFor(name, perf.bookmarks, perf.writing, Math.floor(Date.now() / 1000));
      let sent = init;
      if (session) {
        const headers = new Headers(init?.headers);
        headers.set("x-d1-bookmark", session);
        sent = { ...init, headers };
        perf.sessions.set(name, session.startsWith("first-") ? session.slice(6) : "bookmark");
      }
      if (SESSION_SERVICES.has(name) && mayWrite(rpcMethodOf(input))) perf.wrote = true;
      const from = Date.now();
      const response = await binding.fetch(input, sent);
      const to = Date.now();
      perf.intervals.push([from, to]);
      const timing = (perf.services[name] ??= { calls: 0, wallMs: 0, serviceMs: 0 });
      timing.calls += 1;
      timing.wallMs += to - from;
      const reported = response.headers.get("server-timing");
      timing.serviceMs += serviceDuration(reported) ?? 0;
      const database = databaseTime(reported);
      if (database) {
        timing.dbMs = (timing.dbMs ?? 0) + database.ms;
        timing.dbTrips = (timing.dbTrips ?? 0) + database.trips;
      }
      const bookmark = response.headers.get("x-d1-bookmark");
      if (bookmark && SESSION_SERVICES.has(name)) perf.returned[name] = bookmark;
      return response;
    },
  };
}

/**
 * Whether this request must read current data: it writes, or the person
 * wrote moments ago (lib/perf.ts `PRIMARY_WINDOW_SECONDS`). Caches step
 * aside then (lib/cache.server.ts).
 */
export function mustReadFresh(): boolean {
  const perf = scope.getStore();
  if (!perf) return true;
  if (perf.writing) return true;
  const at = perf.bookmarks.at;
  return at != null && Math.floor(Date.now() / 1000) - at < PRIMARY_WINDOW_SECONDS;
}

/** Records a loader's or action's time, from the route instrumentation. */
export function recordHandler(id: string, kind: "loader" | "action", ms: number) {
  scope.getStore()?.loaders.push({ id, kind, ms });
}

/**
 * `response` with the request's `Server-Timing`, and, after a request
 * that may have written, the bookmarks its services returned, so the
 * person's next pages read at least what they just did.
 */
export function finishResponse(request: Request, response: Response): Response {
  const perf = scope.getStore();
  if (!perf) return response;
  // A redirect's headers cannot be changed; a copy's can.
  const answered = new Response(response.body, response);
  const sessions = [...perf.sessions].map(([service, how]) => `${service}=${how}`).join(" ");
  answered.headers.append(
    "server-timing",
    serverTiming({
      totalMs: Date.now() - perf.started,
      loaders: perf.loaders,
      rpcMs: coveredMs(perf.intervals),
      services: perf.services,
      sessions,
    }),
  );
  // Signing in with GitHub writes on a GET; the session it starts says so.
  const signedIn = answered.headers.getSetCookie().some((cookie) => cookie.startsWith("g1t_session="));
  const wrote = perf.writing || perf.wrote || signedIn;
  if (wrote) {
    const next: Bookmarks = {
      at: Math.floor(Date.now() / 1000),
      services: { ...perf.bookmarks.services, ...perf.returned },
    };
    answered.headers.append("set-cookie", bookmarkCookie(next, new URL(request.url).protocol === "https:"));
  }
  return answered;
}
