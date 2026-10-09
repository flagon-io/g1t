/**
 * Whether a visitor has agreed to site analytics, where the law asks
 * first: the EU and EEA, the UK and Switzerland. The server decides from
 * the visitor's country and marks the page (`<meta name="g1t-analytics"
 * content="consent">`); the choice is kept in this browser's local
 * storage. Safe to import on the server, where nothing is chosen.
 */

/** Countries whose visitors are asked before analytics runs. */
const ASK_FIRST = new Set([
  // The EU.
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // The rest of the EEA, the UK and Switzerland.
  "IS", "LI", "NO", "GB", "CH",
]);

/** Whether a visitor from `country` (ISO 3166 alpha-2, as Cloudflare gives it) is asked first. */
export function asksFirst(country: string | null | undefined): boolean {
  return !!country && ASK_FIRST.has(country.toUpperCase());
}

/**
 * Whether the visitor making `request` is asked first. Cloudflare sets the
 * country header (replacing any the visitor sent); `cf` is the same answer.
 */
export function visitorAsksFirst(request: Request): boolean {
  return asksFirst(request.headers.get("cf-ipcountry") ?? (request as Request & { cf?: { country?: string } }).cf?.country);
}

/** The installation analytics runs on; anywhere else nothing is sent or asked. */
export const ANALYTICS_HOST = "g1t.sh";

export function analyticsHere(): boolean {
  return typeof window !== "undefined" && window.location.hostname === ANALYTICS_HOST;
}

/** Whether this page was marked as one whose visitor is asked first. */
export function consentRequired(): boolean {
  return typeof document !== "undefined" && document.querySelector('meta[name="g1t-analytics"][content="consent"]') !== null;
}

export type Choice = "yes" | "no" | null;

const KEY = "g1t_analytics";
let current: Choice | undefined;
const listeners = new Set<() => void>();

/** What this browser chose; null until it has. */
export function choice(): Choice {
  if (typeof window === "undefined") return null;
  if (current === undefined) {
    try {
      const stored = window.localStorage.getItem(KEY);
      current = stored === "yes" || stored === "no" ? stored : null;
    } catch {
      current = null;
    }
  }
  return current;
}

/** Record a choice, or null to ask again. */
export function choose(next: Choice) {
  current = next;
  try {
    if (next) window.localStorage.setItem(KEY, next);
    else window.localStorage.removeItem(KEY);
  } catch {
    // No storage: the choice holds for this page only.
  }
  for (const listener of listeners) listener();
}

export function onChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether analytics may run in this browser now. */
export function allowed(): boolean {
  return analyticsHere() && (!consentRequired() || choice() === "yes");
}
