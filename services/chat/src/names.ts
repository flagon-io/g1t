/**
 * Channel names and direct-message keys. Pure, so they are tested apart
 * from the service.
 */

/** The longest channel name. */
export const MAX_NAME = 80;

/** The most members a direct message may have, the viewer included. */
export const MAX_DM_MEMBERS = 9;

/** The channel every workspace starts with. */
export const GENERAL = "general";

const NAME = /^[a-z0-9_-]+$/;

/**
 * Names the site's chat URLs use beside channel names
 * (`/<workspace>/-/chat/<name>`), so no channel can take them.
 */
export const RESERVED = new Set(["dm", "browse", "live", "api", "new"]);

/**
 * A channel name as it is kept: lowercase, without a leading `#`, spaces
 * as dashes. Names are what people type after `#`, so only letters,
 * digits, `-` and `_`.
 */
export function channelName(input: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = String(input ?? "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!name) return { ok: false, message: "A channel needs a name." };
  if (name.length > MAX_NAME) return { ok: false, message: `A channel name is at most ${MAX_NAME} characters.` };
  if (!NAME.test(name)) {
    return { ok: false, message: "A channel name can only use lowercase letters, digits, dashes and underscores." };
  }
  if (RESERVED.has(name)) return { ok: false, message: `#${name} is reserved. Pick another name.` };
  return { ok: true, name };
}

/**
 * Who is in a direct message: the viewer and `others`, each once, sorted.
 * Nobody else, or only the viewer, is a direct message with yourself:
 * a place for notes.
 */
export function dmMembers(viewer: string, others: string[]): string[] {
  return [...new Set([viewer, ...others])].sort();
}

/** The key that finds a direct message by its members, whatever order they were given in. */
export function dmKey(members: string[]): string {
  return [...new Set(members)].sort().join(",");
}
