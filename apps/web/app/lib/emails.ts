import type { AccountEmail } from "@g1t/contracts";

/** The fields to send again once the person has confirmed their password. */
export function pendingFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name !== "intent" && name !== "password" && typeof value === "string") fields[name] = value;
  }
  return fields;
}

/** What can be done to one address, by the same rules identity applies. */
export function addressActions(email: AccountEmail, all: AccountEmail[]): { makePrimary: boolean; remove: boolean; resend: boolean } {
  const confirmed = all.filter((other) => other.verified).length;
  return {
    makePrimary: email.verified && !email.primary,
    remove: !email.primary && !(email.verified && confirmed <= 1),
    resend: !email.verified,
  };
}

/** The addresses that can be the backup: confirmed, and not the primary. */
export function backupChoices(all: AccountEmail[]): AccountEmail[] {
  return all.filter((email) => email.verified && !email.primary);
}
