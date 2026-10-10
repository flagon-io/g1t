/**
 * An agent's handle: how it is mentioned (`@ship`). Pure, so it is tested
 * on its own.
 *
 * Lowercase letters, digits and hyphens, 2 to 32 characters, with no
 * leading, trailing or doubled hyphen (the same shape as a username, so a
 * mention reads the same for both). Never a name nobody may register:
 * `g1t` is the platform's own agent, and routes such as `settings` would
 * read as links.
 */
import { isReservedName } from "../../../packages/contracts/src/names.ts";

/**
 * Handles the site's agent pages would read as their own routes
 * (`/<workspace>/-/agents/new`, `…/templates`, `…/runs`, `…/fleet`),
 * besides the names nobody may register.
 */
const ROUTES = new Set(["new", "templates", "runs", "fleet"]);

const HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/;

export const HANDLE_RULE = "A handle is 2 to 32 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.";

export type HandleCheck = { ok: true; handle: string } | { ok: false; message: string };

/** `value` as a handle (trimmed, lowercased, a leading `@` dropped), or why it cannot be one. */
export function checkHandle(value: unknown): HandleCheck {
  if (typeof value !== "string") return { ok: false, message: HANDLE_RULE };
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE.test(handle)) return { ok: false, message: HANDLE_RULE };
  if (isReservedName(handle) || ROUTES.has(handle)) return { ok: false, message: `@${handle} is reserved. Choose another handle.` };
  return { ok: true, handle };
}
