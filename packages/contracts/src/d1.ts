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
 * back in the response's `x-d1-bookmark`. docs/PERFORMANCE.md says who
 * sends what.
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

/**
 * The database for an RPC `request`: a session, seen as the binding, when
 * the caller asked for one (it answers `prepare` and `batch`, all a request
 * path uses), the binding itself otherwise. `finish` adds the bookmark and
 * the time taken to the answer.
 */
export function openD1<D extends SessionCapable>(db: D, request: Request): { db: D; finish(response: Response): Response } {
  const started = Date.now();
  const asked = sessionConstraint(request.headers.get(BOOKMARK_HEADER));
  const session = asked ? db.withSession(asked) : null;
  return {
    db: (session ?? db) as D,
    finish(response) {
      const answered = new Response(response.body, response);
      answered.headers.append("server-timing", `svc;dur=${Date.now() - started};desc="${session ? "session" : "primary"}"`);
      const bookmark = session?.getBookmark();
      if (bookmark) answered.headers.set(BOOKMARK_HEADER, bookmark);
      return answered;
    },
  };
}
