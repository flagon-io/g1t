import type { RegistrationMode } from "@g1t/contracts";

import { identity } from "./services.server";

/** How long one isolate trusts the answer before asking identity again. */
const TTL_MS = 60_000;

let known: { mode: RegistrationMode; at: number } | null = null;

/**
 * Whether anyone may sign up, or only someone with an invite (g1t.sh's
 * private preview), as identity's REGISTRATION_MODE says. Asked at most
 * once a minute per isolate. When identity cannot answer, the last answer
 * stands, and with none the site says invite-only: offering a sign-up form
 * identity then refuses is worse than a Request access form, and while
 * identity is down nobody can sign up either way.
 */
export async function registrationMode(): Promise<RegistrationMode> {
  const now = Date.now();
  if (known && now - known.at < TTL_MS) return known.mode;
  try {
    const mode = await identity.registration();
    known = { mode: mode === "invite" ? "invite" : "open", at: now };
    return known.mode;
  } catch {
    return known?.mode ?? "invite";
  }
}

/** Who is asking, for identity's rate limits: the visitor's address. */
export function clientKey(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}
