/**
 * Reading a service's D1 database near the caller with D1's Sessions API,
 * and saying how long an RPC took: the TypeScript side of
 * crates/kit/src/d1.rs, with the same rules.
 *
 * The caller chooses, per request, with the `x-d1-bookmark` header:
 *
 * | Header | Reads go to |
 * | --- | --- |
 * | absent | the primary, with no session (as always) |
 * | `first-primary` | the primary first, then any copy at least as new |
 * | `first-unconstrained` | the nearest copy |
 * | a bookmark | any copy at least as new as the bookmark |
 *
 * Writes always go to the primary. The session's latest bookmark comes
 * back in the response's `x-d1-bookmark`. The site's side is
 * apps/web/app/lib/perf.ts.
 */

/** The header that carries a session's constraint or bookmark, both ways. */
export const BOOKMARK_HEADER = "x-d1-bookmark";

const MAX_BOOKMARK = 256;

/**
 * What an `x-d1-bookmark` header asks for: null for no session, otherwise
 * what `withSession` is given. Anything malformed starts on the primary.
 */
export function sessionConstraint(header: string | null | undefined): string | null {
  const value = header?.trim();
  if (!value) return null;
  if (value === "first-primary" || value === "first-unconstrained") return value;
  return value.length <= MAX_BOOKMARK && /^[0-9A-Za-z-]+$/.test(value) ? value : "first-primary";
}

/** A D1 binding, as far as sessions need it. */
type SessionCapable = { withSession(constraintOrBookmark?: string): { getBookmark(): string | null } };

/** How long a request waited on D1, and in how many round trips. */
export type D1Timing = { trips: number; ms: number };

/** The methods of a prepared statement that go to the database. */
const TRIPS = new Set(["all", "first", "run", "raw"]);

/**
 * `db` with every round trip counted into `timing`: each `all`, `first`,
 * `run` and `raw` of a statement, and each `batch`. Statements given to
 * `batch` are unwrapped, so the binding sees its own. The `db;dur` metric
 * crates/kit/src/d1.rs reports for the Rust services, for the TypeScript
 * ones; the site reads both (apps/web/app/lib/perf.ts `databaseTime`).
 */
export function timedD1<D extends object>(db: D, timing: D1Timing): D {
  const raw = new WeakMap<object, object>();
  const trip = async <T>(work: () => Promise<T>): Promise<T> => {
    const from = Date.now();
    try {
      return await work();
    } finally {
      timing.trips += 1;
      timing.ms += Date.now() - from;
    }
  };
  const statement = (s: object): object => {
    const wrapped = new Proxy(s, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => statement(value.apply(target, args));
        if (typeof prop === "string" && TRIPS.has(prop)) return (...args: unknown[]) => trip(() => value.apply(target, args));
        return value.bind(target);
      },
    });
    raw.set(wrapped, s);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "prepare") return (query: string) => statement(value.call(target, query));
      if (prop === "batch") return (statements: object[]) => trip(() => value.call(target, statements.map((s) => raw.get(s) ?? s)));
      return value.bind(target);
    },
  });
}

/**
 * The database for an RPC `request`: a session, seen as the binding, when
 * the caller asked for one (it answers `prepare` and `batch`, all a request
 * path uses), the binding itself otherwise, with its round trips counted.
 * `finish` adds the bookmark, the time taken and the database time to the
 * answer.
 */
export function openD1<D extends SessionCapable>(db: D, request: Request): { db: D; timing: D1Timing; finish(response: Response): Response } {
  const started = Date.now();
  const asked = sessionConstraint(request.headers.get(BOOKMARK_HEADER));
  const session = asked ? db.withSession(asked) : null;
  const timing: D1Timing = { trips: 0, ms: 0 };
  return {
    db: timedD1((session ?? db) as D, timing),
    timing,
    finish(response) {
      const answered = new Response(response.body, response);
      const db = timing.trips ? `, db;dur=${timing.ms};desc="${timing.trips} round trip${timing.trips === 1 ? "" : "s"}"` : "";
      answered.headers.append("server-timing", `svc;dur=${Date.now() - started};desc="${session ? "session" : "primary"}"${db}`);
      const bookmark = session?.getBookmark();
      if (bookmark) answered.headers.set(BOOKMARK_HEADER, bookmark);
      return answered;
    },
  };
}
