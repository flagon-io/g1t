import { env } from "cloudflare:workers";

import { TURNSTILE_FIELD, TURNSTILE_VERIFY, type TurnstileSettings, turnstilePassed, turnstileSettings } from "./turnstile";

/** Turnstile's settings from the Worker's: null when it is off (lib/turnstile.ts). */
export function turnstile(): TurnstileSettings {
  const vars = env as unknown as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
  return turnstileSettings(vars.TURNSTILE_SITE_KEY, vars.TURNSTILE_SECRET);
}

/**
 * Whether the form's Turnstile answer is good. True when Turnstile is off.
 * A missing or refused answer is false. When Cloudflare cannot be reached
 * the sign-up goes ahead, with the rate limit and email confirmation still
 * in its way: a check that cannot be made is no reason to stop everyone.
 */
export async function turnstileOk(form: FormData, client: string | null): Promise<boolean> {
  const settings = turnstile();
  if (!settings) return true;
  const answer = String(form.get(TURNSTILE_FIELD) ?? "").trim();
  if (!answer) return false;
  const body = new FormData();
  body.set("secret", settings.secret);
  body.set("response", answer);
  if (client) body.set("remoteip", client);
  try {
    const response = await fetch(TURNSTILE_VERIFY, { method: "POST", body });
    if (!response.ok) {
      console.error(`turnstile: siteverify answered ${response.status}`);
      return true;
    }
    return turnstilePassed(await response.json());
  } catch (error) {
    console.error("turnstile: siteverify could not be reached", error);
    return true;
  }
}
