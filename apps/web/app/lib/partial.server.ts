/**
 * A part of a page that fails to load shows as missing, with the page
 * still up: a loader reads what the page is about as usual (a failure
 * there is the page's error), and each part beside it through `soft`,
 * which gives null when it fails. The part then says it could not be
 * loaded (components/boundary.tsx `Unavailable`) and is back on the next
 * refresh. A 404 or a refusal is an answer, not a failure: read those as
 * the service gives them, before `soft` hides them.
 */
export function soft<T>(work: Promise<T>, what: string): Promise<T | null> {
  return work.catch((error) => {
    console.warn(`g1t: ${what} could not be loaded:`, error);
    return null;
  });
}
