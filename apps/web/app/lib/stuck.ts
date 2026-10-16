import { useContext, useEffect } from "react";
import { type Location, createPath, useNavigation, UNSAFE_DataRouterContext } from "react-router";
import { pendingNavigationOwns } from "./navigation-owner.ts";

/**
 * How long a client navigation may load before the page gives up on it and
 * loads the address as a whole page. Longer than any read may take on the
 * server (lib/deadline.ts `SLOW_READ_DEADLINE_MS`): a slow page that would
 * arrive is never cut off and started again, and a stuck service shows its
 * error page first. This catches what the server cannot: a request lost on
 * the way, a connection that went quiet, a route's code that never arrived.
 */
export const STUCK_NAVIGATION_MS = 75_000;

/**
 * Where to send a navigation that has been loading too long, or null when
 * there is nothing safe to retry. Only "loading" is retried: it reads, even
 * after a form was posted (the action already answered and the page is
 * reading what it changed). "submitting" is a write still on its way, and
 * sending it again could do it twice.
 */
export function stuckTarget(navigation: { state: string; location?: Pick<Location, "pathname" | "search" | "hash"> | null }): string | null {
  if (navigation.state !== "loading" || !navigation.location) return null;
  return createPath(navigation.location);
}

/**
 * Never leaves the page on its loading bar: a navigation still loading
 * after `STUCK_NAVIGATION_MS` is finished as a document load of the same
 * address, which either arrives or shows the server's error page.
 */
export function useStuckNavigationRescue(ms = STUCK_NAVIGATION_MS) {
  const context = useContext(UNSAFE_DataRouterContext);
  const navigation = useNavigation();
  const target = stuckTarget(navigation);
  const key = navigation.location?.key;
  useEffect(() => {
    if (!target) return;
    const timer = window.setTimeout(() => {
      if (!context || !pendingNavigationOwns(context.router.state.navigation, key)) return;
      console.warn(`g1t: navigation to ${target} still loading after ${ms}ms; loading it as a whole page`);
      window.location.assign(target);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [target, key, ms, context?.router]);
}
