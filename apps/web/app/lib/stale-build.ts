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

/**
 * The key React Router gives the location a tab's document loaded at. It is
 * the history entry's own key, and not "default": ScrollRestoration's inline
 * script gives the entry a key before the app starts, so a key alone cannot
 * tell a document load from a client navigation. Read when this module first
 * runs, which is before the app hydrates; undefined on the server.
 */
const DOCUMENT_KEY: string | undefined =
  typeof window === "undefined" ? undefined : ((window.history.state as { key?: string } | null)?.key ?? "default");

/**
 * Whether the page at this location key got there by a client navigation.
 * The server, and the render that hydrates the server's page, always say
 * no, so both render the same error page.
 */
export function clientNavigated(key: string, documentKey: string | undefined = DOCUMENT_KEY): boolean {
  return documentKey !== undefined && key !== documentKey;
}

/** The session key that remembers which address was reloaded, so it is reloaded once. */
export const RELOADED_KEY = "g1t-reloaded";

/** Whether this address was already loaded again once, so another try would not help. */
export function reloadedBefore(href: string, storage: Pick<Storage, "getItem"> | undefined = sessionStorageOrNone()): boolean {
  try {
    return storage?.getItem(RELOADED_KEY) === href;
  } catch {
    return false;
  }
}

/** How long the page waits for the reload to start before it shows the error instead. */
export const RELOAD_GIVE_UP_MS = 5000;

function sessionStorageOrNone(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
