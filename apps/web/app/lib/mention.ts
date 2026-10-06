/** How g1t's agent is mentioned. The same as `AGENT_HANDLE` in the contracts. */
export const AGENT_MENTION = "@g1t";

const NAME = AGENT_MENTION.slice(1);

/**
 * The `@…` being typed just before the caret, if it could become `@g1t`:
 * where it starts. Null otherwise, and once it is `@g1t` already.
 */
export function partialMention(text: string, caret: number): number | null {
  const match = /(?:^|[\s(])@([\w./-]{0,9})$/.exec(text.slice(0, caret));
  if (!match) return null;
  const typed = match[1].toLowerCase();
  if (typed === NAME || !NAME.startsWith(typed)) return null;
  return caret - typed.length - 1;
}
