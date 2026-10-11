/**
 * The desktop app (apps/desktop) is for using g1t, not for browsing the
 * site: someone signed out there lands on the sign-in page, never the
 * landing page. The site knows it is inside the app by a cookie. The
 * app's launcher opens `/?app=desktop`, and the home page answers that by
 * setting the cookie; the bridge's presence on a page sets it too, for a
 * build of the app older than the query (routes/home.tsx). The app keeps
 * its own cookies, apart from any browser's, so the cookie never follows
 * someone to the site in their browser.
 */

import { readCookie } from "./github.ts";

export const DESKTOP_COOKIE = "g1t_app";
export const DESKTOP_VALUE = "desktop";
/** The query the launcher opens the server with: `/?app=desktop`. */
export const DESKTOP_QUERY = "app";

/** A year: the cookie outlives sign-outs, and the app renews it at every launch. */
export const DESKTOP_COOKIE_SECONDS = 365 * 24 * 60 * 60;

/** Whether a request comes from the desktop app's window. */
export function fromDesktopApp(request: Request): boolean {
  return readCookie(request.headers.get("cookie"), DESKTOP_COOKIE) === DESKTOP_VALUE;
}

/** Whether a request is the launcher's first, `/?app=desktop`. */
export function launchedFromDesktopApp(url: URL): boolean {
  return url.searchParams.get(DESKTOP_QUERY) === DESKTOP_VALUE;
}

/** Sets the cookie from the page, for an app that opened `/` without the query. */
export function rememberDesktopApp(): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${DESKTOP_COOKIE}=${DESKTOP_VALUE}; Path=/; SameSite=Lax; Max-Age=${DESKTOP_COOKIE_SECONDS}${secure}`;
}
