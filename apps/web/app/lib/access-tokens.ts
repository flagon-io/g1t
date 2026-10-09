/**
 * Access tokens on the site: what the token form posts, read back into
 * what identity takes, and the words lists and pages use for a token.
 *
 * There is one kind of token. It belongs to you or to a workspace, has a
 * level for each resource (its permissions, stored as scopes), a reach
 * (the workspaces and repositories it is made for) and an expiry.
 *
 * The form posts `name`, `description`, `expires` (days, or `never`),
 * `workspace` (`*` for every workspace you belong to, `-` for none, or a
 * slug), `repository_selection`, one `repo` per chosen repository, and
 * `perm.<resource>` for each resource's level. Every field is a form field,
 * so the form posts the same with or without JavaScript.
 */

import {
  MAX_SELECTED_REPOSITORIES,
  MAX_TOKEN_LIFETIME_DAYS,
  RESOURCE_GROUPS,
  SCOPE_RESOURCES,
  describeScope,
  levelsOf,
  permissionsOf,
  scopesOfPermissions,
  type Permissions,
  type ResourceGroup,
  type Scope,
  type ScopeLevel,
  type ScopeResource,
} from "@g1t/contracts/scopes";
import type { AccessToken, RepositorySelection, TokenChange, TokenInput, TokenPolicy, TokenStatus } from "@g1t/contracts";

import type { FormLike, Parsed } from "./token-scopes";

/** What the reach field posts for every workspace you belong to, and for none. */
export const ALL_WORKSPACES = "*";
export const NO_WORKSPACE = "-";

/** Lifetimes the form offers, in days; the longest is the most a token with an expiry may last. */
export const EXPIRY_DAYS = [7, 30, 60, 90, 180, MAX_TOKEN_LIFETIME_DAYS] as const;

export const DEFAULT_EXPIRY_DAYS = 30;

export function describeDays(days: number): string {
  if (days === MAX_TOKEN_LIFETIME_DAYS) return "1 year";
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The lifetimes the rules of the workspaces a token reaches leave, in days,
 * longest last, and whether it may never expire.
 */
export function expiryChoices(policies: readonly (TokenPolicy | null | undefined)[]): { days: number[]; never: boolean } {
  const limits = policies.map((policy) => policy?.maxLifetimeDays).filter((days): days is number => typeof days === "number");
  const most = Math.min(MAX_TOKEN_LIFETIME_DAYS, ...limits);
  const days: number[] = EXPIRY_DAYS.filter((choice) => choice <= most);
  if (!days.includes(most)) days.push(most);
  const never = limits.length === 0 && !policies.some((policy) => policy?.forbidNoExpiry);
  return { days, never };
}

/** The resources a token can hold: a workspace's own token holds none about a person. */
export function resourcesFor(workspaceOwned: boolean): { resource: ScopeResource; label: string; group: ResourceGroup }[] {
  return SCOPE_RESOURCES.filter((row) => !workspaceOwned || row.group !== "account");
}

/** The form's groups, with their resources. */
export function permissionGroups(workspaceOwned: boolean) {
  const resources = resourcesFor(workspaceOwned);
  return RESOURCE_GROUPS.map((group) => ({ ...group, resources: resources.filter((row) => row.group === group.group) })).filter(
    (group) => group.resources.length > 0,
  );
}

export function resourceLabel(resource: string): string {
  return SCOPE_RESOURCES.find((row) => row.resource === resource)?.label ?? resource;
}

/** A level as the form names it: Read, Read and write, Admin… */
export function levelLabel(resource: ScopeResource, level: ScopeLevel | "none"): string {
  switch (level) {
    case "none":
      return "No access";
    case "read":
      return "Read";
    case "write":
      return levelsOf(resource).includes("read") ? "Read and write" : "Write";
    case "run":
      return "Run";
    case "delete":
      return "Read, write and delete";
    case "admin":
      return "Admin";
  }
}

/** What a resource's level lets a token do, in plain words. */
export function levelAbout(resource: ScopeResource, level: ScopeLevel | "none"): string | null {
  if (level === "none") return null;
  return describeScope(`${resource}:${level}` as Scope);
}

/** Whether a level is hard to undo or decides who can reach what. */
export function isDangerousLevel(level: ScopeLevel | "none"): boolean {
  return level === "admin" || level === "delete";
}

/** A token's permissions: as identity sends them, or read from its scopes. */
export function tokenPermissions(token: Pick<AccessToken, "scopes" | "permissions">): Permissions {
  return token.permissions && Object.keys(token.permissions).length > 0 ? token.permissions : permissionsOf(token.scopes);
}

/**
 * What the form posts, ready for identity, or what is wrong with it. In
 * `editing`, the reach's workspace and the expiry are the token's own and
 * are not read. `workspaceOwned` is a workspace's own token.
 */
export function tokenFromForm(
  form: FormLike,
  options: { editing?: boolean; workspaceOwned?: boolean; owner?: string | null } = {},
): Parsed<TokenInput> {
  const { editing = false, workspaceOwned = false } = options;
  const name = String(form.get("name") ?? "").trim();
  if (!editing && !name) return { ok: false, error: "Name the token after what will use it." };

  let ttlSeconds: number | null = null;
  if (!editing) {
    const expires = String(form.get("expires") ?? DEFAULT_EXPIRY_DAYS);
    if (expires !== "never") {
      const days = Number(expires);
      if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_LIFETIME_DAYS) {
        return { ok: false, error: `Choose when it expires: at most ${MAX_TOKEN_LIFETIME_DAYS} days, or never.` };
      }
      ttlSeconds = days * 86_400;
    }
  }

  // Where it reaches.
  const reach = String(form.get("workspace") ?? ALL_WORKSPACES).trim().toLowerCase();
  let workspace: string | null = null;
  let repositorySelection: RepositorySelection = "all";
  const posted = String(form.get("repository_selection") ?? "");
  const selection = (["all", "selected", "public"] as const).find((value) => value === posted);
  if (workspaceOwned) {
    repositorySelection = selection === "selected" ? "selected" : "all";
  } else if (reach === NO_WORKSPACE) {
    repositorySelection = "public";
  } else if (reach === ALL_WORKSPACES || reach === "") {
    repositorySelection = "all";
  } else {
    workspace = reach;
    repositorySelection = selection ?? "all";
  }
  const repositories = [...new Set(form.getAll("repo").map((repo) => String(repo).trim()).filter(Boolean))];
  if (repositorySelection === "selected") {
    if (repositories.length === 0) return { ok: false, error: "Choose at least one repository, or all repositories." };
    if (repositories.length > MAX_SELECTED_REPOSITORIES) {
      return { ok: false, error: `A token can reach at most ${MAX_SELECTED_REPOSITORIES} selected repositories.` };
    }
  }

  // What it may do there.
  const permissions: Permissions = {};
  for (const { resource, label } of resourcesFor(workspaceOwned)) {
    const level = String(form.get(`perm.${resource}`) ?? "none");
    if (level === "none" || level === "") continue;
    if (!levelsOf(resource).includes(level as ScopeLevel)) return { ok: false, error: `${label} cannot be ${level}.` };
    permissions[resource] = level as ScopeLevel;
  }
  if (Object.keys(permissions).length === 0) return { ok: false, error: "Give the token at least one permission." };

  return {
    ok: true,
    value: {
      owner: options.owner ?? null,
      name,
      description: String(form.get("description") ?? "").trim() || null,
      ttlSeconds,
      workspace,
      repositorySelection,
      repositories: repositorySelection === "selected" ? repositories : [],
      permissions,
    },
  };
}

/** Where a token reaches, in a few words: "All your workspaces", "acme · 2 repositories". */
export function reachSummary(token: Pick<AccessToken, "workspace" | "repositorySelection" | "repositories" | "workspaceOwned">): string {
  const selection = token.repositorySelection ?? "all";
  const count = token.repositories?.length ?? 0;
  const some = count === 1 ? "1 repository" : `${count} repositories`;
  if (token.workspaceOwned) return selection === "selected" ? some : "All repositories";
  if (!token.workspace) return selection === "public" ? "Your account and public repositories" : "All your workspaces";
  switch (selection) {
    case "all":
      return `${token.workspace} · all repositories`;
    case "public":
      return `${token.workspace} · no private repositories`;
    case "selected":
      return `${token.workspace} · ${some}`;
  }
}

/** A token's permissions as short chips, in the form's order: "Issues: write". */
export function permissionChips(token: Pick<AccessToken, "scopes" | "permissions">): { label: string; dangerous: boolean }[] {
  const permissions = tokenPermissions(token);
  return SCOPE_RESOURCES.filter(({ resource }) => permissions[resource]).map(({ resource, label }) => {
    const level = permissions[resource]!;
    return { label: `${label}: ${level}`, dangerous: isDangerousLevel(level) };
  });
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

/** What a workspace's rules say about a token made for it, for the form. */
export function policyNote(slug: string, policy: TokenPolicy | null | undefined, owner: boolean): string | null {
  if (!policy) return null;
  if (!policy.allowTokensForThisWorkspace) return `${slug} does not allow tokens made for it.`;
  if (policy.requireApproval && !owner) {
    return `An owner of ${slug} must approve this token before it reaches the workspace. Until then it reads public repositories only.`;
  }
  return null;
}

/** The workspaces whose rules keep out a token made for all of yours, with why. */
export function keptOutOfAll(choices: readonly { slug: string; policy: TokenPolicy | null }[]): string[] {
  return choices.filter((choice) => choice.policy && !choice.policy.allowTokensForAllWorkspaces).map((choice) => choice.slug);
}

/** Days a policy's lifetime field holds: a number, or null for no limit. */
export function lifetimeFromForm(value: unknown): Parsed<number | null> {
  const text = String(value ?? "").trim();
  if (text === "" || text === "none") return { ok: true, value: null };
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, error: "The longest lifetime is a whole number of days, 1 to 3650, or none." };
  return { ok: true, value: days };
}

/**
 * Where an old address of the token settings goes now: `?edit=<id>` to the
 * token's page, and `?tab=` (the two kinds tokens used to come in) to the
 * list. Null when the address is current.
 */
export function currentTokensPath(base: string, search: URLSearchParams): string | null {
  const edit = search.get("edit");
  if (edit && /^tok_[A-Za-z0-9]+$/.test(edit)) return `${base}/${edit}`;
  if (search.has("tab") || search.has("edit") || search.has("kind")) return base;
  return null;
}

const sameNames = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  [...(a ?? [])].map((name) => name.toLowerCase()).sort().join(" ") === [...(b ?? [])].map((name) => name.toLowerCase()).sort().join(" ");

/**
 * What the edit form changes about a token, and nothing else: a token made
 * for a workspace that approves tokens asks again only when its
 * repositories or permissions really change.
 */
export function changesTo(token: AccessToken, input: TokenInput): TokenChange {
  const change: TokenChange = {};
  if (input.name && input.name !== token.name) change.name = input.name;
  if ((input.description ?? "") !== (token.description ?? "")) change.description = input.description ?? "";
  if (scopesOfPermissions(input.permissions).join(" ") !== scopesOfPermissions(tokenPermissions(token)).join(" ")) {
    change.permissions = input.permissions;
  }
  if (input.repositorySelection !== (token.repositorySelection ?? "all")) change.repositorySelection = input.repositorySelection;
  if (input.repositorySelection === "selected" && (change.repositorySelection || !sameNames(input.repositories, token.repositories))) {
    change.repositorySelection = "selected";
    change.repositories = input.repositories;
  }
  return change;
}
