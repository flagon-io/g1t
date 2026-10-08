/**
 * Fine-grained personal access tokens: each permission, as the form and the
 * API name it, and the g1t scopes each level gives. Mirrors
 * `crates/contracts/src/fine_grained.rs`, which is the source of truth; a
 * Rust test keeps the table here the same.
 *
 * A fine-grained token has one resource owner (your own account, or one
 * workspace), reaches all, selected or only public repositories of it,
 * and has a level for each permission. Its scopes are stored and checked
 * as a classic token's are.
 */

import type { Scope } from "./scopes";

export type PermissionGroup = "repository" | "workspace" | "account";

export type PermissionAccess = "none" | "read" | "write" | "admin";

export type RepositorySelection = "all" | "selected" | "public";

export type FineGrainedPermission = {
  name: string;
  label: string;
  group: PermissionGroup;
  about: string;
  /** The scopes reading gives; empty when it cannot be read only. */
  read: readonly Scope[];
  /** The scopes writing gives, besides reading's. */
  write: readonly Scope[];
  /** The scopes admin gives, besides writing's; empty when it has none. */
  admin: readonly Scope[];
};

/** Every permission, in the order the form shows them. */
export const PERMISSIONS = [
  { name: "actions", label: "Actions", group: "repository", about: "Workflow runs, jobs, logs and artifacts: reading them, and running, cancelling and rerunning workflows", read: ["workflows:read"], write: ["workflows:write"], admin: [] },
  { name: "administration", label: "Administration", group: "repository", about: "Repository settings, rulesets, who has access and deploy keys; renaming, archiving, transferring and deleting", read: ["repo:read", "access:read"], write: ["repo:admin", "access:admin"], admin: [] },
  { name: "agents", label: "g1t agents", group: "repository", about: "Putting g1t's agents to work and messaging them, which uses the workspace's money", read: [], write: ["agents:run"], admin: [] },
  { name: "checks", label: "Checks", group: "repository", about: "Check runs and check suites on commits. Shares its scopes with Commit statuses", read: ["checks:read"], write: ["checks:write"], admin: [] },
  { name: "contents", label: "Contents", group: "repository", about: "Code, branches, commits and releases: cloning and fetching, pushing, and publishing releases", read: ["code:read"], write: ["code:write", "repo:write"], admin: [] },
  { name: "deployments", label: "Deployments", group: "repository", about: "Deployments and their statuses", read: ["deployments:read"], write: ["deployments:write"], admin: [] },
  { name: "environments", label: "Environments", group: "repository", about: "Environments, and their secrets and variables", read: ["deployments:read", "secrets:read"], write: ["secrets:admin"], admin: [] },
  { name: "issues", label: "Issues", group: "repository", about: "Issues, their comments, labels and milestones, and plans", read: ["issues:read"], write: ["issues:write"], admin: [] },
  { name: "memory", label: "Memory and context", group: "repository", about: "Recalling memory and searching the workspace's context, and saving memory for the next agent", read: ["memory:read"], write: ["memory:write"], admin: [] },
  { name: "metadata", label: "Metadata", group: "repository", about: "Seeing repositories and searching them. Always read", read: ["repo:read"], write: [], admin: [] },
  { name: "packages", label: "Packages", group: "repository", about: "Pulling private packages, publishing them, and (admin) deleting packages and versions", read: ["packages:read"], write: ["packages:write"], admin: ["packages:delete"] },
  { name: "pages", label: "Pages", group: "repository", about: "Deployments on g1t.page. Shares its scopes with Deployments", read: ["deployments:read"], write: ["deployments:write"], admin: [] },
  { name: "pull_requests", label: "Pull requests", group: "repository", about: "Pull requests, their reviews, changes, sessions and merge queues", read: ["pull_requests:read"], write: ["pull_requests:write"], admin: [] },
  { name: "secrets", label: "Secrets", group: "repository", about: "Actions secrets: listing them (never their values), setting and deleting them. Shares its scopes with Variables", read: ["secrets:read"], write: ["secrets:admin"], admin: [] },
  { name: "security_events", label: "Security events and alerts", group: "repository", about: "Code scanning, secret scanning and vulnerability alerts, SARIF uploads and security settings", read: ["security:read"], write: ["security:write"], admin: [] },
  { name: "statuses", label: "Commit statuses", group: "repository", about: "Statuses on commits. Shares its scopes with Checks", read: ["checks:read"], write: ["checks:write"], admin: [] },
  { name: "variables", label: "Variables", group: "repository", about: "Actions variables: reading, setting and deleting them. Shares its scopes with Secrets", read: ["secrets:read"], write: ["secrets:admin"], admin: [] },
  { name: "webhooks", label: "Webhooks", group: "repository", about: "Webhooks and their deliveries", read: ["webhooks:read"], write: ["webhooks:admin"], admin: [] },
  { name: "workflows", label: "Workflows", group: "repository", about: "Adding, changing and deleting workflow files under .g1t/workflows and .github/workflows. Write only", read: [], write: ["workflow_files:write"], admin: [] },
  { name: "members", label: "Members", group: "workspace", about: "The workspace's people, invitations and teams", read: ["workspace:read"], write: ["workspace:admin"], admin: [] },
  { name: "workspace_administration", label: "Administration", group: "workspace", about: "The workspace's settings, integrations, rulesets and base permission", read: ["workspace:read", "access:read"], write: ["workspace:admin", "access:admin"], admin: [] },
  { name: "workspace_billing", label: "Billing", group: "workspace", about: "Usage, budget, AI credit and invoices, and (write) changing the budget and buying credit", read: ["billing:read"], write: ["billing:write"], admin: [] },
  { name: "models", label: "AI Gateway", group: "workspace", about: "AI Gateway requests: seeing them, and sending requests, which uses the workspace's AI credit", read: ["models:read"], write: ["models:write"], admin: [] },
  { name: "self_hosted_runners", label: "Self-hosted runners", group: "workspace", about: "Runners, their groups and settings", read: ["runners:read"], write: ["runners:admin"], admin: [] },
  { name: "workspace_secrets", label: "Secrets", group: "workspace", about: "The workspace's Actions secrets. Shares its scopes with the repository Secrets permission", read: ["secrets:read"], write: ["secrets:admin"], admin: [] },
  { name: "workspace_webhooks", label: "Webhooks", group: "workspace", about: "The workspace's webhooks. Shares its scopes with the repository Webhooks permission", read: ["webhooks:read"], write: ["webhooks:admin"], admin: [] },
  { name: "email_addresses", label: "Email addresses", group: "account", about: "Your email addresses and email settings, invites and invitations", read: ["account:read"], write: ["account:write"], admin: [] },
  { name: "starring", label: "Starring", group: "account", about: "Stars and pinned projects. Shares its scopes with Email addresses", read: ["account:read"], write: ["account:write"], admin: [] },
  { name: "notifications", label: "Notifications", group: "account", about: "Your inbox, subscriptions and watched repositories", read: ["notifications:read"], write: ["notifications:write"], admin: [] },
] as const satisfies readonly FineGrainedPermission[];

export type PermissionName = (typeof PERMISSIONS)[number]["name"];

export const PERMISSION_GROUPS: { group: PermissionGroup; label: string; about: string }[] = [
  { group: "repository", label: "Repository permissions", about: "What it may do in the repositories it reaches." },
  { group: "workspace", label: "Workspace permissions", about: "What it may do with the workspace itself." },
  { group: "account", label: "Account permissions", about: "What it may do with your own account." },
];

/** The longest a fine-grained token may last, whatever a workspace allows. */
export const FINE_GRAINED_MAX_LIFETIME_DAYS = 366;

/** The levels a permission can be set to, least first, none excluded. */
export function permissionLevels(permission: FineGrainedPermission): PermissionAccess[] {
  const levels: PermissionAccess[] = [];
  if (permission.read.length > 0) levels.push("read");
  if (permission.write.length > 0) levels.push("write");
  if (permission.admin.length > 0) levels.push("admin");
  return levels;
}

const ORDER: Record<PermissionAccess, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** The scopes a level of a permission gives, lower levels' included. */
export function permissionScopes(permission: FineGrainedPermission, access: PermissionAccess): Scope[] {
  const scopes: Scope[] = [];
  if (ORDER[access] >= ORDER.read) scopes.push(...permission.read);
  if (ORDER[access] >= ORDER.write) scopes.push(...permission.write);
  if (ORDER[access] >= ORDER.admin) scopes.push(...permission.admin);
  return scopes;
}

/** A token's permissions: each name's level; names left out are none. */
export type TokenPermissions = Partial<Record<string, PermissionAccess>>;

/** The permission named `name`. */
export function findPermission(name: string): FineGrainedPermission | undefined {
  return PERMISSIONS.find((permission) => permission.name === name);
}
