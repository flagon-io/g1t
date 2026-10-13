/**
 * One tab pings. Every open tab of g1t hears the same notification over the
 * feed, so each would play its sound and show its desktop toast: three tabs,
 * three pings. Before pinging, a tab claims the arrival across the browser
 * (lib/sound-events.ts): the first claim wins and the rest stay quiet. A tab
 * the person is looking at claims at once and the others wait a beat, so the
 * one in front is the one that pings when there is one.
 *
 * The claim is a Web Lock held while a short-lived mark is written to
 * localStorage, the storage every tab of the site shares: a tab that gets the
 * lock after the winner finds the mark. Where neither exists (an old browser,
 * storage switched off), every tab pings as before.
 */

/** How long a background tab waits before claiming, so a tab in front wins. */
export const BACKGROUND_WAIT_MS = 400;
/** How long a mark is kept: long enough for every tab to have heard. */
export const MARK_TTL_MS = 10 * 60_000;
const PREFIX = "g1t:pinged:";

/** Storage as a claim reads and writes it. */
export type Marks = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  keys(): string[];
  remove(key: string): void;
};

/**
 * With the lock held: whether this tab is the first to claim `key`. Marks
 * it claimed, and clears marks older than the TTL as it goes.
 */
export function takeMark(marks: Marks, key: string, now: number): boolean {
  for (const name of marks.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const at = Number(marks.get(name));
    if (!Number.isFinite(at) || now - at > MARK_TTL_MS) marks.remove(name);
  }
  const name = PREFIX + key;
  if (marks.get(name) !== null) return false;
  marks.set(name, String(now));
  return true;
}

function localMarks(): Marks | null {
  try {
    const storage = window.localStorage;
    // Some browsers throw only on the first write.
    storage.setItem(`${PREFIX}probe`, "0");
    storage.removeItem(`${PREFIX}probe`);
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      keys: () => Array.from({ length: storage.length }, (_, at) => storage.key(at) ?? ""),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    return null;
  }
}

/** Whether this tab should ping for `key`: true for exactly one tab of the browser. */
export async function claimPing(key: string, inFront: boolean): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const marks = localMarks();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!marks || !locks) return true;
  if (!inFront) await new Promise((resolve) => setTimeout(resolve, BACKGROUND_WAIT_MS));
  try {
    return await locks.request(`${PREFIX}${key}`, async () => takeMark(marks, key, Date.now()));
  } catch {
    return true;
  }
}
