// Namespaces follow GitHub's rules (no leading, trailing or doubled hyphens),
// so "--" can never appear inside one.
const NAMESPACE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const REPO_NAME = /^[a-z0-9._-]{1,100}$/;

/** Routes and reserved words that may not be registered as usernames. */
const RESERVED = new Set([
  "api", "mcp", "login", "logout", "register", "new", "settings", "search",
  "admin", "auth", "integrations", "pulls", "issues", "verify", "confirm-email", "forgot", "reset", "device", "workspaces", "u", "oauth", "assets", "avatars", "docs", "explore", "about", "pricing",
  // g1t itself, and the name its agent once went by: everything g1t does is
  // shown as `g1t`, so nobody else may be called either. `ghost` wrote what
  // a deleted account wrote (`GHOST_USERNAME`).
  "g1t", "g1t-agent", "ghost",
  // Trust pages on g1t.sh, and names kept for them.
  "policies", "security", "support", "status", "terms", "privacy", "help", "blog",
  // Invite links, and the waitlist.
  "invite", "invites", "waitlist",
  // g1t.sh/invitations: the workspace invitations waiting for an answer.
  "invitations",
  // The container registry, at g1t.sh/v2/.
  "v2",
  // g1t.sh/inbox, and the name it might also go by.
  "inbox", "notifications",
]);

/** Whether `value`, whatever its case, is a name nobody can register: a route, or g1t's own. */
export function isReservedName(value: string): boolean {
  return RESERVED.has(value.trim().toLowerCase());
}

export function isValidNamespace(value: string): boolean {
  return isNamespaceShaped(value) && !isReservedName(value);
}

/**
 * Whether `value` has a namespace's shape, reserved or not: what a
 * workspace's old name or an alias staff set (such as `g1t`) can be.
 */
export function isNamespaceShaped(value: string): boolean {
  return NAMESPACE.test(value);
}

/**
 * Usernames: letters of either case, digits and single hyphens, not
 * starting or ending with a hyphen, 1 to 39 characters, never reserved in
 * any case. The case is kept for showing; everything finds a person by the
 * name lowercased (`canonicalUsername`), so `Ana` and `ana` are one name.
 */
const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The `pattern` a username field takes in a form: the same rule, for the browser. */
export const USERNAME_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*";

export function isValidUsername(value: string): boolean {
  const name = value.trim();
  return USERNAME.test(name) && !isReservedName(name);
}

/** The name a person is found, linked and mentioned by: lowercased. */
export function canonicalUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** How a person's username shows: as they wrote it, or as it is kept. */
export function shownUsername(person: { username: string; display_username?: string | null; displayUsername?: string | null }): string {
  const display = person.display_username ?? person.displayUsername;
  return display && display.toLowerCase() === person.username.toLowerCase() ? display : person.username;
}

export function isValidRepoName(value: string): boolean {
  return (
    REPO_NAME.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".git") &&
    // `/<workspace>/-/…` holds the workspace's own pages.
    value !== "-"
  );
}
