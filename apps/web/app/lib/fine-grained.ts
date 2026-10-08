/**
 * Fine-grained personal access tokens on the site: what the form posts,
 * read back into what identity takes, and the words lists use for them.
 *
 * The form posts `owner` (empty for your own account, or a workspace's
 * slug), `expires` (days), `repository_selection`, one `repo` per chosen
 * repository, and `perm.<name>` for each permission's level. Every field is
 * a plain form field, so it posts the same with or without JavaScript.
 */

import {
  FINE_GRAINED_MAX_LIFETIME_DAYS,
  PERMISSIONS,
  findPermission,
  permissionLevels,
  type FineGrainedPermission,
  type PermissionAccess,
  type RepositorySelection,
} from "@g1t/contracts/fine-grained";
import type { AccessToken, FineGrainedTokenInput, TokenPolicy, TokenStatus } from "@g1t/contracts";

import type { FormLike, Parsed } from "./token-scopes";

/** Lifetimes the form offers, in days; the longest is the most a fine-grained token may last. */
export const FINE_GRAINED_EXPIRY_DAYS = [7, 30, 60, 90, 180, FINE_GRAINED_MAX_LIFETIME_DAYS] as const;

export const DEFAULT_FINE_GRAINED_DAYS = 30;

/** The lifetimes a workspace's rules leave, longest last; all of them for your own account. */
export function expiryChoices(policy: TokenPolicy | null | undefined): number[] {
  const most = Math.min(policy?.maxLifetimeDays ?? FINE_GRAINED_MAX_LIFETIME_DAYS, FINE_GRAINED_MAX_LIFETIME_DAYS);
  const choices: number[] = FINE_GRAINED_EXPIRY_DAYS.filter((days) => days <= most);
  if (!choices.includes(most)) choices.push(most);
  return choices;
}

export function describeDays(days: number): string {
  if (days === FINE_GRAINED_MAX_LIFETIME_DAYS) return "1 year";
  return `${days} day${days === 1 ? "" : "s"}`;
}

const SELECTIONS: RepositorySelection[] = ["all", "selected", "public"];

/** The permissions a resource owner can be given: a workspace's repository and workspace ones, or your account's. */
export function permissionsFor(workspace: boolean): FineGrainedPermission[] {
  return PERMISSIONS.filter((permission) => (workspace ? permission.group !== "account" : permission.group === "account"));
}

/** A permission's level as the form shows it. */
export function accessLabel(access: PermissionAccess, permission?: FineGrainedPermission): string {
  switch (access) {
    case "none":
      return "No access";
    case "read":
      return "Read-only";
    case "write":
      return permission && permission.read.length === 0 ? "Write" : "Read and write";
    case "admin":
      return "Admin";
  }
}

/**
 * What the form posts, ready for identity, or what is wrong with it. In
 * `editing`, the resource owner and expiry are the token's own and are not
 * read.
 */
export function fineGrainedFromForm(form: FormLike, options: { editing?: boolean } = {}): Parsed<FineGrainedTokenInput> {
  const name = String(form.get("name") ?? "").trim();
  if (!options.editing && !name) return { ok: false, error: "Name the token after what will use it." };
  const owner = String(form.get("owner") ?? "").trim().toLowerCase();
  const workspace = owner === "" ? null : owner;
  const days = Number(form.get("expires") ?? DEFAULT_FINE_GRAINED_DAYS);
  if (!options.editing && (!Number.isInteger(days) || days < 1 || days > FINE_GRAINED_MAX_LIFETIME_DAYS)) {
    return { ok: false, error: `Choose when it expires: at most ${FINE_GRAINED_MAX_LIFETIME_DAYS} days.` };
  }
  const selectionText = String(form.get("repository_selection") ?? (workspace ? "all" : "public"));
  const repositorySelection = SELECTIONS.includes(selectionText as RepositorySelection) ? (selectionText as RepositorySelection) : "all";
  const repositories = [...new Set(form.getAll("repo").map((repo) => String(repo).trim()).filter(Boolean))];
  if (workspace && repositorySelection === "selected" && repositories.length === 0) {
    return { ok: false, error: "Choose at least one repository, or all repositories." };
  }
  const permissions: Record<string, PermissionAccess> = {};
  for (const permission of permissionsFor(workspace !== null)) {
    const level = String(form.get(`perm.${permission.name}`) ?? "none") as PermissionAccess;
    if (level === "none") continue;
    if (!permissionLevels(permission).includes(level)) {
      return { ok: false, error: `${permission.label} cannot be ${accessLabel(level).toLowerCase()}.` };
    }
    permissions[permission.name] = level;
  }
  // A workspace's token always reads its repositories' metadata.
  if (workspace) permissions.metadata = "read";
  else if (Object.keys(permissions).length === 0) return { ok: false, error: "Give the token at least one permission." };
  return {
    ok: true,
    value: {
      name,
      description: String(form.get("description") ?? "").trim() || null,
      ttlSeconds: days * 86_400,
      workspace,
      repositorySelection: workspace ? repositorySelection : "public",
      repositories: repositorySelection === "selected" ? repositories : [],
      permissions,
    },
  };
}

/** How a fine-grained token's reach reads in a list: "acme · 2 repositories". */
export function reachSummary(token: AccessToken): string {
  const details = token.fineGrained;
  if (!details) return "";
  if (!details.workspace) return "Your account · public repositories, read-only";
  switch (details.repositorySelection) {
    case "all":
      return `${details.workspace} · all repositories`;
    case "public":
      return `${details.workspace} · public repositories, read-only`;
    case "selected": {
      const count = details.repositories.length;
      return `${details.workspace} · ${count === 1 ? "1 repository" : `${count} repositories`}`;
    }
  }
}

/** A token's permissions as short chips: "contents: write", metadata left out. */
export function permissionChips(permissions: Partial<Record<string, PermissionAccess>> | undefined): string[] {
  return Object.entries(permissions ?? {})
    .filter(([name, access]) => name !== "metadata" && access && access !== "none")
    .sort(([a], [b]) => PERMISSIONS.findIndex((p) => p.name === a) - PERMISSIONS.findIndex((p) => p.name === b))
    .map(([name, access]) => `${findPermission(name)?.label ?? name}: ${access === "write" ? "write" : access}`);
}

/** A status as a badge's words and tone; null for an active token. */
export function statusBadge(status: TokenStatus | undefined): { label: string; tone: "warn" | "danger" } | null {
  switch (status) {
    case "pending":
      return { label: "Pending approval", tone: "warn" };
    case "denied":
      return { label: "Denied", tone: "danger" };
    case "revoked":
      return { label: "Revoked", tone: "danger" };
    default:
      return null;
  }
}

/** What the workspace's rules say about a fine-grained token aimed at it, for the form. */
export function policyNote(slug: string, policy: TokenPolicy | null | undefined, owner: boolean): string | null {
  if (!policy) return null;
  if (!policy.allowFineGrained) return `${slug} does not allow fine-grained tokens.`;
  if (policy.requireApproval && !owner) return `An owner of ${slug} must approve this token before it reaches the workspace. Until then it reads public repositories only.`;
  return null;
}

/** Days a policy's lifetime field holds: a number, or null for no limit. */
export function lifetimeFromForm(value: unknown): Parsed<number | null> {
  const text = String(value ?? "").trim();
  if (text === "" || text === "none") return { ok: true, value: null };
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, error: "The longest lifetime is a whole number of days, 1 to 3650, or none." };
  return { ok: true, value: days };
}
