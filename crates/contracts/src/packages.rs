//! The packages service: the registries a workspace publishes to and
//! installs from, beside its code (docs/PACKAGES.md). Container images
//! first, spoken over the OCI Distribution protocol on `g1t.sh/v2/`; npm,
//! Composer, Cargo and Go after.
//!
//! The site reaches it over `POST /rpc/<method>` with the arguments below;
//! the registries' own protocols are any other request. Mirrors
//! `packages/contracts/src/packages.ts`.
//!
//! Who may do what: a package linked to a repository has that
//! repository's visibility and roles (Read pulls, Write publishes, Admin
//! deletes and changes settings). An unlinked one belongs to its workspace:
//! members by the base permission, owners delete. Public packages pull
//! anonymously.

use serde::{Deserialize, Serialize};

use crate::audit::Surface;
use crate::{User, Viewer};

/// Which registry a package is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ecosystem {
    Container,
    Npm,
    Composer,
    Cargo,
    Go,
}

impl Ecosystem {
    pub const ALL: [Ecosystem; 5] = [
        Ecosystem::Container,
        Ecosystem::Npm,
        Ecosystem::Composer,
        Ecosystem::Cargo,
        Ecosystem::Go,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Ecosystem::Container => "container",
            Ecosystem::Npm => "npm",
            Ecosystem::Composer => "composer",
            Ecosystem::Cargo => "cargo",
            Ecosystem::Go => "go",
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
    pub delete: bool,
    /// Change its visibility and link.
    pub admin: bool,
}

/// `get_package`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageDetail {
    pub package: PackageSummary,
    /// Newest first.
    pub versions: Vec<PackageVersion>,
    pub tags: Vec<PackageTag>,
    pub permissions: PackagePermissions,
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

/// `delete_version`: a version, by its version or digest, or by a tag that
/// points to it. Its tags go with it. Returns `Outcome<()>`.
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

/// `delete_package`: a package and every version. Returns `Outcome<()>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeletePackageArgs {
    pub actor: User,
    pub workspace: String,
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `set_package`: change a package's visibility, or the repository it is
/// linked to. `link` names a repository of its workspace; `unlink` takes
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

#[cfg(test)]
mod tests {
    use super::*;

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
        for method in ["list_packages", "get_package", "delete_version", "delete_package", "set_package", "storage", "storage_all"] {
            assert!(ts.contains(&format!("\"{method}\"")), "{method}");
        }
    }
}
