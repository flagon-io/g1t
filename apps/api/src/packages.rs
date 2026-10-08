//! Packages over REST and MCP, at GitHub's addresses with the workspace in
//! place of the organization: a workspace's packages and their versions,
//! deleting and restoring them, their visibility and repository, who has a
//! role on them, and which repositories' workflows may use them (Manage
//! Actions access).
//!
//! The packages service decides who may do what (`g1t_contracts::packages`)
//! and records the audit entries; this is its public shape, in snake_case.
//! A package is named by its type (`container`, `npm`, `cargo`, `maven`,
//! `nuget`, `rubygems`, `composer`) and its name, URL-encoded when it holds
//! a slash (`web%2Fworker`).

use g1t_contracts::packages::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on packages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackagesOp {
    ListPackages,
    GetPackage,
    ListVersions,
    GetVersion,
    ListAccess,
    ListActionsAccess,
    UpdatePackage,
    LinkPackage,
    UnlinkPackage,
    SetAccess,
    RemoveAccess,
    SetActionsAccess,
    RemoveActionsAccess,
    DeletePackage,
    RestorePackage,
    DeleteVersion,
    RestoreVersion,
}

impl PackagesOp {
    /// Every one: `Op::ALL` lists each as `Op::Packages(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [PackagesOp; 17] = [
        PackagesOp::ListPackages,
        PackagesOp::GetPackage,
        PackagesOp::ListVersions,
        PackagesOp::GetVersion,
        PackagesOp::ListAccess,
        PackagesOp::ListActionsAccess,
        PackagesOp::UpdatePackage,
        PackagesOp::LinkPackage,
        PackagesOp::UnlinkPackage,
        PackagesOp::SetAccess,
        PackagesOp::RemoveAccess,
        PackagesOp::SetActionsAccess,
        PackagesOp::RemoveActionsAccess,
        PackagesOp::DeletePackage,
        PackagesOp::RestorePackage,
        PackagesOp::DeleteVersion,
        PackagesOp::RestoreVersion,
    ];

    pub fn name(self) -> &'static str {
        match self {
            PackagesOp::ListPackages => "list_packages",
            PackagesOp::GetPackage => "get_package",
            PackagesOp::ListVersions => "list_package_versions",
            PackagesOp::GetVersion => "get_package_version",
            PackagesOp::ListAccess => "list_package_access",
            PackagesOp::ListActionsAccess => "list_package_actions_access",
            PackagesOp::UpdatePackage => "update_package",
            PackagesOp::LinkPackage => "link_package",
            PackagesOp::UnlinkPackage => "unlink_package",
            PackagesOp::SetAccess => "set_package_access",
            PackagesOp::RemoveAccess => "remove_package_access",
            PackagesOp::SetActionsAccess => "set_package_actions_access",
            PackagesOp::RemoveActionsAccess => "remove_package_actions_access",
            PackagesOp::DeletePackage => "delete_package",
            PackagesOp::RestorePackage => "restore_package",
            PackagesOp::DeleteVersion => "delete_package_version",
            PackagesOp::RestoreVersion => "restore_package_version",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            PackagesOp::ListPackages => "List a workspace's packages",
            PackagesOp::GetPackage => "Get a package",
            PackagesOp::ListVersions => "List a package's versions",
            PackagesOp::GetVersion => "Get a package version",
            PackagesOp::ListAccess => "List who has access to a package",
            PackagesOp::ListActionsAccess => "List a package's Actions access",
            PackagesOp::UpdatePackage => "Update a package",
            PackagesOp::LinkPackage => "Link a package to a repository",
            PackagesOp::UnlinkPackage => "Unlink a package from its repository",
            PackagesOp::SetAccess => "Give a person or team a role on a package",
            PackagesOp::RemoveAccess => "Remove a person's or team's role on a package",
            PackagesOp::SetActionsAccess => "Give a repository's workflows access to a package",
            PackagesOp::RemoveActionsAccess => "Remove a repository's Actions access to a package",
            PackagesOp::DeletePackage => "Delete a package",
            PackagesOp::RestorePackage => "Restore a package",
            PackagesOp::DeleteVersion => "Delete a package version",
            PackagesOp::RestoreVersion => "Restore a package version",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            PackagesOp::ListPackages => "List a workspace's packages you may pull, most recently updated first: each with its id, name, package_type, address (what a client is given, such as g1t.sh/acme/web), visibility, the repository it is linked to, version_count, latest, size_in_bytes, download_count, inherit_access and html_url. Narrow with package_type and q (part of the name). With state deleted, its deleted packages that can still be restored instead, those you administer, each with deleted_at, deleted_by and purge_at. Public packages are open to anyone.",
            PackagesOp::GetPackage => "Get one package by its package_type and package_name (URL-encode a slash in a REST path: web%2Fworker). Not found when you may not pull it, as for one that does not exist.",
            PackagesOp::ListVersions => "List a package's versions, newest first: each with its id (ver_…), name (the version, or for a container image its digest), digest, size_in_bytes, download_count, tags, media_type, platforms, published_by and created_at. With state deleted, its deleted versions that can still be restored, with deleted_at, deleted_by and purge_at: for the package's admins only.",
            PackagesOp::GetVersion => "Get one version of a package by its id (ver_…), its version, its digest, or a tag that points to it.",
            PackagesOp::ListAccess => "Who has a role on a package itself (read pulls, write publishes, admin deletes, restores and changes its settings), people and teams, with inherit_access: whether a linked package also takes its repository's roles. Owners of the workspace administer every package. For the package's admins.",
            PackagesOp::ListActionsAccess => "Which repositories' workflows may use a package with their job token (G1T_TOKEN), with the read or write role: its linked repository (linked, always write) and those added under Manage Actions access. A job's token from any other repository is refused. For the package's admins.",
            PackagesOp::UpdatePackage => "Change a package's visibility (public or private: an unlinked package only, as a linked one has its repository's) or, for a linked package, inherit_access: whether it takes its repository's roles. Off, only the roles given on the package itself and the workspace's owners count. Takes the Admin role on the package. Returns the package.",
            PackagesOp::LinkPackage => "Link a package to a repository of its workspace (repository: its name or owner/name): it then has that repository's visibility and, unless inherit_access is off, its roles, and the repository's workflows may publish it. Takes the Admin role on the package and on the repository. Returns the package.",
            PackagesOp::UnlinkPackage => "Unlink a package from its repository: it is then the workspace's, private until someone makes it public, and the repository's workflows lose their access unless it is added under Manage Actions access. Takes the Admin role on the package. Returns the package.",
            PackagesOp::SetAccess => "Give a person (username) or a team of the workspace (team: its slug) the read, write or admin role on a package, or change theirs. It adds to what its repository or workspace gives them. Takes the Admin role on the package. Returns everyone with a role on it.",
            PackagesOp::RemoveAccess => "Take a person's (username) or team's (team) role on a package away. What its repository or workspace gives them stays. Takes the Admin role on the package. Returns everyone left with a role on it.",
            PackagesOp::SetActionsAccess => "Let a repository of the package's workspace (repository: its name or owner/name) use the package from its workflows, with the read or write role, or change its role. Takes the Admin role on the package. Returns the package's Actions access.",
            PackagesOp::RemoveActionsAccess => "Stop a repository's workflows using a package. The linked repository's access cannot be removed: unlink the package instead. Takes the Admin role on the package. Returns the package's Actions access.",
            PackagesOp::DeletePackage => "Delete a package and every version: it is gone from the registries at once, and can be restored for 30 days, during which its name cannot be taken. Takes the Admin role on the package.",
            PackagesOp::RestorePackage => "Restore a deleted package, with the versions it had, while it can be (30 days after it was deleted). Takes the Admin role on it. Returns the package.",
            PackagesOp::DeleteVersion => "Delete one version by its id, version, digest or a tag that points to it: it is gone from the registries at once, with its tags, and can be restored for 30 days. Its version (or digest) cannot be published again until then. Composer versions follow their repository's tags: delete the tag instead. Takes the Admin role on the package.",
            PackagesOp::RestoreVersion => "Restore a deleted version by its id or version, while it can be (30 days after it was deleted), with the tags that still pointed to it. Takes the Admin role on the package. Returns the version.",
        }
    }

    /// Whether it changes anything.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        !matches!(
            self,
            PackagesOp::ListPackages
                | PackagesOp::GetPackage
                | PackagesOp::ListVersions
                | PackagesOp::GetVersion
                | PackagesOp::ListAccess
                | PackagesOp::ListActionsAccess
        )
    }

    /// Whether anyone may call it, signed in or not: reading public packages.
    pub fn anonymous(self) -> bool {
        matches!(self, PackagesOp::ListPackages | PackagesOp::GetPackage | PackagesOp::ListVersions | PackagesOp::GetVersion)
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's slug, e.g. \"flagon-io\"." });
        let package_type = json!({
            "type": "string",
            "enum": ["container", "npm", "cargo", "maven", "nuget", "rubygems", "composer"],
            "description": "The registry: container (also docker), npm, cargo, maven, nuget, rubygems or composer.",
        });
        let package_name = json!({ "type": "string", "description": "The package's name without the workspace: web for g1t.sh/acme/web, web/worker for an image with more parts, group:artifact for Maven." });
        let version_id = json!({ "type": "string", "description": "The version's id (ver_…), its version, its digest, or a tag that points to it." });
        let role = |roles: &[&str]| json!({ "type": "string", "enum": roles, "description": "read pulls, write publishes, admin deletes, restores and changes its settings." });
        let package = |mut properties: Value| {
            properties["workspace"] = workspace.clone();
            properties["package_type"] = package_type.clone();
            properties["package_name"] = package_name.clone();
            properties
        };
        let base = ["workspace", "package_type", "package_name"];
        let (properties, required): (Value, Vec<&str>) = match self {
            PackagesOp::ListPackages => (
                json!({
                    "workspace": workspace,
                    "package_type": package_type,
                    "q": { "type": "string", "description": "Only packages whose name holds this." },
                    "state": { "type": "string", "enum": ["active", "deleted"], "description": "active (the default), or deleted: deleted packages that can still be restored." },
                }),
                vec!["workspace"],
            ),
            PackagesOp::GetPackage
            | PackagesOp::ListAccess
            | PackagesOp::ListActionsAccess
            | PackagesOp::UnlinkPackage
            | PackagesOp::DeletePackage
            | PackagesOp::RestorePackage => (package(json!({})), base.to_vec()),
            PackagesOp::ListVersions => (
                package(json!({
                    "state": { "type": "string", "enum": ["active", "deleted"], "description": "active (the default), or deleted: deleted versions that can still be restored." },
                })),
                base.to_vec(),
            ),
            PackagesOp::GetVersion | PackagesOp::DeleteVersion | PackagesOp::RestoreVersion => {
                (package(json!({ "version_id": version_id })), [base.as_slice(), &["version_id"]].concat())
            }
            PackagesOp::UpdatePackage => (
                package(json!({
                    "visibility": { "type": "string", "enum": ["public", "private"], "description": "Who may pull an unlinked package: anyone, or the workspace's members by its base permission." },
                    "inherit_access": { "type": "boolean", "description": "For a linked package: whether it takes its repository's roles." },
                })),
                base.to_vec(),
            ),
            PackagesOp::LinkPackage => (
                package(json!({ "repository": { "type": "string", "description": "A repository of the package's workspace: its name, or owner/name." } })),
                [base.as_slice(), &["repository"]].concat(),
            ),
            PackagesOp::SetAccess => (
                package(json!({
                    "username": { "type": "string", "description": "The person's username. Give this or team." },
                    "team": { "type": "string", "description": "A team of the workspace: its slug, or workspace/slug. Give this or username." },
                    "role": role(&["read", "write", "admin"]),
                })),
                [base.as_slice(), &["role"]].concat(),
            ),
            PackagesOp::RemoveAccess => (
                package(json!({
                    "username": { "type": "string", "description": "The person's username. Give this or team." },
                    "team": { "type": "string", "description": "The team's slug, or workspace/slug. Give this or username." },
                })),
                base.to_vec(),
            ),
            PackagesOp::SetActionsAccess => (
                package(json!({
                    "repository": { "type": "string", "description": "A repository of the package's workspace: its name, or owner/name." },
                    "role": json!({ "type": "string", "enum": ["read", "write"], "description": "read pulls the package from the repository's workflows; write publishes it too." }),
                })),
                [base.as_slice(), &["repository", "role"]].concat(),
            ),
            PackagesOp::RemoveActionsAccess => (
                package(json!({ "repository": { "type": "string", "description": "The repository: its name, or owner/name." } })),
                [base.as_slice(), &["repository"]].concat(),
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// The registry `package_type` names: GitHub's `docker` is a container
/// image too.
pub(crate) fn ecosystem(text: &str) -> Option<Ecosystem> {
    match text.trim().to_ascii_lowercase().as_str() {
        "docker" | "container" | "oci" => Some(Ecosystem::Container),
        other => Ecosystem::parse(other).filter(|ecosystem| *ecosystem != Ecosystem::Go),
    }
}

/// The page of a package on the site.
fn html_url(site: &str, package: &PackageSummary) -> String {
    format!(
        "{}/{}/-/packages/{}/{}",
        site.trim_end_matches('/'),
        package.workspace,
        package.ecosystem.as_str(),
        package.name
    )
}

/// A package as the API shows one.
pub fn package_json(package: &PackageSummary, site: &str) -> Value {
    json!({
        "id": package.id,
        "name": package.name,
        "package_type": package.ecosystem.as_str(),
        "workspace": package.workspace,
        "address": package.address,
        "visibility": package.visibility.as_str(),
        "repository": package.repo.as_ref().map(|repo| json!({
            "id": repo.id,
            "name": repo.name,
            "full_name": format!("{}/{}", repo.namespace, repo.name),
        })),
        "description": package.description,
        "version_count": package.versions,
        "latest": package.latest,
        "size_in_bytes": package.size,
        "download_count": package.downloads,
        "inherit_access": package.inherit_access,
        "created_at": package.created_at,
        "updated_at": package.updated_at,
        "deleted_at": package.deleted_at,
        "deleted_by": package.deleted_by,
        "purge_at": package.purge_at,
        "html_url": html_url(site, package),
    })
}

/// A version as the API shows one.
pub fn version_json(version: &PackageVersion) -> Value {
    json!({
        "id": version.id,
        "name": version.version,
        "digest": version.digest,
        "size_in_bytes": version.size,
        "download_count": version.downloads.unwrap_or(0),
        "tags": version.tags,
        "media_type": version.media_type,
        "artifact_type": version.artifact_type,
        "subject": version.subject,
        "platforms": version.platforms,
        "published_by": version.published_by,
        "created_at": version.published_at,
        "deprecated": version.deprecated,
        "deleted_at": version.deleted_at,
        "deleted_by": version.deleted_by,
        "purge_at": version.purge_at,
    })
}

fn access_json(access: &[PackageAccess]) -> Value {
    Value::Array(
        access
            .iter()
            .map(|entry| json!({ "type": entry.kind.as_str(), "id": entry.id, "name": entry.name, "role": entry.role.as_str(), "created_at": entry.created_at }))
            .collect(),
    )
}

fn actions_json(access: &[ActionsAccess]) -> Value {
    Value::Array(
        access
            .iter()
            .map(|entry| json!({ "repository_id": entry.repo_id, "repository": entry.repo, "role": entry.role.as_str(), "linked": entry.linked, "created_at": entry.created_at }))
            .collect(),
    )
}

fn mapped<T>(outcome: Outcome<T>, f: impl FnOnce(T) -> Value) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(f(value)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    }
}

async fn call<T: DeserializeOwned>(services: &Services, method: &str, args: &impl Serialize) -> Result<Outcome<T>> {
    g1t_kit::call(&services.packages, method, args).await
}

/// The person making a change, or the refusal for nobody.
fn actor(viewer: &Viewer) -> std::result::Result<User, Outcome<Value>> {
    viewer.clone().ok_or_else(|| Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token."))
}

pub async fn run(op: PackagesOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let site = services.addresses.site.clone();
    let Some(workspace) = text(input, "workspace").map(|w| w.to_lowercase()) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the workspace's slug."));
    };
    if op == PackagesOp::ListPackages {
        let ecosystem = match text(input, "package_type") {
            Some(given) => match ecosystem(&given) {
                Some(found) => Some(found),
                None => return Ok(Outcome::fail(FailureCode::Invalid, format!("{given} is not a package type: container, npm, cargo, maven, nuget, rubygems or composer."))),
            },
            None => None,
        };
        let found: Outcome<Vec<PackageSummary>> = if text(input, "state").as_deref() == Some("deleted") {
            call(services, "deleted_packages", &DeletedPackagesArgs { workspace, viewer: viewer.clone() }).await?
        } else {
            let args = ListPackagesArgs { workspace, viewer: viewer.clone(), ecosystem, repo_id: None, query: text(input, "q") };
            call(services, "list_packages", &args).await?
        };
        return Ok(mapped(found, |list| {
            Value::Array(list.iter().filter(|p| ecosystem.is_none_or(|e| e == p.ecosystem)).map(|p| package_json(p, &site)).collect())
        }));
    }
    let Some(given) = text(input, "package_type") else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the package_type: container, npm, cargo, maven, nuget, rubygems or composer."));
    };
    let Some(ecosystem) = ecosystem(&given) else {
        return Ok(Outcome::fail(FailureCode::Invalid, format!("{given} is not a package type: container, npm, cargo, maven, nuget, rubygems or composer.")));
    };
    let Some(name) = text(input, "package_name") else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the package_name."));
    };
    let surface = Some(services.audit.surface);
    let version = text(input, "version_id").unwrap_or_default();
    if matches!(op, PackagesOp::GetVersion | PackagesOp::DeleteVersion | PackagesOp::RestoreVersion) && version.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the version_id: the version's id, version, digest or a tag."));
    }
    let changed = |outcome: Outcome<PackageSummary>| mapped(outcome, |p| package_json(&p, &site));
    macro_rules! actor {
        () => {
            match actor(viewer) {
                Ok(actor) => actor,
                Err(refused) => return Ok(refused),
            }
        };
    }
    Ok(match op {
        PackagesOp::ListPackages => unreachable!("answered above"),
        PackagesOp::GetPackage => {
            let found: Outcome<PackageDetail> = call(services, "get_package", &GetPackageArgs { workspace, ecosystem, name, viewer: viewer.clone() }).await?;
            mapped(found, |detail| package_json(&detail.package, &site))
        }
        PackagesOp::ListVersions => {
            let deleted = text(input, "state").as_deref() == Some("deleted");
            let found: Outcome<Vec<PackageVersion>> =
                call(services, "list_versions", &ListVersionsArgs { workspace, ecosystem, name, viewer: viewer.clone(), deleted }).await?;
            mapped(found, |list| Value::Array(list.iter().map(version_json).collect()))
        }
        PackagesOp::GetVersion => {
            let found: Outcome<PackageVersion> = call(services, "get_version", &GetVersionArgs { workspace, ecosystem, name, viewer: viewer.clone(), version }).await?;
            mapped(found, |v| version_json(&v))
        }
        PackagesOp::ListAccess | PackagesOp::ListActionsAccess => {
            let found: Outcome<PackageSettings> =
                call(services, "package_settings", &PackageSettingsArgs { workspace, ecosystem, name, viewer: viewer.clone() }).await?;
            mapped(found, |settings| {
                if op == PackagesOp::ListAccess {
                    json!({ "inherit_access": settings.package.inherit_access, "access": access_json(&settings.access) })
                } else {
                    json!({ "repositories": actions_json(&settings.actions_access) })
                }
            })
        }
        PackagesOp::UpdatePackage => {
            let visibility = match text(input, "visibility").as_deref() {
                None => None,
                Some("public") => Some(Visibility::Public),
                Some("private") => Some(Visibility::Private),
                Some(other) => return Ok(Outcome::fail(FailureCode::Invalid, format!("{other} is not a visibility: public or private."))),
            };
            let inherit_access = input["inherit_access"].as_bool();
            if visibility.is_none() && inherit_access.is_none() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give visibility or inherit_access."));
            }
            let args = SetPackageArgs { actor: actor!(), workspace, ecosystem, name, visibility, link: None, unlink: false, inherit_access, surface };
            changed(call(services, "set_package", &args).await?)
        }
        PackagesOp::LinkPackage => {
            let Some(repository) = text(input, "repository") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository: its name, or owner/name."));
            };
            let args = SetPackageArgs { actor: actor!(), workspace, ecosystem, name, visibility: None, link: Some(repository), unlink: false, inherit_access: None, surface };
            changed(call(services, "set_package", &args).await?)
        }
        PackagesOp::UnlinkPackage => {
            let args = SetPackageArgs { actor: actor!(), workspace, ecosystem, name, visibility: None, link: None, unlink: true, inherit_access: None, surface };
            changed(call(services, "set_package", &args).await?)
        }
        PackagesOp::SetAccess => {
            let Some(role) = text(input, "role").and_then(|r| PackageRole::parse(&r)) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the role: read, write or admin."));
            };
            let user = text(input, "username").or_else(|| text(input, "user"));
            let args = SetPackageAccessArgs { actor: actor!(), workspace, ecosystem, name, user, team: text(input, "team"), role, surface };
            mapped(call(services, "set_package_access", &args).await?, |list: Vec<PackageAccess>| access_json(&list))
        }
        PackagesOp::RemoveAccess => {
            let user = text(input, "username").or_else(|| text(input, "user"));
            let args = RemovePackageAccessArgs { actor: actor!(), workspace, ecosystem, name, user, team: text(input, "team"), surface };
            mapped(call(services, "remove_package_access", &args).await?, |list: Vec<PackageAccess>| access_json(&list))
        }
        PackagesOp::SetActionsAccess => {
            let Some(repo) = text(input, "repository") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository: its name, or owner/name."));
            };
            let role = match text(input, "role").and_then(|r| PackageRole::parse(&r)) {
                Some(role @ (PackageRole::Read | PackageRole::Write)) => role,
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "Give the role: read or write.")),
            };
            let args = SetActionsAccessArgs { actor: actor!(), workspace, ecosystem, name, repo, role, surface };
            mapped(call(services, "set_actions_access", &args).await?, |list: Vec<ActionsAccess>| json!({ "repositories": actions_json(&list) }))
        }
        PackagesOp::RemoveActionsAccess => {
            let Some(repo) = text(input, "repository") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository: its name, or owner/name."));
            };
            let args = RemoveActionsAccessArgs { actor: actor!(), workspace, ecosystem, name, repo, surface };
            mapped(call(services, "remove_actions_access", &args).await?, |list: Vec<ActionsAccess>| json!({ "repositories": actions_json(&list) }))
        }
        PackagesOp::DeletePackage => {
            let args = DeletePackageArgs { actor: actor!(), workspace, ecosystem, name, surface };
            mapped(call::<()>(services, "delete_package", &args).await?, |_| json!({ "deleted": true }))
        }
        PackagesOp::RestorePackage => {
            let args = RestorePackageArgs { actor: actor!(), workspace, ecosystem, name, surface };
            changed(call(services, "restore_package", &args).await?)
        }
        PackagesOp::DeleteVersion => {
            let args = DeleteVersionArgs { actor: actor!(), workspace, ecosystem, name, version, surface };
            mapped(call::<()>(services, "delete_version", &args).await?, |_| json!({ "deleted": true }))
        }
        PackagesOp::RestoreVersion => {
            let args = RestoreVersionArgs { actor: actor!(), workspace, ecosystem, name, version, surface };
            mapped(call(services, "restore_version", &args).await?, |v: PackageVersion| version_json(&v))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> PackageSummary {
        PackageSummary {
            id: "pkg_1".into(),
            workspace: "acme".into(),
            ecosystem: Ecosystem::Container,
            name: "web/worker".into(),
            address: "g1t.sh/acme/web/worker".into(),
            visibility: Visibility::Private,
            repo: Some(LinkedRepo { id: "rep_1".into(), namespace: "acme".into(), name: "web".into() }),
            description: None,
            versions: 3,
            latest: Some("latest".into()),
            size: 1024,
            downloads: 7,
            created_at: "2026-10-01T00:00:00.000Z".into(),
            updated_at: "2026-10-02T00:00:00.000Z".into(),
            inherit_access: true,
            deleted_at: None,
            deleted_by: None,
            purge_at: None,
        }
    }

    #[test]
    fn a_package_is_snake_case_with_its_type_and_page() {
        let shown = package_json(&summary(), "https://g1t.sh/");
        assert_eq!(shown["package_type"], "container");
        assert_eq!(shown["repository"]["full_name"], "acme/web");
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/-/packages/container/web/worker");
        assert_eq!(shown["download_count"], 7);
        assert!(g1t_kit::wire::camel_case_keys(&shown).is_empty());
    }

    #[test]
    fn package_types_are_read_as_github_writes_them() {
        assert_eq!(ecosystem("docker"), Some(Ecosystem::Container));
        assert_eq!(ecosystem("NuGet"), Some(Ecosystem::Nuget));
        assert_eq!(ecosystem("go"), None, "Go modules are read from git, not managed here");
        assert_eq!(ecosystem("pypi"), None);
    }

    #[test]
    fn each_operation_is_described_with_a_schema_and_a_scope() {
        use g1t_contracts::scopes::{Level, scope_for};
        for op in PackagesOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Packages(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            let level = scope_for(op.name()).unwrap().level();
            assert_eq!(op.writes(), level != Level::Read, "{}", op.name());
        }
    }
}
