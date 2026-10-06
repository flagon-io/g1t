import type { AccountEmails, Reauth, Result, SecurityEvent, User } from "@g1t/contracts";

import { pendingFields } from "./emails";
import { accounts } from "./services.server";
import { clientOf, sessionTokenOf } from "./session.server";

/** A change that waits on the person proving it is them. */
export type PendingChange = {
  intent: string;
  /** The form's other fields, sent again with the password. */
  fields: Record<string, string>;
  message: string;
};

/** What the Emails section's forms answer. */
export type EmailActionData = {
  emailError?: string;
  emailNotice?: string;
  reauth?: PendingChange;
} | null;

/** The intents the Emails section posts. */
export const EMAIL_INTENTS = ["add-email", "remove-email", "resend-email", "primary-email", "backup-email", "email-privacy"] as const;

/** A person's addresses and security log for their settings. */
export async function loadEmails(user: User): Promise<{ emails: AccountEmails | null; log: SecurityEvent[] }> {
  const [emails, log] = await Promise.all([
    accounts.listEmails(user).catch(() => null),
    accounts.securityLog(user).catch(() => null),
  ]);
  return {
    emails: emails?.ok ? emails.value : null,
    log: log?.ok ? log.value : [],
  };
}

/** A person's security log, newest first, for its own settings page. */
export async function loadSecurityLog(user: User): Promise<SecurityEvent[]> {
  const log = await accounts.securityLog(user).catch(() => null);
  return log?.ok ? log.value : [];
}

/** The proof a change carries: this session, and the password if it was just typed. */
function proof(request: Request, form: FormData): Reauth {
  const password = String(form.get("password") ?? "");
  return { sessionToken: sessionTokenOf(request), password: password || null, client: clientOf(request) };
}

function answer(result: Result<unknown>, form: FormData, notice?: string): EmailActionData {
  if (result.ok) return notice ? { emailNotice: notice } : null;
  if (result.error.code === "reauth_required") {
    return { reauth: { intent: String(form.get("intent")), fields: pendingFields(form), message: result.error.message } };
  }
  return { emailError: result.error.message };
}

/** Handles the Emails section's intents; undefined for any other intent. */
export async function emailAction(user: User, form: FormData, request: Request): Promise<EmailActionData | undefined> {
  const email = String(form.get("email") ?? "").trim();
  switch (form.get("intent")) {
    case "add-email":
      return answer(
        await accounts.addEmail(user, email, proof(request, form)),
        form,
        `A confirmation link is on its way to ${email}.`,
      );
    case "remove-email":
      return answer(await accounts.removeEmail(user, email, proof(request, form)), form, `Removed ${email}.`);
    case "resend-email":
      return answer(await accounts.resendEmailVerification(user, email), form, `Sent the link to ${email} again.`);
    case "primary-email":
      return answer(
        await accounts.updateEmailSettings(user, { primary: email }, proof(request, form)),
        form,
        `${email} is now your primary address.`,
      );
    case "backup-email":
      return answer(
        await accounts.updateEmailSettings(user, { backup: String(form.get("backup") ?? "") }, proof(request, form)),
        form,
        "Saved where security notices go.",
      );
    case "email-privacy":
      return answer(
        await accounts.updateEmailSettings(
          user,
          { privateEmail: form.get("private") === "on", blockPrivatePushes: form.get("block") === "on" },
          proof(request, form),
        ),
        form,
        "Saved.",
      );
  }
  return undefined;
}
