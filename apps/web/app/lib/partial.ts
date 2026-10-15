/**
 * Each part of a page loads on its own, and one that fails says so in its
 * own place, the way a form says what is wrong beside the field. A loader
 * reads what the page is about as usual: when that fails, the page fails
 * (routes/page-boundary.tsx). Every part beside it (a sidebar card, a
 * panel, a count) is read through `part`, which keeps a failure as
 * `Failed` instead of throwing, and the part shows `Unavailable` in its
 * place (components/boundary.tsx) while the rest of the page stays up.
 *
 * Only failures are caught: a service that did not answer, or answered
 * with a 5xx. A refusal or a 404 is an answer (`{ ok: false }`), which the
 * page reads as it always has.
 */

/** A part that could not be loaded, by what it is. Plain data, so a loader can send it. */
export type Failed = { failed: true; what: string };

/** `work`, or `Failed` when it throws; logged, so the failure is still seen. */
export async function part<T>(work: Promise<T> | T, what: string): Promise<T | Failed> {
  try {
    return await work;
  } catch (error) {
    console.warn(`g1t: ${what} could not be loaded:`, error);
    return { failed: true, what };
  }
}

export function isFailed(value: unknown): value is Failed {
  return typeof value === "object" && value !== null && (value as Failed).failed === true && typeof (value as Failed).what === "string";
}

/** The value, or `fallback` when it failed: for a part that can quietly do without. */
export function orElse<T, F>(value: T | Failed, fallback: F): T | F {
  return isFailed(value) ? fallback : value;
}
