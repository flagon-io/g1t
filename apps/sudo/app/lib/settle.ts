/**
 * A call whose failure should not take the whole page down: the page
 * shows what it has and says what did not answer. No Workers imports.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
