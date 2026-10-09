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

/**
 * The same, ending where a handle ends: `@ana/web` (a team) is not a
 * mention of `@ana`, and a shorter match can't be taken from a longer one.
 */
const MENTION_WHOLE = /(^|[^a-z0-9_.@-])@([a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9_])?)(?![a-z0-9_/-])/gi;

/** Code, which is never a mention: fenced blocks (to the end, if unclosed) and inline spans. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * An agent's message as it is kept: a mention of anyone who is not a
 * member of the conversation (`members`, lowercased handles and
 * usernames) loses its `@`, so it reads as a plain name, shows no pill and
 * notifies nobody. Code and team mentions are left as written.
 */
export function plainOutside(body: string, members: ReadonlySet<string>): string {
  const text = String(body ?? "");
  const plain = (part: string) =>
    part.replace(MENTION_WHOLE, (whole, before: string, handle: string) => (members.has(handle.toLowerCase()) ? whole : `${before}${handle}`));
  let out = "";
  let at = 0;
  for (const code of text.matchAll(CODE)) {
    out += plain(text.slice(at, code.index)) + code[0];
    at = code.index! + code[0].length;
  }
  return out + plain(text.slice(at));
}

/** How a message's mentions are kept: `` (none) or ` a b `. */
export function mentionsColumn(handles: string[]): string {
  return handles.length ? ` ${handles.join(" ")} ` : "";
}

/** Whether a kept mentions column names `handle`. */
export function mentions(column: string | null | undefined, handle: string): boolean {
  return !!column && column.includes(` ${handle.toLowerCase()} `);
}
