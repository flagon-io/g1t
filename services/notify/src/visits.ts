/**
 * When each person was last on a workspace's Home page, kept in their own
 * feed (src/feed.ts) so it is the same on every device. Home reads it to
 * show what happened while they were away, and marks it once they have
 * looked (never on first paint), so a quick refresh does not wipe what
 * they have not seen.
 *
 * Marks close together are one visit: a refresh, or coming back to Home
 * from another page a few minutes later, keeps showing what happened
 * before the visit began. A visit ends once no mark has come for
 * `VISIT_GAP_MS`; the next one shows what happened since its last mark.
 */

/** The longest slug a visit is kept for. */
const MAX_SLUG = 64;
/** How far behind now a mark may be: Home marks the time the page loaded, at most a day before. */
const MAX_BEHIND_MS = 24 * 60 * 60 * 1000;
/** Marks closer than this are one visit. */
export const VISIT_GAP_MS = 30 * 60 * 1000;

/** What is kept per workspace: the latest mark, and the last mark of the visit before this one. */
export type Visit = { seen_at: number; previous_at: number | null };

/** A workspace slug as visits key it, or null when it is not one. */
export function visitWorkspace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return slug && slug.length <= MAX_SLUG && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}

/**
 * The visit to keep after a mark at `at` (RFC 3339 or epoch ms): never
 * later than now, never more than a day behind it, and never earlier than
 * what is kept, so an old tab marking late does not move it back. Null
 * when there is nothing to change.
 */
export function markVisit(kept: Visit | null, at: unknown, now: number): Visit | null {
  const given = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : Number.NaN;
  if (!Number.isFinite(given)) return null;
  const mark = Math.min(now, Math.max(given, now - MAX_BEHIND_MS));
  if (!kept) return { seen_at: mark, previous_at: null };
  if (kept.seen_at >= mark) return null;
  // The same visit: what it shows still starts where it began.
  if (mark - kept.seen_at < VISIT_GAP_MS) return { seen_at: mark, previous_at: kept.previous_at };
  return { seen_at: mark, previous_at: kept.seen_at };
}

/**
 * When the person was last here, as Home counts from: during a visit, the
 * end of the one before it; after one, its last mark. Null when there was
 * none before.
 */
export function lastVisit(kept: Visit | null, now: number): number | null {
  if (!kept) return null;
  return now - kept.seen_at < VISIT_GAP_MS ? kept.previous_at : kept.seen_at;
}
