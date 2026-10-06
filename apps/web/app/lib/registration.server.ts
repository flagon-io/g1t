import type { RegistrationMode } from "@g1t/contracts";

import { identity } from "./services.server";

/** How long one isolate trusts the answer before asking identity again. */
const TTL_MS = 60_000;

let known: { mode: RegistrationMode; at: number } | null = null;

/**
 * Whether g1t.sh is invite-only, as identity's REGISTRATION_MODE says.
 * Asked at most once a minute per isolate; when identity cannot answer,
 * the site says invite-only, the same as identity does with no setting.
 */
export async function registrationMode(): Promise<RegistrationMode> {
  const now = Date.now();
  if (known && now - known.at < TTL_MS) return known.mode;
  try {
    const mode = await identity.registration();
    known = { mode: mode === "open" ? "open" : "invite", at: now };
    return known.mode;
  } catch {
    return "invite";
  }
}

/** Who is asking, for identity's rate limits: the visitor's address. */
export function clientKey(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}
