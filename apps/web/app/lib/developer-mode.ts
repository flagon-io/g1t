import { useSyncExternalStore } from "react";

/**
 * Developer mode: what a person turns on (Settings, Account) so that when
 * something breaks they can say what. It is kept per browser in a cookie
 * (`g1t_dev`), as Appearance is, so the server knows it from the first
 * byte. While it is on:
 *
 * - a page that fails shows the error itself, its stack, where it happened
 *   and the build, with a button that copies it all to paste into a report
 *   (`debugReport`);
 * - a signed-in request is answered by React Router in its development
 *   mode (workers/app.ts), which sends the server's own error instead of
 *   "Unexpected Server Error". That mode differs from production only in
 *   that, and in hooks only the Vite dev server sets. It is for the person's
 *   own requests alone, and g1t's code is open, so the error tells them
 *   nothing of anyone else's.
 */

export const DEVELOPER_COOKIE = "g1t_dev";

/** Whether the cookie's value turns developer mode on. */
export function readDeveloperMode(value: string | null | undefined): boolean {
  return value === "1";
}

/** The Set-Cookie value that turns it on for a year, or off. */
export function developerCookie(on: boolean, secure: boolean): string {
  const lasts = on ? "Max-Age=31536000" : "Max-Age=0";
  return `${DEVELOPER_COOKIE}=${on ? "1" : ""}; Path=/; ${lasts}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Whether a request is answered with the server's own errors: developer
 * mode on, and signed in (a session cookie, or a token, which the site
 * checks before anything is read).
 */
export function wantsServerErrors(request: Request): boolean {
  const cookies = request.headers.get("cookie") ?? "";
  const on = new RegExp(`(?:^|;\\s*)${DEVELOPER_COOKIE}=1(?:;|$)`).test(cookies);
  return on && (/(?:^|;\s*)g1t_session=/.test(cookies) || request.headers.has("authorization"));
}

// Switched in this tab since the page loaded; null until it is.
let chosen: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function fromCookie(): boolean {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${DEVELOPER_COOKIE}=([^;]*)`));
  return readDeveloperMode(match?.[1]);
}

/**
 * Whether developer mode is on: as switched in this tab, else as this
 * browser's cookie says. `drawn` is what the server drew the page with (the
 * root loader's), used while the page hydrates; an error page whose root
 * data is gone draws without it, then shows the details once in the browser.
 */
export function useDeveloperMode(drawn?: boolean): boolean {
  return useSyncExternalStore(
    subscribe,
    () => chosen ?? fromCookie(),
    () => drawn ?? false,
  );
}

/** Turn developer mode on or off in this browser, now and for the pages the server draws next. */
export function setDeveloperMode(on: boolean) {
  chosen = on;
  if (typeof document !== "undefined") document.cookie = developerCookie(on, window.location.protocol === "https:");
  for (const listener of listeners) listener();
}

/** What a failed page knows about itself, for `debugReport`. */
export type DebugFacts = {
  url: string;
  /** When it was seen in the browser; null while the server draws the page. */
  at: Date | null;
  error: unknown;
  /** The routes the page was drawn from, outermost first. */
  routes: string[];
  /** Which build of the site: its stylesheet's hashed name. */
  build: string;
  userAgent: string;
  /** Inside the desktop app: its version. */
  desktop?: string | null;
  /** Whether the error came from a document the server drew, or a navigation in the browser. */
  navigation: "document" | "client";
};

/** The error's parts, whatever was thrown. */
export function describeError(error: unknown): { kind: string; status?: number; message: string; stack?: string; data?: string } {
  if (error && typeof error === "object" && "status" in error && "data" in error && typeof (error as { status: unknown }).status === "number") {
    const response = error as { status: number; statusText?: string; data: unknown; error?: unknown };
    const inner = response.error instanceof Error ? response.error : null;
    return {
      kind: "Response",
      status: response.status,
      message: [response.status, response.statusText].filter(Boolean).join(" "),
      data: typeof response.data === "string" ? response.data : safeJson(response.data),
      stack: inner?.stack,
    };
  }
  if (error instanceof Error) {
    return { kind: error.name || "Error", message: error.message, stack: error.stack };
  }
  return { kind: typeof error, message: typeof error === "string" ? error : safeJson(error) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Everything about a failed page, as text to paste into a report: what
 * failed, where, when and on which build. Never anything of the person's
 * beyond the address they were at.
 */
export function debugReport(facts: DebugFacts): string {
  const error = describeError(facts.error);
  const lines = [
    `g1t error report`,
    ``,
    `URL: ${facts.url}`,
    `Time: ${facts.at?.toISOString() ?? "(not yet in the browser)"}`,
    `Loaded: ${facts.navigation === "document" ? "a page drawn by the server" : "a navigation in the browser"}`,
    `Build: ${facts.build}`,
    `Routes: ${facts.routes.join(" > ") || "(none)"}`,
    `Browser: ${facts.userAgent}`,
  ];
  if (facts.desktop) lines.push(`Desktop app: ${facts.desktop}`);
  lines.push(``, `${error.kind}${error.status ? ` ${error.status}` : ""}: ${error.message}`);
  if (error.data) lines.push(``, `Data:`, error.data);
  if (error.stack) lines.push(``, `Stack:`, error.stack);
  return lines.join("\n");
}
