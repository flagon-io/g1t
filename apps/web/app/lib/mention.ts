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

/** The most suggestions shown at once. */
export const MAX_SUGGESTIONS = 5;

/** What could complete the `@…` before the caret: where it starts, and the handles that fit, best first. */
export type MentionMatch = { start: number; options: string[] };

/**
 * The `@…` being typed just before the caret and what could complete it:
 * `@g1t` and the `handles` given (such as `@acme/backend`) whose name, or
 * a team's own part after the `/`, starts with what is typed. At most
 * `MAX_SUGGESTIONS`; nothing once one is typed in full. Null when the
 * caret is not in a mention or nothing fits.
 */
export function mentionSuggestions(text: string, caret: number, handles: readonly string[] = []): MentionMatch | null {
  const match = /(?:^|[\s(])@([\w./-]{0,100})$/.exec(text.slice(0, caret));
  if (!match) return null;
  const typed = match[1].toLowerCase();
  const start = caret - match[1].length - 1;
  const names = [...new Set([AGENT_MENTION, ...handles].map((handle) => (handle.startsWith("@") ? handle : `@${handle}`)))];
  if (names.some((name) => name.slice(1).toLowerCase() === typed)) return null;
  const whole: string[] = [];
  const part: string[] = [];
  for (const name of names) {
    const bare = name.slice(1).toLowerCase();
    if (bare.startsWith(typed)) whole.push(name);
    else if (typed && !typed.includes("/") && bare.split("/")[1]?.startsWith(typed)) part.push(name);
  }
  const options = [...whole, ...part].slice(0, MAX_SUGGESTIONS);
  return options.length > 0 ? { start, options } : null;
}
