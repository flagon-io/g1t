import type { Reauth, Result, TwoFactorSetup, User } from "@g1t/contracts";

import { pendingFields } from "./emails";
import type { PendingChange } from "./emails.server";
import { accounts } from "./services.server";
import { clientOf, sessionTokenOf } from "./session.server";

/** What the two-factor page's forms answer. */
export type TwoFactorActionData = {
  error?: string;
  notice?: string;
  /** Turning it on: the secret and its QR code, until a code confirms it. */
  setup?: TwoFactorSetup;
  /** Recovery codes, shown once. */
  codes?: string[];
  reauth?: PendingChange;
} | null;

export const TWO_FACTOR_INTENTS = ["two-factor-start", "two-factor-enable", "two-factor-disable", "two-factor-codes"] as const;

function proof(request: Request, form: FormData): Reauth {
  const password = String(form.get("password") ?? "");
  return { sessionToken: sessionTokenOf(request), password: password || null, client: clientOf(request) };
}

/** A refusal for want of proof becomes the password prompt, carrying the form's fields. */
function refused(result: Result<unknown> & { ok: false }, form: FormData, keep?: Partial<NonNullable<TwoFactorActionData>>): TwoFactorActionData {
  if (result.error.code === "reauth_required") {
    return { ...keep, reauth: { intent: String(form.get("intent")), fields: pendingFields(form), message: result.error.message } };
  }
  return { ...keep, error: result.error.message };
}

/** Handles the two-factor page's intents; undefined for any other. */
export async function twoFactorAction(user: User, form: FormData, request: Request): Promise<TwoFactorActionData | undefined> {
  const code = String(form.get("code") ?? "");
  switch (form.get("intent")) {
    case "two-factor-start": {
      const result = await accounts.twoFactorStart(user, proof(request, form));
      return result.ok ? { setup: result.value } : refused(result, form);
    }
    case "two-factor-enable": {
      // The setup the form showed, so a wrong code shows it again.
      const setup = { secret: String(form.get("secret") ?? ""), uri: String(form.get("uri") ?? "") };
      const result = await accounts.twoFactorEnable(user, code, proof(request, form));
      return result.ok ? { codes: result.value.codes, notice: "Two-factor authentication is on." } : refused(result, form, { setup });
    }
    case "two-factor-disable": {
      const result = await accounts.twoFactorDisable(user, code, proof(request, form));
      return result.ok ? { notice: "Two-factor authentication is off." } : refused(result, form);
    }
    case "two-factor-codes": {
      const result = await accounts.twoFactorRecoveryCodes(user, proof(request, form));
      return result.ok ? { codes: result.value.codes, notice: "New recovery codes. The old ones no longer work." } : refused(result, form);
    }
  }
  return undefined;
}
