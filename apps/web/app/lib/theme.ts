import { useSyncExternalStore } from "react";

/**
 * Appearance: Auto, Light or Dark. Each person's choice is kept in a
 * cookie (`g1t_theme`), so the server draws the page in it from the first
 * byte, with no flash of the other theme. Light and Dark are data-theme on
 * <html>; Auto sets nothing and the stylesheet follows the system's
 * prefers-color-scheme (app.css). Every colour token is a light-dark()
 * pair, so the browser picks the palette from the page's color-scheme.
 */

export type ThemeChoice = "auto" | "light" | "dark";

export const THEME_CHOICES: ThemeChoice[] = ["auto", "light", "dark"];

/** The cookie that keeps the choice. */
export const THEME_COOKIE = "g1t_theme";

/** What a page is drawn in before anyone chooses: whatever their system is set to. */
export const DEFAULT_THEME: ThemeChoice = "auto";

/** The browser bar's colour in each theme: the page's background. */
export const THEME_COLOR = { light: "#fbfbfa", dark: "#0f0f11" } as const;

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

/** The words for a choice, as the switch and the command palette say them. */
export const THEME_LABEL: Record<ThemeChoice, string> = { auto: "Auto", light: "Light", dark: "Dark" };

// The choice made in this tab since the page loaded; null until one is.
// Only ever set in the browser: on the server the page's own cookie rules.
let chosen: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The person's choice: the one made in this tab, else the one the page was
 * drawn with (the root loader's, from the cookie).
 */
export function useThemeChoice(drawn: ThemeChoice | undefined): ThemeChoice {
  const initial = drawn ?? DEFAULT_THEME;
  return useSyncExternalStore(
    subscribe,
    () => chosen ?? initial,
    () => initial,
  );
}

/**
 * Switch to `choice` at once and remember it: <html>'s data-theme and the
 * browser bar's colour change now, the cookie keeps it for the next page
 * the server draws, and every switch on the page follows.
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

/** The theme a choice comes to on this screen now: Auto asks the system. */
export function resolvedTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "auto") return choice;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The theme drawn right now, from <html>, for code that colours outside CSS (mermaid, the editor). */
export function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  const attribute = document.documentElement.dataset.theme;
  return attribute === "light" || attribute === "dark" ? attribute : resolvedTheme("auto");
}

function subscribeDrawn(listener: () => void) {
  const unsubscribe = subscribe(listener);
  const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  media?.addEventListener("change", listener);
  return () => {
    unsubscribe();
    media?.removeEventListener("change", listener);
  };
}

/**
 * The theme drawn right now, Light or Dark, kept current as it is switched
 * or the system changes under Auto. Needs no router, so it works inside
 * the editor's own blocks. The server says Dark; the browser corrects it.
 */
export function useDrawnTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeDrawn, currentTheme, () => "dark");
}
