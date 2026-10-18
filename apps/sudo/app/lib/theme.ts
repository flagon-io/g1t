import { useSyncExternalStore } from "react";

/**
 * Appearance: Auto, Light or Dark, as on g1t.sh (apps/web/app/lib/theme.ts).
 * The choice is kept in a cookie (`sudo_theme`), so the server draws the
 * page in it from the first byte, with no flash of the other theme. Light
 * and Dark are data-theme on <html>; Auto sets nothing and the stylesheet
 * follows the system's prefers-color-scheme. Every colour token is a
 * light-dark() pair (app.css), so the browser picks the palette from the
 * page's color-scheme.
 */

export type ThemeChoice = "auto" | "light" | "dark";

export const THEME_CHOICES: ThemeChoice[] = ["auto", "light", "dark"];

/** The cookie that keeps the choice, on sudo's own host. */
export const THEME_COOKIE = "sudo_theme";

/** Before anyone chooses: whatever their system is set to. */
export const DEFAULT_THEME: ThemeChoice = "auto";

/** The browser bar's colour in each theme: the page's background. */
export const THEME_COLOR = { light: "#fbfbfa", dark: "#0f0f11" } as const;

export const THEME_LABEL: Record<ThemeChoice, string> = { auto: "Auto", light: "Light", dark: "Dark" };

/** The choice in the cookie's value; the default for anything else. */
export function readTheme(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" || value === "auto" ? value : DEFAULT_THEME;
}

/** The Set-Cookie value that keeps the choice, for a year. */
export function themeCookie(choice: ThemeChoice, secure: boolean): string {
  return `${THEME_COOKIE}=${choice}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** What <html> carries for a choice: data-theme for Light and Dark, nothing for Auto. */
export function themeAttribute(choice: ThemeChoice): "light" | "dark" | undefined {
  return choice === "auto" ? undefined : choice;
}

// The choice made in this tab since the page loaded; null until one is.
let chosen: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The choice: the one made in this tab, else the one the page was drawn with (the cookie's). */
export function useThemeChoice(drawn: ThemeChoice | undefined): ThemeChoice {
  const initial = drawn ?? DEFAULT_THEME;
  return useSyncExternalStore(
    subscribe,
    () => chosen ?? initial,
    () => initial,
  );
}

/**
 * Switch to `choice` at once and remember it: <html>'s data-theme changes
 * now, the cookie keeps it for the next page the server draws, and every
 * switch on the page follows.
 */
export function setTheme(choice: ThemeChoice) {
  chosen = choice;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const attribute = themeAttribute(choice);
    if (attribute) root.dataset.theme = attribute;
    else delete root.dataset.theme;
    document.cookie = themeCookie(choice, window.location.protocol === "https:");
  }
  for (const listener of listeners) listener();
}
