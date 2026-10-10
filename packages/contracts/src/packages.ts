import type { AuditSurface } from "./audit";
import type { User, Viewer } from "./identity";
import type { Result } from "./result";

/**
 * The packages service: the registries a workspace publishes to and
 * installs from, beside its code (docs.g1t.sh/guides/packages/).
 * Container images first, on `g1t.sh/v2/`. Mirrors
 * `crates/contracts/src/packages.rs`.
 *
 * A package linked to a repository has its visibility and, unless its
 * admins turned inheriting off, its roles (Read pulls, Write publishes,
 * Admin deletes and changes settings); an unlinked one is its workspace's:
 * members by the base permission, owners administer. Roles given on the
 * package itself, to people and teams, add to those. A workflow job's
 * token reaches it from its linked repository, or one listed under Manage
 * Actions access. Deleted packages and versions can be restored for
 * `PACKAGE_RESTORE_DAYS`.
 */

/** How long a deleted package or version can be restored, in days. */
export const PACKAGE_RESTORE_DAYS = 30;

/** Which registry a package is in. */
export const ECOSYSTEMS = ["container", "npm", "composer", "cargo", "go", "maven", "nuget", "rubygems"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export type PackageVisibility = "public" | "private";

export type LinkedRepo = { id: string; namespace: string; name: string };

/** A package as listings show it. */
export type PackageSummary = {
  id: string;
  workspace: string;
  ecosystem: Ecosystem;
  /** Without the workspace: `web` for `g1t.sh/acme/web`. */
  name: string;
  /** What a client is given: `g1t.sh/acme/web` for a container image. */
  address: string;
  /** Linked packages follow their repository's visibility. */
  visibility: PackageVisibility;
  repo: LinkedRepo | null;
  description: string | null;
  versions: number;
  /** The newest version's tag (`latest` when it has one) or version. */
  latest: string | null;
  /** Bytes its versions hold, each file counted once. */
  size: number;
  /** Pulls and installs, counted approximately. */
  downloads: number;
  created_at: string;
  updated_at: string;
  /** For a linked package: whether it takes its repository's roles. */
  inherit_access?: boolean;
  /** Set on a deleted package: when, by whom, and when it is purged. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  purge_at?: string | null;
};

/** One version: for a container image, one manifest, by digest. */
export type PackageVersion = {
  id: string;
  version: string;
  digest: string;
  size: number;
  media_type: string | null;
  /** For an OCI artifact: what it is, such as a signature or an SBOM. */
  artifact_type: string | null;
  /** For an artifact attached to another version: that version's digest. */
  subject: string | null;
  /** For an image index: the platforms it holds, such as `linux/amd64`. */
  platforms: string[];
  tags: string[];
  published_by: string | null;
  published_at: string;
  /** npm: why the version should no longer be used, when it is deprecated. */
  deprecated?: string | null;
  /** NuGet: whether a symbol package (`.snupkg`) was pushed for it. */
  symbols?: boolean;
  /** Its own pulls or downloads, counted approximately. */
  downloads?: number | null;
  /** Set on a deleted version: when, by whom, and when it is purged. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  purge_at?: string | null;
};

export type PackageTag = { tag: string; digest: string; updated_at: string };

/**
 * What the viewer may do with a package. `delete`: delete and restore it
 * and its versions; `admin`: change its settings (access, Actions access,
 * visibility, link).
 */
export type PackagePermissions = { pull: boolean; push: boolean; delete: boolean; admin: boolean };

/** A role on a package: read pulls, write publishes, admin deletes and changes settings. */
export const PACKAGE_ROLES = ["read", "write", "admin"] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];

/** A person or a team with a role on a package itself. */
export type PackageAccess = {
  kind: "user" | "team";
  id: string;
  /** A username, or a team as `workspace/slug`. */
  name: string;
  role: PackageRole;
  created_at: string;
};

/** A repository whose workflows may use a package; `linked` is its own repository, always write. */
export type ActionsAccess = {
  repo_id: string;
  /** `owner/name`. */
  repo: string;
  role: "read" | "write";
  linked: boolean;
  created_at: string | null;
};

/** `package_settings`: what a package's admins see on its Settings tab. */
export type PackageSettings = {
  package: PackageSummary;
  access: PackageAccess[];
  actions_access: ActionsAccess[];
  /** Deleted versions that can still be restored, newest first. */
  deleted_versions: PackageVersion[];
  permissions: PackagePermissions;
};

export type PackageDetail = {
  package: PackageSummary;
  /** Newest first. */
  versions: PackageVersion[];
  tags: PackageTag[];
  permissions: PackagePermissions;
  /** The package's README, as markdown: npm's, from its latest version. */
  readme?: string | null;
};

/** What a workspace's packages hold, for billing: each file once, public when any public package uses it. */
export type PackageStorage = { public_bytes: number; private_bytes: number };

/** `storage_all`: every workspace with packages, by workspace, for billing's daily measure. */
export type WorkspacePackageStorage = { workspace: string; public_bytes: number; private_bytes: number };

export type PackageFilter = { ecosystem?: Ecosystem | null; repoId?: string | null; query?: string | null };

export type PackageChange = {
  visibility?: PackageVisibility;
  /** A repository of the package's workspace, by name. */
  link?: string;
  /** Take the link away. */
  unlink?: boolean;
  /** For a linked package: whether it takes its repository's roles. */
  inheritAccess?: boolean;
};

/** Who a change of access is for: a person by username, or a team by slug. */
export type PackageGrantee = { user: string } | { team: string };

export type PackagesApi = {
  /** The workspace's packages the viewer may pull, newest first. */
  list(workspace: string, viewer: Viewer, filter?: PackageFilter): Promise<Result<PackageSummary[]>>;
  /** Not found when the viewer may not pull it. */
  get(workspace: string, ecosystem: Ecosystem, name: string, viewer: Viewer): Promise<Result<PackageDetail>>;
  /** A version by version, digest or tag; its tags go with it. */
  deleteVersion(actor: User, workspace: string, ecosystem: Ecosystem, name: string, version: string, surface?: AuditSurface): Promise<Result<null>>;
  deletePackage(actor: User, workspace: string, ecosystem: Ecosystem, name: string, surface?: AuditSurface): Promise<Result<null>>;
  /** Needs Admin. A linked package's visibility is its repository's. */
  set(actor: User, workspace: string, ecosystem: Ecosystem, name: string, change: PackageChange, surface?: AuditSurface): Promise<Result<PackageSummary>>;
  /** Admins only: access, Actions access, deleted versions. Not found for anyone who may not pull it. */
  settings(workspace: string, ecosystem: Ecosystem, name: string, viewer: Viewer): Promise<Result<PackageSettings>>;
  /** A workspace's deleted packages the viewer administers that can still be restored. */
  deleted(workspace: string, viewer: Viewer): Promise<Result<PackageSummary[]>>;
  restorePackage(actor: User, workspace: string, ecosystem: Ecosystem, name: string, surface?: AuditSurface): Promise<Result<PackageSummary>>;
  /** A deleted version, by its id or version. */
  restoreVersion(actor: User, workspace: string, ecosystem: Ecosystem, name: string, version: string, surface?: AuditSurface): Promise<Result<PackageVersion>>;
  setAccess(actor: User, workspace: string, ecosystem: Ecosystem, name: string, who: PackageGrantee, role: PackageRole, surface?: AuditSurface): Promise<Result<PackageAccess[]>>;
  removeAccess(actor: User, workspace: string, ecosystem: Ecosystem, name: string, who: PackageGrantee, surface?: AuditSurface): Promise<Result<PackageAccess[]>>;
  /** A repository of the workspace, by name or `owner/name`. */
  setActionsAccess(actor: User, workspace: string, ecosystem: Ecosystem, name: string, repo: string, role: "read" | "write", surface?: AuditSurface): Promise<Result<ActionsAccess[]>>;
  removeActionsAccess(actor: User, workspace: string, ecosystem: Ecosystem, name: string, repo: string, surface?: AuditSurface): Promise<Result<ActionsAccess[]>>;
  /** For billing. */
  storage(workspace: string): Promise<PackageStorage>;
  /** For billing: every workspace with packages, from one query. */
  storageAll(): Promise<WorkspacePackageStorage[]>;
  /** Read a repository's Composer package again now, as a push would. Whether it is one. */
  syncComposer(repoId: string): Promise<boolean>;
};

/** The RPC method behind each call, as the Rust service names them. */
export const PACKAGES_METHODS = [
  "list_packages",
  "get_package",
  "list_versions",
  "get_version",
  "delete_version",
  "delete_package",
  "restore_version",
  "restore_package",
  "deleted_packages",
  "set_package",
  "package_settings",
  "set_package_access",
  "remove_package_access",
  "set_actions_access",
  "remove_actions_access",
  "storage",
  "storage_all",
  "sync_composer",
] as const;
