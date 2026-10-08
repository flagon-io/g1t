//! A package's own settings: who has a role on it (people and teams), its
//! Manage Actions access, whether a linked one inherits its repository's
//! roles; deleting and restoring packages and versions, and the purge 30
//! days on; and linking an image to the repository its source label names.
//!
//! Decisions themselves are access.rs's. What it needs beyond the package
//! row (its grants, its Actions access, the teams the person asking is in)
//! is read only when a first decision without it refuses, so a registry
//! request by someone the repository already allows costs nothing more.

use std::collections::{HashMap, HashSet};

use g1t_contracts::audit::Surface;
use g1t_contracts::credentials::Decision;
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::packages::*;
use g1t_contracts::teams::{ResolveTeamsArgs, ResolvedTeam};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use g1t_kit::now_ms;
use worker::Result;

use crate::access::{self, Action, Grant, RepoAccess};
use crate::db::{PackageRow, TagRow, VersionRow};
use crate::{Caller, Packages, TargetOf, not_found};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// How much one purge removes.
const PURGE_BATCH: u32 = 100;
/// How many deleted versions the settings show.
const DELETED_SHOWN: u32 = 200;

/// When something deleted at `deleted_at` is purged: it can be restored
/// until then.
pub(crate) fn purge_at(deleted_at: &str) -> Option<String> {
    parse_rfc3339(deleted_at).map(|at| rfc3339(at + RESTORE_DAYS * DAY_MS))
}

/// What was deleted before this time is purged now.
pub(crate) fn purge_cutoff(now: u64) -> String {
    rfc3339(now.saturating_sub(RESTORE_DAYS * DAY_MS))
}

/// Whether something deleted at `deleted_at` can still be restored at `now`.
pub(crate) fn restorable(deleted_at: &str, now: u64) -> bool {
    deleted_at >= purge_cutoff(now).as_str()
}

/// A version as the site and the API show it.
pub(crate) fn version_of(package: &PackageRow, version: VersionRow, tags: &[TagRow]) -> PackageVersion {
    // A yanked or unlisted version reads as deprecated: still there for
    // lockfiles that name it, no longer picked for new ones.
    let withdrawn = match package.ecosystem.as_str() {
        "nuget" => "Unlisted: still restored by projects that name it, no longer shown in search.",
        "rubygems" => "Yanked: Bundler no longer picks this version for new lockfiles.",
        _ => "Yanked: Cargo no longer picks this version for new lockfiles.",
    };
    let meta = version.meta();
    let text = |key: &str| meta[key].as_str().map(str::to_owned);
    PackageVersion {
        tags: tags.iter().filter(|tag| tag.version_id == version.id).map(|tag| tag.tag.clone()).collect(),
        media_type: text("media_type"),
        artifact_type: text("artifact_type"),
        platforms: meta["platforms"]
            .as_array()
            .map(|list| list.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        purge_at: version.deleted_at.as_deref().and_then(purge_at),
        id: version.id,
        version: version.version,
        digest: version.digest,
        size: version.size,
        subject: version.subject,
        published_by: version.published_by,
        published_at: version.published_at,
        deprecated: if version.yanked != 0 { Some(withdrawn.to_owned()) } else { version.deprecated },
        symbols: meta["symbols"] == true,
        downloads: Some(version.downloads),
        deleted_at: version.deleted_at,
        deleted_by: version.deleted_by,
    }
}

/// The person whose team memberships count: a person, or the one an
/// agent's run works for.
fn person_id(user: &User) -> Option<String> {
    match user.kind {
        PrincipalKind::User => Some(user.id.clone()),
        PrincipalKind::Agent => user.acting.as_ref().map(|acting| acting.on_behalf_of.id.clone()),
        _ => None,
    }
}

/// The repository a source label names, by name, if it is one of
/// `workspace`'s on this registry's host: `https://g1t.sh/acme/web`, with
/// or without `.git` or a trailing slash.
pub(crate) fn source_repo(label: &str, host: &str, workspace: &str) -> Option<String> {
    let rest = label.trim().strip_prefix("https://")?;
    let (at, path) = rest.split_once('/')?;
    if !at.eq_ignore_ascii_case(host) && !at.eq_ignore_ascii_case(&format!("www.{host}")) {
        return None;
    }
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || !owner.eq_ignore_ascii_case(workspace) || !g1t_contracts::is_valid_repo_name(name) {
        return None;
    }
    Some(name.to_owned())
}

/// The source label of an image: its manifest's annotation, else its
/// config's label.
pub(crate) fn source_label(annotations: Option<&serde_json::Value>, config: Option<&serde_json::Value>) -> Option<String> {
    const KEY: &str = "org.opencontainers.image.source";
    annotations
        .and_then(|annotations| annotations[KEY].as_str())
        .or_else(|| config.and_then(|config| config["config"]["Labels"][KEY].as_str()))
        .map(str::to_owned)
}

fn grants_of(rows: &[crate::db::AccessRow]) -> Vec<Grant> {
    rows.iter()
        .filter_map(|row| {
            Some(Grant {
                kind: GranteeKind::parse(&row.grantee_kind)?,
                id: row.grantee_id.clone(),
                role: PackageRole::parse(&row.role)?,
            })
        })
        .collect()
}

fn actions_of(rows: &[crate::db::ActionsRow]) -> Vec<RepoAccess> {
    rows.iter()
        .filter_map(|row| Some(RepoAccess { name: row.repo_name.clone(), role: PackageRole::parse(&row.role)? }))
        .collect()
}

impl Packages {
    /// Whether `viewer` may `action` the package, reading its grants,
    /// Actions access and the viewer's teams only when the decision
    /// without them refuses.
    pub(crate) async fn decide(&self, viewer: Option<&User>, target: &mut TargetOf, action: Action) -> Result<Decision> {
        let first = access::decide(viewer, &target.view(), action);
        if first.allowed || target.loaded || viewer.is_none() {
            return Ok(first);
        }
        self.load(viewer, std::slice::from_mut(target)).await?;
        Ok(access::decide(viewer, &target.view(), action))
    }

    /// A registry's decision on `action`, and whether the viewer may at
    /// least pull the package (a refusal is then a 403, not a 404).
    pub(crate) async fn check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Result<(Decision, bool)> {
        let mut target = TargetOf::package(package);
        let decision = self.decide(viewer, &mut target, action).await?;
        if decision.allowed {
            return Ok((decision, true));
        }
        let readable = action != Action::Pull && self.decide(viewer, &mut target, Action::Pull).await?.allowed;
        Ok((decision, readable))
    }

    /// Everything `viewer` may do with the package, for the site.
    pub(crate) async fn permissions(&self, viewer: Option<&User>, target: &mut TargetOf) -> Result<PackagePermissions> {
        if viewer.is_some() && !target.loaded {
            self.load(viewer, std::slice::from_mut(target)).await?;
        }
        Ok(access::permissions(viewer, &target.view()))
    }

    /// Whether `viewer` may `action` each package, reading what the
    /// refused ones need in one query.
    pub(crate) async fn may_all(&self, viewer: Option<&User>, packages: &[&PackageRow], action: Action) -> Result<Vec<bool>> {
        let mut targets: Vec<TargetOf> = packages.iter().map(|package| TargetOf::package(package)).collect();
        let mut may: Vec<bool> = targets.iter().map(|target| access::decide(viewer, &target.view(), action).allowed).collect();
        if viewer.is_none() || may.iter().all(|allowed| *allowed) {
            return Ok(may);
        }
        let refused: Vec<usize> = (0..targets.len()).filter(|at| !may[*at]).collect();
        let mut again: Vec<TargetOf> = refused.iter().map(|at| std::mem::replace(&mut targets[*at], TargetOf::unmade("", "", None))).collect();
        self.load(viewer, &mut again).await?;
        for (at, target) in refused.into_iter().zip(again) {
            may[at] = access::decide(viewer, &target.view(), action).allowed;
        }
        Ok(may)
    }

    /// Reads the grants and Actions access of packages that are made, and
    /// which of their granted teams the person asking is in.
    async fn load(&self, viewer: Option<&User>, targets: &mut [TargetOf]) -> Result<()> {
        let ids: Vec<String> = targets.iter().filter_map(|target| target.package_id.clone()).collect();
        if ids.is_empty() {
            for target in targets.iter_mut() {
                target.loaded = true;
            }
            return Ok(());
        }
        let access = self.db.access(&ids).await?;
        let actions = self.db.actions_access(&ids).await?;
        // The teams granted anything, by workspace and slug, once.
        let mut teams: Vec<(String, String)> = Vec::new();
        for target in targets.iter() {
            for row in access.iter().filter(|row| Some(&row.package_id) == target.package_id.as_ref() && row.grantee_kind == "team") {
                let name = (row.grantee_id.clone(), format!("{}/{}", target.workspace, row.grantee_name));
                if !teams.contains(&name) {
                    teams.push(name);
                }
            }
        }
        let mine = match viewer.and_then(person_id) {
            Some(person) if !teams.is_empty() => self.teams_with(&person, teams.into_iter().map(|(_, name)| name).collect()).await?,
            _ => HashSet::new(),
        };
        for target in targets.iter_mut() {
            let Some(id) = target.package_id.clone() else {
                target.loaded = true;
                continue;
            };
            let own: Vec<_> = access.iter().filter(|row| row.package_id == id).cloned().collect();
            let repos: Vec<_> = actions.iter().filter(|row| row.package_id == id).cloned().collect();
            target.grants = grants_of(&own);
            target.actions = actions_of(&repos);
            target.teams = target.grants.iter().filter(|grant| mine.contains(&grant.id)).map(|grant| grant.id.clone()).collect();
            target.loaded = true;
        }
        Ok(())
    }

    /// Which of these teams (`workspace/slug`) the person is in, by id,
    /// counting their child teams' people.
    async fn teams_with(&self, person: &str, names: Vec<String>) -> Result<HashSet<String>> {
        let resolved: Vec<ResolvedTeam> = g1t_kit::call(
            &self.identity,
            "resolve_teams",
            &ResolveTeamsArgs { teams: names, repo_id: None, asker: None },
        )
        .await?;
        Ok(resolved
            .into_iter()
            .filter(|team| team.members.iter().chain(&team.child_members).any(|member| member.id == person))
            .map(|team| team.id)
            .collect())
    }

    /// A package by name, deleted or not, with whether `viewer` may see it.
    async fn package_any(&self, workspace: &str, ecosystem: Ecosystem, name: &str) -> Result<Option<PackageRow>> {
        Ok(self
            .db
            .package(&workspace.to_lowercase(), ecosystem.as_str(), name)
            .await?
            .filter(|package| package.workspace_deleted_at.is_none()))
    }

    /// The package `viewer` may pull, not deleted.
    async fn readable(&self, viewer: &Viewer, workspace: &str, ecosystem: Ecosystem, name: &str) -> Result<Option<(PackageRow, TargetOf)>> {
        let Some(package) = self.package_any(workspace, ecosystem, name).await?.filter(|package| package.deleted_at.is_none()) else {
            return Ok(None);
        };
        let mut target = TargetOf::package(&package);
        if !self.decide(viewer.as_ref(), &mut target, Action::Pull).await?.allowed {
            return Ok(None);
        }
        Ok(Some((package, target)))
    }

    pub(crate) async fn list_versions(&self, a: ListVersionsArgs) -> Result<Outcome<Vec<PackageVersion>>> {
        let Some((package, mut target)) = self.readable(&a.viewer, &a.workspace, a.ecosystem, &a.name).await? else {
            return Ok(not_found());
        };
        if a.deleted {
            if !self.decide(a.viewer.as_ref(), &mut target, Action::Settings).await?.allowed {
                return Ok(Outcome::fail(FailureCode::Forbidden, "Only an admin of the package can see its deleted versions."));
            }
            let versions = self.db.deleted_versions(&package.id, DELETED_SHOWN).await?;
            return Ok(Outcome::Ok(versions.into_iter().map(|version| version_of(&package, version, &[])).collect()));
        }
        let tags = self.db.tags(&package.id).await?;
        let versions = self.db.versions(&package.id, crate::VERSIONS_SHOWN).await?;
        Ok(Outcome::Ok(versions.into_iter().map(|version| version_of(&package, version, &tags)).collect()))
    }

    pub(crate) async fn get_version(&self, a: GetVersionArgs) -> Result<Outcome<PackageVersion>> {
        let Some((package, _)) = self.readable(&a.viewer, &a.workspace, a.ecosystem, &a.name).await? else {
            return Ok(not_found());
        };
        let Some(version) = self.db.find_version(&package.id, a.version.trim()).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Version not found."));
        };
        let tags = self.db.tags(&package.id).await?;
        Ok(Outcome::Ok(version_of(&package, version, &tags)))
    }

    /// Deletes a version: hidden at once, restorable for 30 days; its
    /// version string cannot be published again until it is purged.
    pub(crate) async fn remove_version_from(&self, package: &PackageRow, version: &VersionRow, caller: &Caller, surface: Option<Surface>) -> Result<()> {
        let by = caller.actor.as_ref().map_or("", |actor| actor.actor.as_str());
        self.db.soft_delete_version(&version.id, by, now_ms()).await?;
        self.db.measure(&package.workspace).await?;
        let event = g1t_contracts::events::PackageEvent {
            version: Some(version.version.clone()),
            digest: Some(version.digest.clone()),
            ..self.event_of(package)
        };
        self.announce("package.version_deleted", package, event, caller).await;
        self.audit_with(
            caller,
            "package.delete_version",
            package,
            Some(&self.version_path(package, version)),
            surface,
            Some(format!("Deleted the version; it can be restored for {RESTORE_DAYS} days")),
        )
        .await;
        Ok(())
    }

    /// How audit entries name a version: an image (and a Composer version,
    /// by its commit) by its digest, every other package by its version.
    pub(crate) fn version_path(&self, package: &PackageRow, version: &VersionRow) -> String {
        if package.ecosystem == "npm" {
            format!("@{}/{}@{}", package.workspace, package.name, version.version)
        } else if !matches!(package.ecosystem.as_str(), "container" | "composer") {
            format!("{}/{}@{}", package.workspace, package.name, version.version)
        } else {
            format!("{}/{}@{}", package.workspace, package.name, version.digest)
        }
    }

    pub(crate) async fn restore_version(&self, a: RestoreVersionArgs) -> Result<Outcome<PackageVersion>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(version) = self.db.deleted_version(&package.id, a.version.trim()).await?.filter(|v| v.deleted_at.as_deref().is_some_and(|at| restorable(at, now_ms()))) else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("No deleted version {} of {} can be restored: it was never deleted, or was purged.", a.version.trim(), package.name),
            ));
        };
        let now = now_ms();
        self.db.restore_version(&package.id, &version.id, now).await?;
        self.db.measure(&package.workspace).await?;
        let caller = Caller::of(Some(&a.actor));
        self.audit_with(
            &caller,
            "package.restore_version",
            &package,
            Some(&self.version_path(&package, &version)),
            a.surface,
            Some("Restored the version".to_owned()),
        )
        .await;
        let tags = self.db.tags(&package.id).await?;
        let restored = VersionRow { deleted_at: None, deleted_by: None, ..version };
        Ok(Outcome::Ok(version_of(&package, restored, &tags)))
    }

    pub(crate) async fn restore_package(&self, a: RestorePackageArgs) -> Result<Outcome<PackageSummary>> {
        let Some(package) = self.package_any(&a.workspace, a.ecosystem, &a.name).await?.filter(|package| package.deleted_at.as_deref().is_some_and(|at| restorable(at, now_ms()))) else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("There is no deleted package {} to restore: it was never deleted, or was purged.", a.name),
            ));
        };
        match self.allowed(&a.actor, &package, Action::Delete).await? {
            Outcome::Ok(()) => {}
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
        self.db.restore_package(&package.id, now_ms()).await?;
        self.db.measure(&package.workspace).await?;
        let caller = Caller::of(Some(&a.actor));
        self.audit_with(&caller, "package.restore", &package, None, a.surface, Some("Restored the package".to_owned())).await;
        let Some(row) = self.listed(&package.workspace, a.ecosystem, &package.name).await? else {
            return Ok(not_found());
        };
        Ok(Outcome::Ok(self.summary(&row)))
    }

    pub(crate) async fn deleted_packages(&self, a: DeletedPackagesArgs) -> Result<Outcome<Vec<PackageSummary>>> {
        if a.viewer.is_none() {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to see deleted packages."));
        }
        let rows = self.db.deleted_packages(&a.workspace.to_lowercase(), crate::LIST_LIMIT).await?;
        let packages: Vec<&PackageRow> = rows.iter().map(|row| &row.package).collect();
        let may = self.may_all(a.viewer.as_ref(), &packages, Action::Settings).await?;
        Ok(Outcome::Ok(rows.iter().zip(may).filter(|(_, may)| *may).map(|(row, _)| self.summary(row)).collect()))
    }

    /// The package `viewer` administers, for its settings.
    async fn administered(&self, viewer: &User, workspace: &str, ecosystem: Ecosystem, name: &str) -> Result<Outcome<PackageRow>> {
        self.for_change(viewer, workspace, ecosystem, name, Action::Admin).await
    }

    async fn access_list(&self, package: &PackageRow) -> Result<Vec<PackageAccess>> {
        Ok(self
            .db
            .access(std::slice::from_ref(&package.id))
            .await?
            .into_iter()
            .filter_map(|row| {
                let kind = GranteeKind::parse(&row.grantee_kind)?;
                Some(PackageAccess {
                    name: match kind {
                        GranteeKind::Team => format!("{}/{}", package.workspace, row.grantee_name),
                        GranteeKind::User => row.grantee_name,
                    },
                    kind,
                    id: row.grantee_id,
                    role: PackageRole::parse(&row.role)?,
                    created_at: row.created_at,
                })
            })
            .collect())
    }

    async fn actions_list(&self, package: &PackageRow) -> Result<Vec<ActionsAccess>> {
        let mut list = Vec::new();
        if let (Some(id), Some(name)) = (&package.repo_id, &package.repo_name) {
            list.push(ActionsAccess {
                repo_id: id.clone(),
                repo: format!("{}/{name}", package.workspace),
                role: PackageRole::Write,
                linked: true,
                created_at: None,
            });
        }
        for row in self.db.actions_access(std::slice::from_ref(&package.id)).await? {
            if Some(&row.repo_id) == package.repo_id.as_ref() {
                continue;
            }
            let Some(role) = PackageRole::parse(&row.role) else { continue };
            list.push(ActionsAccess {
                repo_id: row.repo_id,
                repo: format!("{}/{}", package.workspace, row.repo_name),
                role,
                linked: false,
                created_at: Some(row.created_at),
            });
        }
        Ok(list)
    }

    pub(crate) async fn package_settings(&self, a: PackageSettingsArgs) -> Result<Outcome<PackageSettings>> {
        let Some(viewer) = a.viewer.as_ref() else {
            return Ok(not_found());
        };
        let package = match self.for_change(viewer, &a.workspace, a.ecosystem, &a.name, Action::Settings).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(row) = self.listed(&package.workspace, a.ecosystem, &package.name).await? else {
            return Ok(not_found());
        };
        let mut target = TargetOf::package(&package);
        let permissions = self.permissions(a.viewer.as_ref(), &mut target).await?;
        let deleted_versions = if permissions.delete {
            self.db
                .deleted_versions(&package.id, DELETED_SHOWN)
                .await?
                .into_iter()
                .map(|version| version_of(&package, version, &[]))
                .collect()
        } else {
            Vec::new()
        };
        Ok(Outcome::Ok(PackageSettings {
            package: self.summary(&row),
            access: self.access_list(&package).await?,
            actions_access: self.actions_list(&package).await?,
            deleted_versions,
            permissions,
        }))
    }

    /// The person or team a change of access names: (kind, id, name kept).
    async fn grantee(&self, package: &PackageRow, user: Option<&str>, team: Option<&str>) -> Result<Outcome<(GranteeKind, String, String)>> {
        let clean = |text: &str| text.trim().trim_start_matches('@').to_lowercase();
        match (user.map(clean).filter(|u| !u.is_empty()), team.map(clean).filter(|t| !t.is_empty())) {
            (Some(username), None) => {
                let found: Viewer = g1t_kit::call(&self.identity, "user_by_username", &UsernameArgs { username: username.clone() }).await?;
                match found {
                    Some(person) if person.kind == PrincipalKind::User => Ok(Outcome::Ok((GranteeKind::User, person.id, person.username))),
                    _ => Ok(Outcome::fail(FailureCode::NotFound, format!("There is no one called {username} on g1t."))),
                }
            }
            (None, Some(team)) => {
                let slug = match team.split_once('/') {
                    Some((owner, slug)) if owner == package.workspace => slug.to_owned(),
                    Some(_) => {
                        return Ok(Outcome::fail(FailureCode::Invalid, format!("Only a team of {} can have a role on its packages.", package.workspace)));
                    }
                    None => team,
                };
                let resolved: Vec<ResolvedTeam> = g1t_kit::call(
                    &self.identity,
                    "resolve_teams",
                    &ResolveTeamsArgs { teams: vec![format!("{}/{slug}", package.workspace)], repo_id: None, asker: None },
                )
                .await?;
                match resolved.into_iter().next() {
                    Some(found) => Ok(Outcome::Ok((GranteeKind::Team, found.id, found.slug))),
                    None => Ok(Outcome::fail(FailureCode::NotFound, format!("There is no team {}/{slug}.", package.workspace))),
                }
            }
            _ => Ok(Outcome::fail(FailureCode::Invalid, "Name one person (user, a username) or one team (team, its slug).")),
        }
    }

    pub(crate) async fn set_package_access(&self, a: SetPackageAccessArgs) -> Result<Outcome<Vec<PackageAccess>>> {
        let package = match self.administered(&a.actor, &a.workspace, a.ecosystem, &a.name).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (kind, id, name) = match self.grantee(&package, a.user.as_deref(), a.team.as_deref()).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let before = self
            .db
            .access(std::slice::from_ref(&package.id))
            .await?
            .into_iter()
            .find(|row| row.grantee_kind == kind.as_str() && row.grantee_id == id)
            .and_then(|row| PackageRole::parse(&row.role));
        if before == Some(a.role) {
            return Ok(Outcome::Ok(self.access_list(&package).await?));
        }
        self.db.set_access(&package.id, kind.as_str(), &id, &name, a.role.as_str(), &a.actor.username, now_ms()).await?;
        let who = match kind {
            GranteeKind::User => name.clone(),
            GranteeKind::Team => format!("the team {}/{name}", package.workspace),
        };
        let (action, message) = match before {
            None => ("package.access_added", format!("Gave {who} the {} role", a.role.label())),
            Some(was) => ("package.access_role_changed", format!("Changed {who}'s role from {} to {}", was.label(), a.role.label())),
        };
        self.audit_with(&Caller::of(Some(&a.actor)), action, &package, None, a.surface, Some(message)).await;
        Ok(Outcome::Ok(self.access_list(&package).await?))
    }

    pub(crate) async fn remove_package_access(&self, a: RemovePackageAccessArgs) -> Result<Outcome<Vec<PackageAccess>>> {
        let package = match self.administered(&a.actor, &a.workspace, a.ecosystem, &a.name).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // Matched against what is kept, so someone renamed or a team
        // since deleted can still be taken off.
        let clean = |text: &str| text.trim().trim_start_matches('@').to_lowercase();
        let (kind, wanted) = match (a.user.as_deref().map(clean), a.team.as_deref().map(clean)) {
            (Some(user), None) if !user.is_empty() => (GranteeKind::User, user),
            (None, Some(team)) if !team.is_empty() => {
                let slug = team.rsplit_once('/').map_or(team.clone(), |(_, slug)| slug.to_owned());
                (GranteeKind::Team, slug)
            }
            _ => return Ok(Outcome::fail(FailureCode::Invalid, "Name one person (user, a username) or one team (team, its slug).")),
        };
        let found = self
            .db
            .access(std::slice::from_ref(&package.id))
            .await?
            .into_iter()
            .find(|row| row.grantee_kind == kind.as_str() && (row.grantee_name.eq_ignore_ascii_case(&wanted) || row.grantee_id == wanted));
        let Some(found) = found else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{wanted} has no role on the package itself.")));
        };
        self.db.remove_access(&package.id, kind.as_str(), &found.grantee_id).await?;
        let who = match kind {
            GranteeKind::User => found.grantee_name.clone(),
            GranteeKind::Team => format!("the team {}/{}", package.workspace, found.grantee_name),
        };
        self.audit_with(
            &Caller::of(Some(&a.actor)),
            "package.access_removed",
            &package,
            None,
            a.surface,
            Some(format!("Took {who}'s {} role away", PackageRole::parse(&found.role).map_or("", PackageRole::label))),
        )
        .await;
        Ok(Outcome::Ok(self.access_list(&package).await?))
    }

    /// The repository of the package's workspace `repo` names (its name, or
    /// `owner/name`).
    async fn workspace_repo(&self, package: &PackageRow, repo: &str) -> Result<Outcome<g1t_contracts::repos::Repo>> {
        let repo = repo.trim().trim_end_matches(".git");
        let name = match repo.split_once('/') {
            Some((owner, name)) if owner.eq_ignore_ascii_case(&package.workspace) => name,
            Some(_) => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("Only repositories of {} can be given access to its packages.", package.workspace),
                ));
            }
            None => repo,
        };
        match self.repo_by_name(&package.workspace, name).await? {
            Some(found) => Ok(Outcome::Ok(found)),
            None => Ok(Outcome::fail(FailureCode::NotFound, format!("There is no repository {}/{name}.", package.workspace))),
        }
    }

    pub(crate) async fn set_actions_access(&self, a: SetActionsAccessArgs) -> Result<Outcome<Vec<ActionsAccess>>> {
        let package = match self.administered(&a.actor, &a.workspace, a.ecosystem, &a.name).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if a.role == PackageRole::Admin {
            return Ok(Outcome::fail(FailureCode::Invalid, "A repository's workflows can have the read or write role on a package."));
        }
        let repo = match self.workspace_repo(&package, &a.repo).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if package.repo_id.as_deref() == Some(repo.id.as_str()) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("{}/{} is the package's own repository: its workflows can always publish it.", repo.namespace, repo.name),
            ));
        }
        let before = self
            .db
            .actions_access(std::slice::from_ref(&package.id))
            .await?
            .into_iter()
            .find(|row| row.repo_id == repo.id)
            .and_then(|row| PackageRole::parse(&row.role));
        if before != Some(a.role) {
            self.db.set_actions(&package.id, &repo.id, &repo.name, a.role.as_str(), &a.actor.username, now_ms()).await?;
            let (action, message) = match before {
                None => ("package.actions_access_added", format!("Let {}/{}'s workflows use it with the {} role", repo.namespace, repo.name, a.role.label())),
                Some(was) => (
                    "package.actions_access_role_changed",
                    format!("Changed {}/{}'s workflows' role from {} to {}", repo.namespace, repo.name, was.label(), a.role.label()),
                ),
            };
            self.audit_with(&Caller::of(Some(&a.actor)), action, &package, None, a.surface, Some(message)).await;
        }
        Ok(Outcome::Ok(self.actions_list(&package).await?))
    }

    pub(crate) async fn remove_actions_access(&self, a: RemoveActionsAccessArgs) -> Result<Outcome<Vec<ActionsAccess>>> {
        let package = match self.administered(&a.actor, &a.workspace, a.ecosystem, &a.name).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let wanted = a.repo.trim().trim_end_matches(".git");
        let wanted = wanted.rsplit_once('/').map_or(wanted, |(_, name)| name);
        if package.repo_name.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(wanted)) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "The package's own repository keeps its access: unlink the package to take it away.",
            ));
        }
        let Some(found) = self
            .db
            .actions_access(std::slice::from_ref(&package.id))
            .await?
            .into_iter()
            .find(|row| row.repo_name.eq_ignore_ascii_case(wanted) || row.repo_id == wanted)
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{}/{wanted} has no Actions access to the package.", package.workspace)));
        };
        self.db.remove_actions(&package.id, &found.repo_id).await?;
        self.audit_with(
            &Caller::of(Some(&a.actor)),
            "package.actions_access_removed",
            &package,
            None,
            a.surface,
            Some(format!("Stopped {}/{}'s workflows using it", package.workspace, found.repo_name)),
        )
        .await;
        Ok(Outcome::Ok(self.actions_list(&package).await?))
    }

    /// Removes for good what was deleted more than 30 days ago. Its files
    /// go with the sweep a day later, as any unused file does.
    pub(crate) async fn purge(&self, now: u64) -> Result<(u32, u32)> {
        let before = purge_cutoff(now);
        let caller = Caller::system();
        let mut packages = 0;
        let mut workspaces: HashSet<String> = HashSet::new();
        for package in self.db.expired_packages(&before, PURGE_BATCH).await? {
            self.db.delete_package(&package.id).await?;
            self.audit_with(&caller, "package.purged", &package, None, Some(Surface::Registry), Some("Removed for good, 30 days after it was deleted".to_owned())).await;
            workspaces.insert(package.workspace.clone());
            packages += 1;
        }
        let mut versions = 0;
        let mut owners: HashMap<String, Option<PackageRow>> = HashMap::new();
        for version in self.db.expired_versions(&before, PURGE_BATCH).await? {
            if !owners.contains_key(&version.package_id) {
                let owner = self.db.package_by_id(&version.package_id).await?;
                owners.insert(version.package_id.clone(), owner);
            }
            self.db.delete_version(&version.id).await?;
            if let Some(Some(package)) = owners.get(&version.package_id) {
                workspaces.insert(package.workspace.clone());
            }
            versions += 1;
        }
        for workspace in workspaces {
            self.db.measure(&workspace).await?;
        }
        Ok((packages, versions))
    }

    /// Why nothing can be published to a hidden package: deleted (its name
    /// is kept until the purge), or its workspace is.
    pub(crate) fn hidden_refusal(package: &PackageRow) -> String {
        match package.deleted_at.as_deref() {
            Some(at) => format!(
                "The package {} was deleted. Its name is kept until {} in case it is restored: an admin can restore it from the workspace's deleted packages, or publish under another name.",
                package.name,
                purge_at(at).map_or_else(|| "it is purged".to_owned(), |purge| purge[..10].to_owned())
            ),
            None => format!("The workspace {} is deleted; nothing can be published to it.", package.workspace),
        }
    }

    /// Why `version` cannot be published to the package, if it is a deleted
    /// version's (by version string or digest) that can still be restored.
    pub(crate) async fn reserved_refusal(&self, package: &PackageRow, version: &str) -> Result<Option<String>> {
        Ok(self.db.deleted_version(&package.id, version).await?.map(|deleted| {
            let until = deleted.deleted_at.as_deref().and_then(purge_at).map_or_else(|| "it is purged".to_owned(), |at| at[..10].to_owned());
            format!(
                "{} {} was deleted, and a deleted version cannot be published again until {until}. Restore it from the package's settings, or publish another version.",
                package.name, deleted.version
            )
        }))
    }

    /// Makes a package on its first push. One a workflow job makes that is
    /// not linked to its repository lets that repository's workflows write
    /// it, as Manage Actions access says.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn make_package(
        &self,
        workspace: &str,
        ecosystem: &str,
        name: &str,
        repo: Option<(&str, &str, bool)>,
        caller: &Caller,
        now: u64,
    ) -> Result<PackageRow> {
        let package = self
            .db
            .create_package(
                &g1t_contracts::new_id("pkg", now),
                workspace,
                ecosystem,
                name,
                repo,
                caller.actor.as_ref().map_or("", |actor| actor.actor_id.as_str()),
                now,
            )
            .await?;
        let job_repo = caller
            .viewer
            .as_ref()
            .and_then(|user| user.token.as_deref())
            .filter(|token| token.job.is_some())
            .and_then(|token| token.repo.clone());
        if let Some(job) = job_repo
            && let Some((owner, repo_name)) = job.split_once('/')
            && owner.eq_ignore_ascii_case(workspace)
            && package.repo_name.as_deref().is_none_or(|linked| !linked.eq_ignore_ascii_case(repo_name))
            && let Some(found) = self.repo_by_name(workspace, repo_name).await?
        {
            self.db.set_actions(&package.id, &found.id, &found.name, PackageRole::Write.as_str(), &format!("{workspace}/{repo_name}"), now).await?;
        }
        Ok(package)
    }

    /// Links an image to the repository its source label names, on its
    /// first push or while it is unlinked, when that is a repository of its
    /// workspace and the pusher may publish its packages. Says whether it
    /// linked it.
    pub(crate) async fn link_by_source(&self, package: &PackageRow, label: &str, caller: &Caller, first: bool) -> Result<Option<PackageRow>> {
        if !first && package.repo_id.is_some() {
            return Ok(None);
        }
        let Some(name) = source_repo(label, &self.host, &package.workspace) else {
            return Ok(None);
        };
        if package.repo_name.as_deref().is_some_and(|linked| linked.eq_ignore_ascii_case(&name)) {
            return Ok(None);
        }
        let Some(repo) = self.repo_by_name(&package.workspace, &name).await? else {
            return Ok(None);
        };
        // The pusher must be able to publish that repository's packages:
        // Write on it, through a token that reaches it.
        let mut target = TargetOf::unmade(&package.workspace, &package.name, Some((repo.id.clone(), repo.name.clone(), repo.is_private)));
        if !self.decide(caller.viewer.as_ref(), &mut target, Action::Push).await?.allowed {
            return Ok(None);
        }
        let visibility = if repo.is_private { "private" } else { "public" };
        self.db.set_link(&package.id, Some((&repo.id, &repo.name)), visibility, now_ms()).await?;
        self.audit_with(
            caller,
            "package.linked",
            package,
            None,
            None,
            Some(format!("Linked to {}/{} by its org.opencontainers.image.source label", package.workspace, repo.name)),
        )
        .await;
        self.db.package_by_id(&package.id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_label_names_a_repository_of_the_same_workspace() {
        assert_eq!(source_repo("https://g1t.sh/acme/web", "g1t.sh", "acme").as_deref(), Some("web"));
        assert_eq!(source_repo("https://g1t.sh/Acme/web.git", "g1t.sh", "acme").as_deref(), Some("web"));
        assert_eq!(source_repo("https://g1t.sh/acme/web/", "g1t.sh", "acme").as_deref(), Some("web"));
        assert_eq!(source_repo("https://g1t.sh/other/web", "g1t.sh", "acme"), None, "another workspace");
        assert_eq!(source_repo("https://example.com/acme/web", "g1t.sh", "acme"), None, "another host");
        assert_eq!(source_repo("http://g1t.sh/acme/web", "g1t.sh", "acme"), None);
        assert_eq!(source_repo("https://g1t.sh/acme/web/tree/main", "g1t.sh", "acme"), None);
        assert_eq!(source_repo("https://g1t.sh/acme", "g1t.sh", "acme"), None);
    }

    #[test]
    fn the_label_is_read_from_annotations_then_the_config() {
        let annotations = serde_json::json!({ "org.opencontainers.image.source": "https://g1t.sh/acme/a" });
        let config = serde_json::json!({ "config": { "Labels": { "org.opencontainers.image.source": "https://g1t.sh/acme/b" } } });
        assert_eq!(source_label(Some(&annotations), Some(&config)).as_deref(), Some("https://g1t.sh/acme/a"));
        assert_eq!(source_label(None, Some(&config)).as_deref(), Some("https://g1t.sh/acme/b"));
        assert_eq!(source_label(Some(&serde_json::json!({})), None), None);
    }

    #[test]
    fn what_is_deleted_is_purged_thirty_days_on() {
        assert_eq!(purge_at("2026-10-01T12:00:00.000Z").as_deref(), Some("2026-10-31T12:00:00.000Z"));
        assert_eq!(purge_at("not a time"), None);
    }
}
