/**
 * The list a work item is opened from, for J and K on its page: a list of
 * work items (All items, the plan, the board, Triage, a project's home)
 * puts its order in each row's link state, and the item's page reads it
 * back. Its own module, with nothing imported, so the lists carry it
 * without pulling in the page's logic. Pure, so it is tested under Node.
 */

/**
 * The list a work item was opened from, carried in the link's location
 * state: its items' numbers in the order it showed them, what it is
 * called, and where it is.
 */
export type WorkTrail = { numbers: number[]; label: string; href: string };

/** At most this many numbers are carried: a long list's first ones. */
export const TRAIL_LIMIT = 500;

/** The location state a link to a work item carries, for J and K on its page. */
export function trailState(trail: WorkTrail | null): { workTrail: WorkTrail } | undefined {
  if (!trail || trail.numbers.length === 0) return undefined;
  return { workTrail: { ...trail, numbers: [...new Set(trail.numbers)].slice(0, TRAIL_LIMIT) } };
}

/** The list a page was opened from, from its location state; null for none, or anything else. */
export function trailOf(state: unknown): WorkTrail | null {
  if (!state || typeof state !== "object" || !("workTrail" in state)) return null;
  const trail = (state as { workTrail: unknown }).workTrail;
  if (!trail || typeof trail !== "object") return null;
  const { numbers, label, href } = trail as Partial<WorkTrail>;
  if (!Array.isArray(numbers) || typeof label !== "string" || typeof href !== "string") return null;
  const clean = numbers.filter((n): n is number => Number.isInteger(n) && n > 0);
  return clean.length > 0 ? { numbers: clean.slice(0, TRAIL_LIMIT), label, href } : null;
}

/** Where a work item is in a list: the one before and after it, and its place (from 1). Null when it is not in it. */
export function neighbours(numbers: readonly number[], current: number): { previous: number | null; next: number | null; index: number; total: number } | null {
  const at = numbers.indexOf(current);
  if (at < 0) return null;
  return { previous: at > 0 ? numbers[at - 1]! : null, next: at < numbers.length - 1 ? numbers[at + 1]! : null, index: at + 1, total: numbers.length };
}
