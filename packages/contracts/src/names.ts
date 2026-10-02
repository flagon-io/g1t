// Namespaces follow GitHub's rules (no leading, trailing or doubled hyphens),
// so "--" can never appear inside one.
const NAMESPACE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const REPO_NAME = /^[a-z0-9._-]{1,100}$/;

/** Routes and reserved words that may not be registered as usernames. */
const RESERVED = new Set([
  "api", "mcp", "login", "logout", "register", "new", "settings", "search",
  "admin", "auth", "pulls", "issues", "verify", "forgot", "reset", "device", "workspaces", "u", "oauth", "assets", "docs", "explore", "g1t", "about",
]);

export function isValidNamespace(value: string): boolean {
  return NAMESPACE.test(value) && !RESERVED.has(value);
}

export function isValidRepoName(value: string): boolean {
  return REPO_NAME.test(value) && !value.startsWith(".") && !value.endsWith(".git");
}
