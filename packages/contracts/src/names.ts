// Namespaces follow GitHub's rules (no leading, trailing or doubled hyphens),
// so "--" can never appear inside one.
const NAMESPACE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const REPO_NAME = /^[a-z0-9._-]{1,100}$/;

/** Routes and reserved words that may not be registered as usernames. */
const RESERVED = new Set([
  "api", "mcp", "login", "logout", "register", "new", "settings", "search",
  "admin", "auth", "integrations", "pulls", "issues", "verify", "forgot", "reset", "device", "workspaces", "u", "oauth", "assets", "avatars", "docs", "explore", "about", "pricing",
  // g1t itself, and the name its agent once went by: everything g1t does is
  // shown as `g1t`, so nobody else may be called either.
  "g1t", "g1t-agent",
  // Trust pages on g1t.sh, and names kept for them.
  "policies", "security", "support", "status", "terms", "privacy", "help", "blog",
  // Invite links, and the waitlist.
  "invite", "invites", "waitlist",
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

export function isValidRepoName(value: string): boolean {
  return (
    REPO_NAME.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".git") &&
    // `/<workspace>/-/…` holds the workspace's own pages.
    value !== "-"
  );
}
