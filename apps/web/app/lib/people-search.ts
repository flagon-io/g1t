/**
 * Inviting someone into a workspace from People: who was typed, and what
 * to search for as they type. Search finds people by username or name and
 * shows only what a profile shows (a username, a name, an avatar), never an
 * email address. No Workers or React imports, so it can be tested under Node.
 */

/** Where the invite form asks for people as someone types (routes/people-json.ts). */
export const PEOPLE_SEARCH_PATH = "/-/people.json";

/** The longest query the search takes. */
const MAX_QUERY = 80;

/** Whether `text` reads as an email address rather than a username. */
export function looksLikeEmail(text: string): boolean {
  const at = text.trim().indexOf("@");
  return at > 0;
}

/**
 * What to search for as someone types `text`: the text without a leading
 * `@`, or null for nothing to search (empty, or an email address, which is
 * never looked up).
 */
export function peopleQuery(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || looksLikeEmail(trimmed)) return null;
  const query = trimmed.replace(/^@+/, "").slice(0, MAX_QUERY);
  return query ? query : null;
}

/** Who the invite form names: an email address, or a username. Null for nothing. */
export function inviteTarget(text: string): { email: string } | { username: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (looksLikeEmail(trimmed)) return { email: trimmed };
  const username = trimmed.replace(/^@+/, "").toLowerCase();
  return username ? { username } : null;
}
