/**
 * A project's description: what it is, in a line. Only projects have
 * descriptions; a repository has none of its own.
 */

/** The longest description a project keeps. */
export const MAX_DESCRIPTION = 200;

/**
 * The description to store for a change: unchanged when none is given,
 * null (none) for null or blank text, otherwise the text.
 */
export function ownDescription(current: string | null, change: string | null | undefined): string | null {
  if (change === undefined) return current;
  const text = change?.trim() ?? "";
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
}
