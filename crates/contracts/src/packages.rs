//! The packages service: the registries a workspace publishes to and
//! installs from, beside its code (docs.g1t.sh/guides/packages/).
//! Container images first, spoken over the OCI Distribution protocol on
//! `g1t.sh/v2/`; npm, Composer, Cargo, Go, Maven, NuGet and RubyGems after.
//!
//! The site reaches it over `POST /rpc/<method>` with the arguments below;
//! the registries' own protocols are any other request. Mirrors
//! `packages/contracts/src/packages.ts`.
//!
//! Who may do what: a package linked to a repository has that
//! repository's visibility and, unless its admins turned inheriting off,
//! its roles (Read pulls, Write publishes, Admin deletes and changes
//! settings). An unlinked one belongs to its workspace: members by the base
//! permission, owners administer. Either way the roles given on the package
//! itself to people and teams ([`PackageAccess`]) add to those. A workflow
//! job's token reaches a package only from the repository it is linked to,
//! or from a repository given access under Manage Actions access
//! ([`ActionsAccess`]). Public packages pull anonymously.
//!
//! Deleting a package or a version keeps it, hidden, for
//! [`RESTORE_DAYS`]: an admin can restore it until then, and its name (or
//! version) cannot be published again until it is purged.

use serde::{Deserialize, Serialize};

use crate::audit::Surface;
use crate::{User, Viewer};

/// How long a deleted package or version can be restored, in days, before
/// the purge removes it for good.
pub const RESTORE_DAYS: u64 = 30;

/// Which registry a package is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ecosystem {
    Container,
    Npm,
    Composer,
    Cargo,
    Go,
    Maven,
    Nuget,
    Rubygems,
}

impl Ecosystem {
    pub const ALL: [Ecosystem; 8] = [
        Ecosystem::Container,
        Ecosystem::Npm,
        Ecosystem::Composer,
        Ecosystem::Cargo,
        Ecosystem::Go,
        Ecosystem::Maven,
        Ecosystem::Nuget,
        Ecosystem::Rubygems,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Ecosystem::Container => "container",
            Ecosystem::Npm => "npm",
            Ecosystem::Composer => "composer",
            Ecosystem::Cargo => "cargo",
            Ecosystem::Go => "go",
            Ecosystem::Maven => "maven",
            Ecosystem::Nuget => "nuget",
            Ecosystem::Rubygems => "rubygems",
        }
    }

    pub fn parse(text: &str) -> Option<Ecosystem> {
        Ecosystem::ALL.into_iter().find(|e| e.as_str() == text)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Public,
    #[default]
    Private,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Private => "private",
        }
    }

    pub fn parse(text: &str) -> Visibility {
        if text == "public" { Visibility::Public } else { Visibility::Private }
    }
}

/// The repository a package is linked to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedRepo {
    pub id: String,
    pub namespace: String,
    pub name: String,
}

/// A package as listings show it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageSummary {
    pub id: String,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    /// Without the workspace: `web` for `g1t.sh/acme/web`.
    pub name: String,
    /// What a client is given: `g1t.sh/acme/web` for a container image.
    pub address: String,
    /// Linked packages follow their repository's visibility.
    pub visibility: Visibility,
    pub repo: Option<LinkedRepo>,
    pub description: Option<String>,
    pub versions: u32,
    /// The newest version's tag (for a container image, `latest` when it
    /// has one) or version.
    pub latest: Option<String>,
    /// Bytes its versions hold, each file counted once.
    pub size: u64,
    /// Pulls and installs, counted approximately.
    pub downloads: u64,
    pub created_at: String,
    pub updated_at: String,
    /// For a linked package: whether it takes its repository's roles. Its
    /// own grants add to them either way.
    #[serde(default = "yes")]
    pub inherit_access: bool,
    /// Set on a deleted package: when, and by whom (a username).
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// When a deleted package is purged: it can be restored until then.
    #[serde(default)]
    pub purge_at: Option<String>,
}

fn yes() -> bool {
    true
}

/// One version: for a container image, one manifest, by digest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageVersion {
    pub id: String,
    /// A tag, semver or (for container images) the manifest's digest.
    pub version: String,
    pub digest: String,
    /// Bytes of its files: an image's layers, config and manifest.
    pub size: u64,
    pub media_type: Option<String>,
    /// For an OCI artifact: what it is, such as a signature or an SBOM.
    pub artifact_type: Option<String>,
    /// For an artifact attached to another version: that version's digest.
    pub subject: Option<String>,
    /// For an image index: the platforms it holds, such as `linux/amd64`.
    pub platforms: Vec<String>,
    pub tags: Vec<String>,
    /// The username that published it.
    pub published_by: Option<String>,
    pub published_at: String,
    /// npm: why the version should no longer be used, when it is deprecated.
    #[serde(default)]
    pub deprecated: Option<String>,
    /// NuGet: whether a symbol package (`.snupkg`) was pushed for it.
    #[serde(default)]
    pub symbols: bool,
    /// Its own pulls or downloads, counted approximately.
    #[serde(default)]
    pub downloads: Option<u64>,
    /// Set on a deleted version: when, and by whom (a username).
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// When a deleted version is purged: it can be restored until then.
    #[serde(default)]
    pub purge_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageTag {
    pub tag: String,
    pub digest: String,
    pub updated_at: String,
}

/// What the viewer may do with a package.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackagePermissions {
    pub pull: bool,
    pub push: bool,
    /// Delete and restore it and its versions.
    pub delete: bool,
    /// Change its settings: access, Actions access, visibility and link.
    pub admin: bool,
}

/// A role on a package. Read pulls, Write publishes, Admin deletes,
/// restores and changes its settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageRole {
    Read,
    Write,
    Admin,
}

impl PackageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            PackageRole::Read => "read",
            PackageRole::Write => "write",
            PackageRole::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<PackageRole> {
        match text.trim().to_ascii_lowercase().as_str() {
            "read" | "pull" => Some(PackageRole::Read),
            "write" | "push" => Some(PackageRole::Write),
            "admin" => Some(PackageRole::Admin),
            _ => None,
        }
    }

    /// "Read", for sentences.
    pub fn label(self) -> &'static str {
        match self {
            PackageRole::Read => "Read",
            PackageRole::Write => "Write",
            PackageRole::Admin => "Admin",
        }
    }
}

/// Who a [`PackageAccess`] is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GranteeKind {
    User,
    Team,
}

impl GranteeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GranteeKind::User => "user",
            GranteeKind::Team => "team",
        }
    }

    pub fn parse(text: &str) -> Option<GranteeKind> {
        match text {
            "user" => Some(GranteeKind::User),
            "team" => Some(GranteeKind::Team),
            _ => None,
        }
    }
}

/// A person or a team with a role on a package itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAccess {
    pub kind: GranteeKind,
    /// The person's or the team's id.
    pub id: String,
    /// A username, or a team as `workspace/slug`.
    pub name: String,
    pub role: PackageRole,
    pub created_at: String,
}

/// A repository whose workflow jobs may use a package (Manage Actions
/// access). The repository a package is linked to is listed with `linked`
/// set: its jobs may always publish it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionsAccess {
    pub repo_id: String,
    /// `owner/name`.
    pub repo: String,
    /// Read or Write.
    pub role: PackageRole,
    #[serde(default)]
    pub linked: bool,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// `package_settings`: what a package's admins see on its Settings tab.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageSettings {
    pub package: PackageSummary,
    pub access: Vec<PackageAccess>,
    pub actions_access: Vec<ActionsAccess>,
    /// Its deleted versions that can still be restored, newest first.
    pub deleted_versions: Vec<PackageVersion>,
    pub permissions: PackagePermissions,
}

/// `get_package`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageDetail {
    pub package: PackageSummary,
    /// Newest first.
    pub versions: Vec<PackageVersion>,
    pub tags: Vec<PackageTag>,
    pub permissions: PackagePermissions,
    /// The package's README, as markdown: npm's, from its latest version.
    #[serde(default)]
    pub readme: Option<String>,
}

/// `list_packages`: the packages in a workspace the viewer may pull, newest
/// first. Returns `Outcome<Vec<PackageSummary>>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ListPackagesArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default)]
    pub ecosystem: Option<Ecosystem>,
    /// Only those linked to this repository.
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Matched against names.
    #[serde(default)]
    pub query: Option<String>,
}

/// `get_package`. Returns `Outcome<PackageDetail>`; not found when the
/// viewer may not pull it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GetPackageArgs {
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub viewer: Viewer,
}

/// `delete_version`: a version, by its id, version or digest, or by a tag
/// that points to it. It is hidden at once and can be restored for
/// [`RESTORE_DAYS`]; its tags come back with it unless they were moved
/// meanwhile. Needs Admin. Returns `Outcome<()>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeleteVersionArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `delete_package`: a package and every version, hidden at once and
/// restorable for [`RESTORE_DAYS`]; its name stays taken until then.
/// Needs Admin. Returns `Outcome<()>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeletePackageArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `set_package`: change a package's visibility, the repository it is
/// linked to, or whether it takes that repository's roles. `link` names a
/// repository of its workspace (Admin on it is needed too); `unlink` takes
/// the link away (the package is then the workspace's, and private until
/// someone makes it public). A linked package's visibility is its
/// repository's, so `visibility` is refused for one. Needs Admin. Returns
/// `Outcome<PackageSummary>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetPackageArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub visibility: Option<Visibility>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub unlink: bool,
    /// For a linked package: whether it takes its repository's roles.
    #[serde(default)]
    pub inherit_access: Option<bool>,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `package_settings`: a package's access, Actions access and deleted
/// versions. Admins only; not found for anyone who may not pull it.
/// Returns `Outcome<PackageSettings>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageSettingsArgs {
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub viewer: Viewer,
}

/// `list_versions`: a package's versions, newest first: active ones, or
/// with `deleted` the deleted ones that can still be restored (admins
/// only). Returns `Outcome<Vec<PackageVersion>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListVersionsArgs {
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub viewer: Viewer,
    #[serde(default)]
    pub deleted: bool,
}

/// `get_version`: one version by its id, version, digest or a tag that
/// points to it. Returns `Outcome<PackageVersion>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GetVersionArgs {
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub viewer: Viewer,
    pub version: String,
}

/// `restore_package`: a deleted package, with every version it had when it
/// was deleted, while it can still be restored. Needs Admin, as it was.
/// Returns `Outcome<PackageSummary>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestorePackageArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `restore_version`: a deleted version, by its id or version, while it
/// can still be restored. Needs Admin. Returns `Outcome<PackageVersion>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoreVersionArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `deleted_packages`: a workspace's deleted packages that can still be
/// restored, newest deletion first, those the viewer administers. Returns
/// `Outcome<Vec<PackageSummary>>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeletedPackagesArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `set_package_access`: give a person (`user`, a username) or a team
/// (`team`, its slug or `workspace/slug`) a role on the package, or change
/// theirs. Needs Admin. Returns `Outcome<Vec<PackageAccess>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetPackageAccessArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    pub role: PackageRole,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `remove_package_access`: take a person's or a team's role on the
/// package away. Needs Admin. Returns `Outcome<Vec<PackageAccess>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemovePackageAccessArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `set_actions_access`: let a repository of the package's workspace
/// (`repo`, its name or `owner/name`) use the package from its workflows,
/// with the Read or Write role. Needs Admin. Returns
/// `Outcome<Vec<ActionsAccess>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetActionsAccessArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub repo: String,
    pub role: PackageRole,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `remove_actions_access`: stop a repository's workflows using the
/// package. The linked repository cannot be removed: unlink the package
/// instead. Needs Admin. Returns `Outcome<Vec<ActionsAccess>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoveActionsAccessArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    pub repo: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `storage`: what a workspace's packages hold, each file counted once, as
/// public when any public package uses it. For billing. Returns
/// [`PackageStorage`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageArgs {
    pub workspace: String,
}

/// `sync_composer`: read a repository's Composer package again now, as a
/// push would: made, updated or deleted from its branches, tags and
/// `composer.json`. Returns `bool`: whether it is a package.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncComposerArgs {
    pub repo_id: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageStorage {
    pub public_bytes: u64,
    pub private_bytes: u64,
}

/// `storage_all`: [`PackageStorage`] for every workspace that has
/// packages, from one query, for billing's daily measure. Takes `{}`;
/// returns `Vec<WorkspacePackageStorage>`, by workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePackageStorage {
    pub workspace: String,
    pub public_bytes: u64,
    pub private_bytes: u64,
}

/// Every RPC method of the service, as the site's mirror lists them.
pub const METHODS: [&str; 18] = [
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
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_read_back_and_order() {
        for role in [PackageRole::Read, PackageRole::Write, PackageRole::Admin] {
            assert_eq!(PackageRole::parse(role.as_str()), Some(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        assert!(PackageRole::Read < PackageRole::Write && PackageRole::Write < PackageRole::Admin);
        assert_eq!(PackageRole::parse("maintain"), None);
    }

    #[test]
    fn ecosystems_read_back() {
        for ecosystem in Ecosystem::ALL {
            assert_eq!(Ecosystem::parse(ecosystem.as_str()), Some(ecosystem));
            assert_eq!(serde_json::to_value(ecosystem).unwrap(), ecosystem.as_str());
        }
        assert_eq!(Visibility::parse("public"), Visibility::Public);
        assert_eq!(Visibility::parse("anything"), Visibility::Private);
    }

    /// The site's copy, `packages/contracts/src/packages.ts`, names the
    /// same ecosystems and methods.
    #[test]
    fn the_typescript_mirror_names_the_same_ecosystems_and_methods() {
        let ts = include_str!("../../../packages/contracts/src/packages.ts");
        for ecosystem in Ecosystem::ALL {
            assert!(ts.contains(&format!("\"{}\"", ecosystem.as_str())), "{}", ecosystem.as_str());
        }
        for method in METHODS {
            assert!(ts.contains(&format!("\"{method}\"")), "{method}");
        }
    }
}
