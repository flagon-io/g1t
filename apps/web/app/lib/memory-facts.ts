/**
 * The same fact remembered twice (two runs that learned it, or one saved
 * again) is shown once: the first of them in the order given, so a pinned
 * one or the newest wins. Facts match when their words do, whatever the
 * case, spacing or a closing full stop.
 */
export function distinctFacts<T extends { text: string }>(facts: T[]): T[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = fact.text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
