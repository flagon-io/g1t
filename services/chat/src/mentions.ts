/**
 * `@handle` mentions in a message: people by username, agents by handle.
 * Pure, so they are tested apart from the service.
 *
 * A message keeps the handles it mentions as ` a b ` (spaces around each),
 * so the sidebar finds a viewer's mentions with `LIKE '% name %'` without
 * matching `@bobby` for `@bob`.
 */

/**
 * `@` after the start or a character that cannot be part of an address
 * or a word (so `me@example.com` is not a mention), then the handle.
 */
const MENTION = /(^|[^a-z0-9_.@-])@([a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9_])?)/gi;

/** The handles `body` mentions, lowercased, each once, in order. */
export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of String(body ?? "").matchAll(MENTION)) found.add(match[2].toLowerCase());
  return [...found];
}

/** How a message's mentions are kept: `` (none) or ` a b `. */
export function mentionsColumn(handles: string[]): string {
  return handles.length ? ` ${handles.join(" ")} ` : "";
}

/** Whether a kept mentions column names `handle`. */
export function mentions(column: string | null | undefined, handle: string): boolean {
  return !!column && column.includes(` ${handle.toLowerCase()} `);
}
