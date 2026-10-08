/**
 * Workspace aliases, as the Aliases page reads its forms: a name staff
 * point at a workspace (`g1t` leads to `flagon-io`). Identity checks each
 * again, and knows what this cannot: whether a person or workspace has the
 * name. No Workers imports, so it can be tested under Node.
 */
import { isSlug, type Parsed } from "./forms.ts";

/** The longest note or reason, as identity allows. */
export const MAX_ALIAS_NOTE = 500;

export type NewAlias = { alias: string; workspace: string; note: string };

function note(raw: string, missing: string): Parsed<string> {
  const value = raw.trim();
  if (!value) return { ok: false, error: missing };
  if ([...value].length > MAX_ALIAS_NOTE) return { ok: false, error: `Keep it to ${MAX_ALIAS_NOTE} characters.` };
  return { ok: true, value };
}

/** The add form: an alias, the workspace it leads to, and why. */
export function parseNewAlias(alias: string, workspace: string, why: string): Parsed<NewAlias> {
  const name = alias.trim().toLowerCase();
  if (!isSlug(name)) return { ok: false, error: "An alias uses lowercase letters, digits and single hyphens, up to 39 characters." };
  const slug = workspace.trim().toLowerCase();
  if (!isSlug(slug)) return { ok: false, error: "Give the workspace's slug, such as flagon-io." };
  if (name === slug) return { ok: false, error: "An alias cannot be the workspace's own slug." };
  const reason = note(why, "Say why the alias exists.");
  if (!reason.ok) return reason;
  return { ok: true, value: { alias: name, workspace: slug, note: reason.value } };
}

/** The remove form's reason, for sudo's audit log. */
export function parseRemovalReason(why: string): Parsed<string> {
  return note(why, "Say why the alias is being removed.");
}
