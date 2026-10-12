/**
 * Cloudflare Turnstile on email sign-up: a check that a person, not a
 * script, filled in the form. It is on when the Worker has both
 * `TURNSTILE_SITE_KEY` (a var: the widget's public site key) and
 * `TURNSTILE_SECRET` (a secret); without either it is skipped, so an
 * installation of its own and local development sign up without one. No
 * Workers imports, so it can be tested under Node; turnstile.server.ts
 * reads the settings and asks Cloudflare.
 */

/** The script that draws the widget; the page's policy allows it (page-headers.ts). */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** Where a widget's answer is checked. */
export const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The form field the widget fills in. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

/** What sign-up says when the check failed or was not done. */
export const TURNSTILE_FAILED = "We could not tell that a person sent this form. Wait for the check above the button to finish, then try again.";

export type TurnstileSettings = { siteKey: string; secret: string } | null;

/** The settings, when both are set: otherwise Turnstile is off. */
export function turnstileSettings(siteKey: string | undefined, secret: string | undefined): TurnstileSettings {
  const key = (siteKey ?? "").trim();
  const hidden = (secret ?? "").trim();
  return key && hidden ? { siteKey: key, secret: hidden } : null;
}

/** Whether Cloudflare's answer says the check passed. */
export function turnstilePassed(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && (answer as { success?: unknown }).success === true;
}
