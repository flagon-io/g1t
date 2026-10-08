/**
 * Who may do what in a repository: repository roles, the capabilities each
 * one carries, and how a person's permission is worked out.
 *
 * Mirrors `crates/contracts/src/access.rs`, which holds the one permission
 * table; a test there reads `CAPABILITIES` and `OWNER_ONLY` below and fails
 * when the two differ. Keep each row on one line.
 */
import type { Membership, Role, User } from "./identity";
import type { Result } from "./result";
import type { RepoTeam } from "./teams";

/** What someone may do in one repository, from least to most. */
export type RepoRole = "read" | "triage" | "write" | "maintain" | "admin";

export const REPO_ROLES: readonly RepoRole[] = ["read", "triage", "write", "maintain", "admin"];

export const REPO_ROLE_LABELS: Record<RepoRole, string> = {
  read: "Read",
  triage: "Triage",
  write: "Write",
  maintain: "Maintain",
  admin: "Admin",
};

/** One line on what each role is for, as role pickers show it. */
export const REPO_ROLE_SUMMARIES: Record<RepoRole, string> = {
  read: "Read and clone; open issues and pull requests, and comment.",
  triage: "Read, and manage issues and pull requests: label, assign, close.",
  write: "Triage, and push, merge, and put agents to work.",
  maintain: "Write, and manage settings and branch protection.",
  admin: "Everything: webhooks, secrets, deployments, access, name and visibility.",
};

/** What every member of a workspace gets on each of its repositories. */
export type BasePermission = "none" | "read" | "write" | "admin";

export const BASE_PERMISSIONS: readonly BasePermission[] = ["none", "read", "write", "admin"];

/** Unless an owner changes it: what members could do before roles. */
export const DEFAULT_BASE_PERMISSION: BasePermission = "write";

export const BASE_PERMISSION_LABELS: Record<BasePermission, string> = {
  none: "No permission",
  read: "Read",
  write: "Write",
  admin: "Admin",
};

export type Capability =
  | "read"
  | "participate"
  | "triage"
  | "push"
  | "merge"
  | "run"
  | "manage_settings"
  | "manage_protection"
  | "manage_integrations"
  | "manage_access"
  | "administer"
  | "delete";

/** The permission table: the least role for each capability. */
export const CAPABILITIES = [
  { capability: "read", role: "read", about: "See code, issues and pull requests; clone and fetch" },
  { capability: "participate", role: "read", about: "Open issues and pull requests, and comment" },
  { capability: "triage", role: "triage", about: "Label, assign, close and reopen issues and pull requests" },
  { capability: "push", role: "write", about: "Push to branches that are not protected" },
  { capability: "merge", role: "write", about: "Merge pull requests and use the merge queue" },
  { capability: "run", role: "write", about: "Assign agents and start runs, plans and workflows" },
  { capability: "manage_settings", role: "maintain", about: "Change the description, topics, and pull request and agent settings" },
  { capability: "manage_protection", role: "maintain", about: "Change branch protection and guardrails" },
  { capability: "manage_integrations", role: "admin", about: "Manage webhooks, secrets, variables, deployments and domains" },
  { capability: "manage_access", role: "admin", about: "Manage who has access, invitations and deploy keys" },
  { capability: "administer", role: "admin", about: "Rename, archive, change visibility and the default branch" },
  { capability: "delete", role: "admin", about: "Transfer or delete the repository (owners of the workspace only)" },
] as const satisfies readonly { capability: Capability; role: RepoRole; about: string }[];

/** Capabilities that also need an owner of the repository's workspace. */
export const OWNER_ONLY = ["delete"] as const satisfies readonly Capability[];

/** A person's role on one repository, given directly. */
export type RepoGrant = {
  repo_id: string;
  workspace: string;
  role: RepoRole;
  /** The team it comes through, when it is a team's grant. */
  team?: string;
};

/** What `permission` needs to know about a repository. */
export type RepoRef = { id: string; namespace: string; isPrivate: boolean };

const rank = (role: RepoRole): number => REPO_ROLES.indexOf(role);

/** The higher of two roles; null is lower than any. */
export function maxRole(a: RepoRole | null | undefined, b: RepoRole | null | undefined): RepoRole | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return rank(a) >= rank(b) ? a : b;
}

export function leastRole(capability: Capability): RepoRole {
  return CAPABILITIES.find((row) => row.capability === capability)?.role ?? "admin";
}

/** Whether `role` has `capability`, going by the table alone. */
export function allows(role: RepoRole | null | undefined, capability: Capability): boolean {
  return role != null && rank(role) >= rank(leastRole(capability));
}

export function baseRole(base: BasePermission | null | undefined): RepoRole | null {
  const value = base ?? DEFAULT_BASE_PERMISSION;
  return value === "none" ? null : value;
}

function membershipRole(user: User, membership: Membership): RepoRole | null {
  // A workspace's own token has Write, or Admin when an owner gave it that;
  // g1t, and a service acting as the workspace, do what an owner can.
  if (user.kind === "workspace" && user.token) return user.token.admin ? "admin" : "write";
  if (user.kind === "workspace" || user.kind === "system") return "admin";
  return membership.role === "owner" ? "admin" : baseRole(membership.base_permission);
}

/** The user's role on the repository, not counting that it may be public. */
export function granted(user: User, repo: RepoRef): RepoRole | null {
  // A fine-grained token outside its resource owner or selection: no role.
  const reach = user.token?.fine_grained;
  if (reach) {
    const inside =
      !!reach.workspace &&
      reach.workspace.toLowerCase() === repo.namespace.toLowerCase() &&
      (reach.repositories === "all" || (reach.repositories === "selected" && (reach.repo_ids ?? []).includes(repo.id)));
    if (!inside) return null;
  }
  const namespace = repo.namespace.toLowerCase();
  const membership = user.workspaces?.find((m) => m.slug.toLowerCase() === namespace);
  let role = membership ? membershipRole(user, membership) : null;
  for (const grant of user.grants ?? []) {
    if (grant.repo_id === repo.id) role = maxRole(role, grant.role);
  }
  return role;
}

/** The viewer's effective role on a repository; null means they may not see it. */
export function permission(viewer: User | null | undefined, repo: RepoRef): RepoRole | null {
  const role = viewer ? granted(viewer, repo) : null;
  return repo.isPrivate ? role : maxRole(role, "read");
}

/** Whether the viewer may do `capability` in the repository. */
export function can(viewer: User | null | undefined, repo: RepoRef, capability: Capability): boolean {
  if (!allows(permission(viewer, repo), capability)) return false;
  if ((OWNER_ONLY as readonly Capability[]).includes(capability)) {
    const namespace = repo.namespace.toLowerCase();
    return viewer?.workspaces?.find((m) => m.slug.toLowerCase() === namespace)?.role === "owner";
  }
  return true;
}

/** Every capability, true or false, for one viewer and repository: what pages pass to their components. */
export type Abilities = Record<Capability, boolean>;

export function abilities(viewer: User | null | undefined, repo: RepoRef): Abilities {
  return Object.fromEntries(CAPABILITIES.map((row) => [row.capability, can(viewer, repo, row.capability)])) as Abilities;
}

/** The sentence shown beside something the viewer cannot use. */
export function needs(capability: Capability): string {
  if ((OWNER_ONLY as readonly Capability[]).includes(capability)) return "Only an owner of the workspace can do this.";
  return `Needs the ${REPO_ROLE_LABELS[leastRole(capability)]} role or higher.`;
}

/** Whether the user belongs to the workspace or has a role on one of its repositories. */
export function hasAccessIn(user: User | null | undefined, namespace: string): boolean {
  const slug = namespace.toLowerCase();
  return !!user && (!!user.workspaces?.some((m) => m.slug.toLowerCase() === slug) || !!user.grants?.some((g) => g.workspace.toLowerCase() === slug));
}

/** The workspaces where the user has repositories shared with them without being a member. */
export function sharedWorkspaces(user: User | null | undefined): string[] {
  if (!user) return [];
  const member = new Set((user.workspaces ?? []).map((m) => m.slug));
  return [...new Set((user.grants ?? []).map((g) => g.workspace).filter((slug) => !member.has(slug)))];
}

// --- Who has access ----------------------------------------------------------

export type AccessSource = "owner" | "base" | "direct" | "team";

export type Collaborator = {
  username: string;
  name: string | null;
  avatar: string | null;
  role: RepoRole;
  source: AccessSource;
  direct: RepoRole | null;
  /** Null for an outside collaborator. */
  workspace_role: Role | null;
  /** The highest role a team gives them here, and that team's slug. */
  team_role?: RepoRole | null;
  team?: string | null;
};

export type RepoInvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export type RepoInvitation = {
  id: string;
  /** `workspace/name`. */
  repo: string;
  repo_id: string;
  invitee: string | null;
  email: string | null;
  role: RepoRole;
  invited_by: string | null;
  /** The inviter's avatar hash, served at `/avatars/<avatar>`; null for the generated letter avatar. */
  inviter_avatar?: string | null;
  status: RepoInvitationStatus;
  created_at: string;
  expires_at: string;
};

export type RepoAccess = {
  repo: string;
  base_permission: BasePermission;
  people: Collaborator[];
  /** The workspace's teams given a role on it. */
  teams?: RepoTeam[];
  invitations: RepoInvitation[];
  viewer_role: RepoRole | null;
  can_manage: boolean;
};

export type Added =
  | { result: "granted"; collaborator: Collaborator }
  | { result: "invited"; invitation: RepoInvitation };

export type PermissionInfo = {
  username: string;
  role: RepoRole | null;
  source: AccessSource | null;
  capabilities: Capability[];
};

export type OutsideCollaborator = {
  username: string;
  name: string | null;
  avatar: string | null;
  repos: { repo: string; role: RepoRole }[];
};

/** Identity's access methods, by repository path. */
export interface AccessClient {
  repoAccess(owner: string, name: string, viewer: User | null): Promise<Result<RepoAccess>>;
  addCollaborator(actor: User, owner: string, name: string, invitee: string, role: RepoRole): Promise<Result<Added>>;
  setCollaboratorRole(actor: User, owner: string, name: string, username: string, role: RepoRole): Promise<Result<Collaborator>>;
  removeCollaborator(actor: User, owner: string, name: string, username: string): Promise<Result<boolean>>;
  collaboratorPermission(viewer: User | null, owner: string, name: string, username: string): Promise<Result<PermissionInfo>>;
  myRepoInvitations(user: User): Promise<RepoInvitation[]>;
  respondRepoInvitation(user: User, id: string, accept: boolean): Promise<Result<RepoInvitation>>;
  revokeRepoInvitation(actor: User, owner: string, name: string, id: string): Promise<Result<RepoInvitation>>;
  setBasePermission(actor: User, slug: string, base: BasePermission): Promise<Result<BasePermission>>;
  outsideCollaborators(viewer: User | null, slug: string): Promise<Result<OutsideCollaborator[]>>;
}
