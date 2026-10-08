/**
 * A page left open across a deploy runs the old build. Its next client
 * navigation can fail in ways that only mean "this tab is out of date": the
 * router's manifest no longer matches the server's, a route module's old
 * file is gone, or an address only the new build knows falls through to the
 * old build's catch-all 404. Each of those is fixed by loading the address
 * again as a whole page, not by an error page.
 */

/** Messages that mean the tab's code is older than the server's. */
const STALE_MESSAGES = [
  /manifest version mismatch/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

export type ErrorSeen = {
  /** The error the root boundary caught. */
  error: unknown;
  /** The 404's status, when the error is a response. */
  status?: number;
  /** Whether the page got here by a client navigation, not a document load. */
  clientNavigation: boolean;
  /** Whether the deepest route matched is the catch-all not-found route. */
  caughtByCatchAll: boolean;
};

/** Whether reloading the address as a whole page is the fix for this error. */
export function reloadFixes({ error, status, clientNavigation, caughtByCatchAll }: ErrorSeen): boolean {
  // A document load already ran the server's newest build.
  if (!clientNavigation) return false;
  // An address the old build does not know: the new one may.
  if (status === 404) return caughtByCatchAll;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_MESSAGES.some((pattern) => pattern.test(message));
}

/** The session key that remembers which address was reloaded, so it is reloaded once. */
export const RELOADED_KEY = "g1t-reloaded";
