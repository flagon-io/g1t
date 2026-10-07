import type { AuditSurface } from "./audit";
import type { User, Viewer } from "./identity";
import type { Result } from "./result";

/**
 * The packages service: the registries a workspace publishes to and
 * installs from, beside its code (docs/PACKAGES.md). Container images
 * first, on `g1t.sh/v2/`. Mirrors `crates/contracts/src/packages.rs`.
 *
 * A package linked to a repository has its visibility and roles (Read
 * pulls, Write publishes, Admin deletes and changes settings); an unlinked
 * one is its workspace's: members by the base permission, owners delete.
 */

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
};

export type PackageTag = { tag: string; digest: string; updated_at: string };

/** What the viewer may do with a package. `admin`: change its visibility and link. */
export type PackagePermissions = { pull: boolean; push: boolean; delete: boolean; admin: boolean };

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
};

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
  /** For billing. */
  storage(workspace: string): Promise<PackageStorage>;
  /** For billing: every workspace with packages, from one query. */
  storageAll(): Promise<WorkspacePackageStorage[]>;
  /** Read a repository's Composer package again now, as a push would. Whether it is one. */
  syncComposer(repoId: string): Promise<boolean>;
};

/** The RPC method behind each call, as the Rust service names them. */
export const PACKAGES_METHODS = ["list_packages", "get_package", "delete_version", "delete_package", "set_package", "storage", "storage_all", "sync_composer"] as const;
