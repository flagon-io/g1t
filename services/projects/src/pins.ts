/**
 * Pinned and recent projects: what each person keeps at hand in a
 * workspace. Pins are theirs to order, up to `MAX_PINS` a workspace;
 * recent is the projects they opened last that they have not pinned.
 * Pure, so the rules are tested apart from the service.
 */

/** Pins a person may have in one workspace: what its sidebar shows. */
export const MAX_PINS = 8;
/** Recent projects shown, after the pins. */
export const MAX_RECENT = 5;
/** Visits kept per person, across their workspaces. */
export const MAX_VISITS = 100;

/**
 * The pins' order after pinning `id`: at `position` (0 first) when given,
 * else at the end. Pinning one already pinned moves it. Null when the
 * workspace's pins are full.
 */
export function placePin(order: string[], id: string, position?: number | null): string[] | null {
  const rest = order.filter((pinned) => pinned !== id);
  if (rest.length >= MAX_PINS) return null;
  const at = position == null || !Number.isFinite(position) ? rest.length : Math.max(0, Math.min(rest.length, Math.trunc(position)));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The pins in the order asked for. Every pin is named once and nothing
 * else, or the reason it cannot be.
 */
export function reorderPins(order: string[], wanted: string[]): { ok: true; order: string[] } | { ok: false; message: string } {
  const pinned = new Set(order);
  const named = new Set(wanted);
  if (named.size !== wanted.length) return { ok: false, message: "Name each pinned project once." };
  const stranger = wanted.find((id) => !pinned.has(id));
  if (stranger) return { ok: false, message: `${stranger} is not pinned.` };
  if (named.size !== pinned.size) return { ok: false, message: "Name every pinned project, in the order you want them." };
  return { ok: true, order: [...wanted] };
}

/** The recent projects to show: latest first, leaving out the pinned, at most `MAX_RECENT`. */
export function recentAfterPins<T extends { id: string }>(visited: T[], pinned: Iterable<string>, limit = MAX_RECENT): T[] {
  const skip = new Set(pinned);
  return visited.filter((project) => !skip.has(project.id)).slice(0, limit);
}
