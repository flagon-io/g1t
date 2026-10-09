/** How alike two facts' words must be (shared over all, as sets) to be one fact. */
const SAME_WORDS = 0.85;
/** The fewest distinct words a fact needs before it can be found inside another. */
const CONTAINED_MIN_WORDS = 6;

/** A fact's words, lowercase, one space apart: case, punctuation and spacing aside. */
function folded(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

/**
 * Whether two facts say the same thing, as the work service decides it
 * (`same_memory`): the same words; one's words, in order, inside the
 * other's; all of one's words (at least six) among the other's; or most of
 * their words shared.
 */
export function sameFact(a: string, b: string): boolean {
  const [x, y] = [folded(a), folded(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.split(" ").length >= 4 && ` ${long} `.includes(` ${short} `)) return true;
  const shortWords = new Set(short.split(" "));
  const longWords = new Set(long.split(" "));
  let shared = 0;
  for (const word of shortWords) if (longWords.has(word)) shared++;
  if (shortWords.size >= CONTAINED_MIN_WORDS && shared === shortWords.size) return true;
  const all = new Set([...shortWords, ...longWords]).size;
  return all > 0 && shared / all >= SAME_WORDS;
}

/**
 * The same fact remembered twice (two runs that learned it, one saved
 * again, or a sentence that grew since) is shown once: the first of them in
 * the order given, so a pinned one or the newest wins. Facts match when
 * their words do, whatever the case, spacing or punctuation, or when they
 * are near enough to be one (see `sameFact`).
 */
export function distinctFacts<T extends { text: string }>(facts: T[]): T[] {
  const shown: T[] = [];
  for (const fact of facts) {
    if (!shown.some((other) => sameFact(other.text, fact.text))) shown.push(fact);
  }
  return shown;
}
