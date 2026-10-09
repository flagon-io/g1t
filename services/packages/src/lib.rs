//! The packages service: the registries a workspace publishes to and
//! installs from, beside its code (docs/PACKAGES.md). Container images
//! first, over OCI Distribution 1.1 on `g1t.sh/v2/` (oci.rs).
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::packages` for the methods and their arguments. Any
//! other request is a registry's own protocol. Files are kept through the
//! `BlobStore` port (store/), metadata in D1 (db.rs).

mod access;
mod archive;
mod cargo;
mod cargo_http;
mod composer;
mod composer_http;
mod db;
mod digest;
mod limits;
mod manifest;
mod marshal;
mod maven;
mod maven_http;
mod names;
mod npm;
mod npm_http;
mod nuget;
mod nuget_http;
mod oci;
mod quota;
mod range;
mod rubygems;
mod rubygems_http;
mod store;
mod token;
mod upload;
mod xml;
mod yaml;

use std::cell::RefCell;
use std::collections::HashMap;

use g1t_contracts::audit::{AuditActor, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::credentials::Decision;
use g1t_contracts::events::{Event, NewEvent, PackageEvent, Publish};
use g1t_contracts::identity::GitCredentialsArgs;
use g1t_contracts::packages::*;
use g1t_contracts::repos::{GetArgs, Repo, RepoPath};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use worker::{Context, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

use access::{Action, LinkedTo, Target};
use db::{Db, PackageRow};
use store::{BlobStore, Store};

mod settings;

pub(crate) const SOURCE: &str = "packages";
/// How large a request body may be: Cloudflare's limit on the zone's plan.
const DEFAULT_MAX_REQUEST_BYTES: u64 = 100_000_000;
/// How many packages a listing shows.
const LIST_LIMIT: u32 = 200;
const VERSIONS_SHOWN: u32 = 200;
/// How much one sweep lets go of.
const SWEEP_BATCH: u32 = 200;

thread_local! {
    /// Pulls counted since the last write, by package (and by version,
    /// where it is counted too): written at most every few seconds, so a
    /// busy image costs one write, not one a pull. What an isolate holds
    /// when it goes away is lost: the count is approximate.
    static DOWNLOADS: RefCell<(HashMap<DownloadKey, u64>, u64)> = RefCell::new((HashMap::new(), 0));
}
const DOWNLOADS_FLUSH_MS: u64 = 10_000;
/// A package's id, and a version's when the download counts for it too.
type DownloadKey = (String, Option<String>);

thread_local! {
    /// What billing allows each workspace, as asked last, and when.
    static ALLOWANCES: RefCell<HashMap<String, (quota::Allowance, u64)>> = RefCell::new(HashMap::new());
}
/// How long billing's answer is kept.
const ALLOWANCE_TTL_MS: u64 = 5 * 60 * 1000;

/// Who made a registry request, as its audit entries and versions name them.
pub struct Caller {
    pub actor: Option<AuditActor>,
    /// Who it is, where that is known: what linking a package to the
    /// repository its source label names checks.
    pub viewer: Option<User>,
}

impl Caller {
    pub fn of(viewer: Option<&User>) -> Caller {
        Caller { actor: viewer.map(AuditActor::of), viewer: viewer.cloned() }
    }

    pub fn system() -> Caller {
        Caller { actor: Some(AuditActor::system()), viewer: None }
    }
}

/// What access decisions need about a package, owned. Its own grants and
/// Actions access are read only when a decision needs them (`loaded`).
pub struct TargetOf {
    pub(crate) workspace: String,
    pub(crate) name: String,
    pub(crate) repo: Option<(String, String, bool)>,
    pub(crate) public: bool,
    pub(crate) package_id: Option<String>,
    pub(crate) inherit: bool,
    pub(crate) grants: Vec<access::Grant>,
    pub(crate) actions: Vec<access::RepoAccess>,
    pub(crate) teams: Vec<String>,
    pub(crate) loaded: bool,
}

impl TargetOf {
    pub fn package(row: &PackageRow) -> TargetOf {
        TargetOf {
            workspace: row.workspace.clone(),
            name: row.name.clone(),
            repo: row
                .repo_id
                .as_ref()
                .map(|id| (id.clone(), row.repo_name.clone().unwrap_or_default(), !row.public())),
            public: row.public(),
            package_id: Some(row.id.clone()),
            inherit: row.inherits(),
            grants: Vec::new(),
            actions: Vec::new(),
            teams: Vec::new(),
            loaded: false,
        }
    }

    /// A package not made yet, which its first push would link to `repo`.
    pub fn unmade(workspace: &str, name: &str, repo: Option<(String, String, bool)>) -> TargetOf {
        TargetOf {
            workspace: workspace.to_owned(),
            name: name.to_owned(),
            repo,
            public: false,
            package_id: None,
            inherit: true,
            grants: Vec::new(),
            actions: Vec::new(),
            teams: Vec::new(),
            loaded: true,
        }
    }

    pub fn view(&self) -> Target<'_> {
        Target {
            workspace: &self.workspace,
            name: &self.name,
            repo: self.repo.as_ref().map(|(id, name, private)| LinkedTo { id, name, private: *private }),
            public: self.public,
            exists: self.package_id.is_some(),
            inherit: self.inherit,
            grants: &self.grants,
            actions: &self.actions,
            teams: &self.teams,
        }
    }
}

pub struct Packages {
    pub db: Db,
    pub store: Store,
    identity: Fetcher,
    repos: Fetcher,
    events: Fetcher,
    /// Signs registry tokens (PACKAGES_TOKEN_SECRET).
    secret: Vec<u8>,
    max_request: u64,
    /// The host package addresses start with: `g1t.sh`.
    host: String,
    /// Whether free workspaces' package storage is limited (STORAGE_LIMITS
    /// `on`); off when self-hosted.
    storage_limits: bool,
    env: Env,
}

/// What a workspace's deletion or restoring does to its packages.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceMark {
    /// Hide them from `at`, while the workspace may still be restored.
    Hide { workspace: String, at: String },
    /// Show them again.
    Show { workspace: String },
}

/// The mark `event` asks for, if any. A protected workspace (`protected`,
/// slugs or ids, as identity's PROTECTED_WORKSPACES) is never hidden: it
/// cannot be deleted, so an event saying so is a mistake.
pub(crate) fn workspace_mark(event: &Event, protected: &[String], now: &str) -> Option<WorkspaceMark> {
    let text = |key: &str| event.data[key].as_str().map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty());
    let workspace = text("slug")?;
    match event.kind.as_str() {
        "workspace.deleting" => {
            let id = text("workspaceId").unwrap_or_default();
            if protected.iter().any(|name| *name == workspace || (!id.is_empty() && *name == id)) {
                return None;
            }
            Some(WorkspaceMark::Hide { workspace, at: now.to_owned() })
        }
        "workspace.restored" => Some(WorkspaceMark::Show { workspace }),
        _ => None,
    }
}

/// Adds one download to the counts kept since the last write, and answers
/// with all of them to write when the last write was long enough ago.
pub(crate) fn tally(counts: &mut (HashMap<DownloadKey, u64>, u64), key: DownloadKey, now: u64) -> Option<Vec<(DownloadKey, u64)>> {
    *counts.0.entry(key).or_default() += 1;
    if now.saturating_sub(counts.1) < DOWNLOADS_FLUSH_MS {
        return None;
    }
    counts.1 = now;
    Some(counts.0.drain().collect())
}

fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Package not found.")
}

impl Packages {
    pub fn from_env(env: &Env) -> Result<Packages> {
        let secret = store::var(env, "PACKAGES_TOKEN_SECRET");
        if secret.len() < 32 {
            return Err(worker::Error::RustError("PACKAGES_TOKEN_SECRET is missing or shorter than 32 characters".into()));
        }
        // 0 is no limit, as self-hosted (nothing in front cuts bodies short).
        let max_request = match store::var(env, "MAX_REQUEST_BYTES").parse::<u64>() {
            Ok(0) => u64::MAX,
            Ok(limit) => limit,
            Err(_) => DEFAULT_MAX_REQUEST_BYTES,
        };
        let host = store::var(env, "REGISTRY_HOST");
        Ok(Packages {
            db: Db { db: env.d1("DB")? },
            store: store::from_env(env)?,
            identity: env.service("IDENTITY")?,
            repos: env.service("REPOS")?,
            events: env.service("EVENTS")?,
            secret: secret.into_bytes(),
            max_request,
            host: if host.is_empty() { "g1t.sh".to_owned() } else { host },
            storage_limits: store::var(env, "STORAGE_LIMITS") == "on",
            env: env.clone(),
        })
    }

    async fn viewer_for(&self, username: &str, secret: &str) -> Result<Viewer> {
        let viewer: Viewer = g1t_kit::call(
            &self.identity,
            "user_for_git_credentials",
            &GitCredentialsArgs { username: username.to_owned(), secret: secret.to_owned() },
        )
        .await?;
        // An account that has not confirmed its email address signs in to
        // nothing yet: its credentials are refused like wrong ones.
        Ok(viewer.filter(|user| !user.awaits_confirmation()))
    }

    /// A repository of the workspace by name, whoever may see it.
    async fn repo_by_name(&self, workspace: &str, name: &str) -> Result<Option<Repo>> {
        if !g1t_contracts::is_valid_repo_name(name) {
            return Ok(None);
        }
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs {
                path: RepoPath { namespace: workspace.to_owned(), name: name.to_owned() },
                viewer: Some(User::system(workspace)),
            },
        )
        .await?;
        Ok(found.into_result().ok().filter(|repo| repo.fork_of.is_none()))
    }

    /// Who may do what to an image: the package's own settings, or, before
    /// its first push, the repository it will be linked to.
    async fn target(&self, name: &names::ImageName, found: Option<&PackageRow>) -> Result<TargetOf> {
        if let Some(found) = found {
            return Ok(TargetOf::package(found));
        }
        let repo = self.repo_by_name(&name.workspace, name.repo_name()).await?;
        Ok(TargetOf::unmade(&name.workspace, &name.name, repo.map(|repo| (repo.id, repo.name, repo.is_private))))
    }

    /// What billing allows the workspace, kept for five minutes unless
    /// `fresh`, and whether it is the kept answer. `None` when billing
    /// cannot be asked: the push is then let through.
    async fn allowance(&self, workspace: &str, fresh: bool) -> Option<(quota::Allowance, bool)> {
        let now = now_ms();
        let kept = ALLOWANCES.with(|kept| kept.borrow().get(workspace).copied());
        if let Some((allowance, at)) = kept
            && !fresh
            && now.saturating_sub(at) < ALLOWANCE_TTL_MS
        {
            return Some((allowance, true));
        }
        let billing = self.env.service("BILLING").ok()?;
        let asked: Result<quota::Allowance> = g1t_kit::call(
            &billing,
            "entitlements",
            &g1t_contracts::billing::EntitlementsArgs { workspace: workspace.to_owned() },
        )
        .await;
        match asked {
            Ok(allowance) => {
                ALLOWANCES.with(|kept| kept.borrow_mut().insert(workspace.to_owned(), (allowance, now)));
                Some((allowance, false))
            }
            Err(error) => {
                worker::console_error!("packages: billing could not be asked about {workspace}, letting the push through: {error}");
                None
            }
        }
    }

    /// Why a push of these files (digest and size) into the package may
    /// not be kept, if it may not: a free workspace past its free storage.
    /// Files the workspace already holds add nothing.
    pub(crate) async fn storage_refusal(&self, package: &PackageRow, files: &[(String, u64)]) -> Result<Option<String>> {
        if !self.storage_limits || files.is_empty() {
            return Ok(None);
        }
        let digests: Vec<String> = files.iter().map(|(digest, _)| digest.clone()).collect();
        let held = self.db.held(&package.workspace, &digests).await?;
        let mut seen = std::collections::HashSet::new();
        let adding: u64 = files
            .iter()
            .filter(|(digest, _)| !held.contains(digest) && seen.insert(digest.clone()))
            .map(|(_, size)| size)
            .sum();
        if adding == 0 {
            return Ok(None);
        }
        let Some((allowance, kept)) = self.allowance(&package.workspace, false).await else {
            return Ok(None);
        };
        let (public_bytes, private_bytes) = self.db.storage(&package.workspace).await?;
        let public = package.public();
        let used = if public { public_bytes } else { private_bytes };
        let mut refused = quota::decide(&allowance, public, used, adding).err();
        // A refusal from the kept answer is checked with billing again: the
        // workspace may have just added a plan, and must not wait minutes
        // for the push to go through.
        if refused.is_some() && kept {
            refused = match self.allowance(&package.workspace, true).await {
                Some((allowance, _)) => quota::decide(&allowance, public, used, adding).err(),
                None => None,
            };
        }
        Ok(refused.map(|refusal| quota::message(&package.workspace, &refusal)))
    }

    fn count_download(&self, package_id: &str, ctx: &Context) {
        self.count_downloads(package_id, None, ctx);
    }

    /// A download of one version, counted for it and its package.
    fn count_version_download(&self, package_id: &str, version_id: &str, ctx: &Context) {
        self.count_downloads(package_id, Some(version_id), ctx);
    }

    fn count_downloads(&self, package_id: &str, version_id: Option<&str>, ctx: &Context) {
        let key = (package_id.to_owned(), version_id.map(str::to_owned));
        let due = DOWNLOADS.with(|counts| tally(&mut counts.borrow_mut(), key, now_ms()));
        if let Some(due) = due {
            let env = self.env.clone();
            ctx.wait_until(async move {
                let written = match env.d1("DB") {
                    Ok(db) => Db { db }.add_downloads(&due).await,
                    Err(error) => Err(error),
                };
                if let Err(error) = written {
                    worker::console_error!("packages: downloads not counted: {error}");
                }
            });
        }
    }

    async fn announce(&self, kind: &'static str, package: &PackageRow, data: PackageEvent, caller: &Caller) {
        let event = NewEvent {
            kind,
            source: SOURCE,
            repo_id: package.repo_id.clone(),
            actor: caller.actor.as_ref().map(|actor| actor.actor_id.clone()),
            data,
        };
        let published: Result<serde_json::Value> = g1t_kit::call(&self.events, "publish", &Publish { events: vec![event] }).await;
        if let Err(error) = published {
            worker::console_error!("packages: {kind} not published: {error}");
        }
    }

    async fn audit(&self, caller: &Caller, action: &str, package: &PackageRow, path: Option<&str>, surface: Option<Surface>) {
        self.audit_with(caller, action, package, path, surface, None).await;
    }

    /// An audit entry, with what changed in words (`message`), as identity
    /// writes its access entries.
    async fn audit_with(
        &self,
        caller: &Caller,
        action: &str,
        package: &PackageRow,
        path: Option<&str>,
        surface: Option<Surface>,
        message: Option<String>,
    ) {
        let Some(actor) = caller.actor.clone() else {
            return;
        };
        let target = AuditTarget {
            workspace: package.workspace.clone(),
            repo: package.repo_name.as_ref().map(|name| format!("{}/{name}", package.workspace)),
            path: Some(path.map_or_else(|| format!("{}:{}/{}", package.ecosystem, package.workspace, package.name), str::to_owned)),
            ..AuditTarget::default()
        };
        let mut entry = NewAuditEntry::new(
            actor,
            action,
            surface.unwrap_or(Surface::Registry),
            target,
            &Decision::allow("packages"),
            new_id("req", now_ms()),
        );
        entry.result = Some("ok".to_owned());
        entry.message = message;
        let recorded: Result<u32> = g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries: vec![entry] }).await;
        if let Err(error) = recorded {
            worker::console_error!("packages: audit entry not recorded: {error}");
        }
    }

    fn summary(&self, row: &db::ListedRow) -> PackageSummary {
        let p = &row.package;
        PackageSummary {
            id: p.id.clone(),
            workspace: p.workspace.clone(),
            ecosystem: Ecosystem::parse(&p.ecosystem).unwrap_or(Ecosystem::Container),
            name: p.name.clone(),
            address: match p.ecosystem.as_str() {
                "npm" => format!("{}/-/npm/@{}/{}", self.host, p.workspace, p.name),
                "composer" => format!("{}/-/composer/{}/{}", self.host, p.workspace, p.name),
                "cargo" => format!("{}/-/cargo/{}/{}", self.host, p.workspace, p.name),
                "maven" => format!("{}/-/maven/{}/{}", self.host, p.workspace, p.name),
                "nuget" => format!("{}/-/nuget/{}/{}", self.host, p.workspace, p.name),
                "rubygems" => format!("{}/-/rubygems/{}/{}", self.host, p.workspace, p.name),
                _ => format!("{}/{}/{}", self.host, p.workspace, p.name),
            },
            visibility: Visibility::parse(&p.visibility),
            repo: p.repo_id.as_ref().map(|id| LinkedRepo {
                id: id.clone(),
                namespace: p.workspace.clone(),
                name: p.repo_name.clone().unwrap_or_default(),
            }),
            description: p.description.clone(),
            versions: row.version_count,
            latest: db::latest_shown(row),
            size: row.bytes,
            downloads: p.downloads,
            created_at: p.created_at.clone(),
            updated_at: p.updated_at.clone(),
            inherit_access: p.inherits(),
            deleted_at: p.deleted_at.clone(),
            deleted_by: p.deleted_by.clone(),
            purge_at: p.deleted_at.as_deref().and_then(settings::purge_at),
        }
    }

    async fn listed(&self, workspace: &str, ecosystem: Ecosystem, name: &str) -> Result<Option<db::ListedRow>> {
        let rows = self.db.list(workspace, Some(ecosystem.as_str()), None, None, LIST_LIMIT).await?;
        if let Some(row) = rows.into_iter().find(|row| row.package.name == name) {
            return Ok(Some(row));
        }
        // Past the first page: read it alone.
        Ok(self.db.package(workspace, ecosystem.as_str(), name).await?.filter(|package| !package.hidden()).map(|package| db::ListedRow {
            package,
            version_count: 0,
            bytes: 0,
            latest_tag: None,
            latest_tag_version: None,
            latest_version: None,
        }))
    }

    async fn list_packages(&self, a: ListPackagesArgs) -> Result<Outcome<Vec<PackageSummary>>> {
        let workspace = a.workspace.to_lowercase();
        let rows = self
            .db
            .list(&workspace, a.ecosystem.map(Ecosystem::as_str), a.repo_id.as_deref(), a.query.as_deref(), LIST_LIMIT)
            .await?;
        let packages: Vec<&PackageRow> = rows.iter().map(|row| &row.package).collect();
        let may = self.may_all(a.viewer.as_ref(), &packages, Action::Pull).await?;
        let visible = rows
            .iter()
            .zip(may)
            .filter(|(_, may)| *may)
            .map(|(row, _)| self.summary(row))
            .collect();
        Ok(Outcome::Ok(visible))
    }

    async fn get_package(&self, a: GetPackageArgs) -> Result<Outcome<PackageDetail>> {
        let workspace = a.workspace.to_lowercase();
        let Some(row) = self.listed(&workspace, a.ecosystem, &a.name).await? else {
            return Ok(not_found());
        };
        let mut target = TargetOf::package(&row.package);
        let permissions = self.permissions(a.viewer.as_ref(), &mut target).await?;
        if !permissions.pull {
            return Ok(not_found());
        }
        let tags = self.db.tags(&row.package.id).await?;
        let versions = self
            .db
            .versions(&row.package.id, VERSIONS_SHOWN)
            .await?
            .into_iter()
            .map(|version| settings::version_of(&row.package, version, &tags))
            .collect();
        // The README its page shows: npm's, from the latest version.
        let readme = match self.db.readme_digest(&row.package.id).await?.and_then(|d| digest::Digest::parse(&d)) {
            Some(digest) => match self.db.blob(&digest).await? {
                Some(blob) => self.store.read(&blob.object_key).await?.map(|b| String::from_utf8_lossy(&b).into_owned()),
                None => None,
            },
            None => None,
        };
        Ok(Outcome::Ok(PackageDetail {
            readme,
            package: self.summary(&row),
            versions,
            tags: tags
                .into_iter()
                .map(|tag| PackageTag { tag: tag.tag, digest: tag.digest, updated_at: tag.updated_at })
                .collect(),
            permissions,
        }))
    }

    /// The package `actor` asks to change, if they may `action` it.
    pub(crate) async fn for_change(&self, actor: &User, workspace: &str, ecosystem: Ecosystem, name: &str, action: Action) -> Result<Outcome<PackageRow>> {
        let Some(package) = self.db.package(&workspace.to_lowercase(), ecosystem.as_str(), name).await?.filter(|p| !p.hidden()) else {
            return Ok(not_found());
        };
        match self.allowed(actor, &package, action).await? {
            Outcome::Ok(()) => Ok(Outcome::Ok(package)),
            Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
        }
    }

    /// Whether `actor` may `action` the package: not found for one who may
    /// not pull it, forbidden with the reason for one who may.
    pub(crate) async fn allowed(&self, actor: &User, package: &PackageRow, action: Action) -> Result<Outcome<()>> {
        let mut target = TargetOf::package(package);
        let decision = self.decide(Some(actor), &mut target, action).await?;
        if decision.allowed {
            return Ok(Outcome::Ok(()));
        }
        if !self.decide(Some(actor), &mut target, Action::Pull).await?.allowed {
            return Ok(not_found());
        }
        Ok(Outcome::fail(FailureCode::Forbidden, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned())))
    }

    async fn delete_version(&self, a: DeleteVersionArgs) -> Result<Outcome<()>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if package.ecosystem == "composer" {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "A Composer package's versions are its repository's tags and branches: delete the tag or branch instead.",
            ));
        }
        let Some(version) = self.db.find_version(&package.id, &a.version).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Version not found."));
        };
        let caller = Caller::of(Some(&a.actor));
        self.remove_version_from(&package, &version, &caller, a.surface).await?;
        Ok(Outcome::Ok(()))
    }

    async fn delete_package(&self, a: DeletePackageArgs) -> Result<Outcome<()>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let caller = Caller::of(Some(&a.actor));
        self.remove_package(&package, &caller, a.surface).await?;
        Ok(Outcome::Ok(()))
    }

    /// Deletes a package: hidden at once, restorable for 30 days, its name
    /// kept until then. Its files go with the purge.
    pub(crate) async fn remove_package(&self, package: &PackageRow, caller: &Caller, surface: Option<Surface>) -> Result<()> {
        let by = caller.actor.as_ref().map_or("", |actor| actor.actor.as_str());
        self.db.soft_delete_package(&package.id, by, now_ms()).await?;
        self.db.measure(&package.workspace).await?;
        self.announce("package.deleted", package, self.event_of(package), caller).await;
        self.audit_with(
            caller,
            "package.delete",
            package,
            None,
            surface,
            Some(format!("Deleted the package; it can be restored for {RESTORE_DAYS} days")),
        )
        .await;
        Ok(())
    }

    async fn set_package(&self, a: SetPackageArgs) -> Result<Outcome<PackageSummary>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Admin).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let caller = Caller::of(Some(&a.actor));
        let now = now_ms();
        let before = package.visibility.clone();
        let linked = if a.unlink { false } else { a.link.is_some() || package.repo_id.is_some() };
        if a.visibility.is_some_and(|visibility| visibility.as_str() != package.visibility) && linked {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "A linked package has its repository's visibility. Change the repository's, or unlink the package.",
            ));
        }
        if a.inherit_access.is_some() && !linked {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Only a package linked to a repository inherits access. Link it to a repository first.",
            ));
        }
        let path = |repo: &str| format!("{}/{repo}", package.workspace);
        if a.unlink {
            if let Some(name) = package.repo_name.as_deref() {
                self.db.set_link(&package.id, None, "private", now).await?;
                self.audit_with(&caller, "package.unlinked", &package, None, a.surface, Some(format!("Unlinked from {}", path(name)))).await;
            }
        } else if let Some(link) = a.link.as_deref() {
            let link = link.trim().trim_end_matches(".git");
            let name = match link.split_once('/') {
                Some((owner, name)) if owner.eq_ignore_ascii_case(&package.workspace) => name,
                Some(_) => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("A package can only be linked to a repository of its own workspace, {}.", package.workspace),
                    ));
                }
                None => link,
            };
            let Some(repo) = self.repo_by_name(&package.workspace, name).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no repository {}.", path(name))));
            };
            // Linking hands the package to the repository's roles: only
            // someone who administers that repository may.
            let role = g1t_contracts::access::permission(Some(&a.actor), &repo);
            if role < Some(g1t_contracts::access::RepoRole::Admin) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    format!("You need the Admin role on {}/{} to link a package to it.", repo.namespace, repo.name),
                ));
            }
            if package.repo_id.as_deref() != Some(repo.id.as_str()) {
                let visibility = if repo.is_private { "private" } else { "public" };
                self.db.set_link(&package.id, Some((&repo.id, &repo.name)), visibility, now).await?;
                self.audit_with(&caller, "package.linked", &package, None, a.surface, Some(format!("Linked to {}", path(&repo.name)))).await;
            }
        }
        if let Some(visibility) = a.visibility
            && !linked
            && visibility.as_str() != package.visibility
        {
            self.db.set_visibility(&package.id, visibility.as_str(), now).await?;
        }
        if let Some(inherit) = a.inherit_access
            && inherit != package.inherits()
        {
            self.db.set_inherit(&package.id, inherit, now).await?;
            let message = if inherit {
                "Turned on inheriting access from the linked repository"
            } else {
                "Turned off inheriting access from the linked repository"
            };
            self.audit_with(&caller, "package.inherit_access_changed", &package, None, a.surface, Some(message.to_owned())).await;
        }
        let Some(row) = self.listed(&package.workspace, a.ecosystem, &package.name).await? else {
            return Ok(not_found());
        };
        if row.package.visibility != before {
            self.db.measure(&package.workspace).await?;
            let event = PackageEvent { visibility: Some(row.package.visibility.clone()), ..self.event_of(&row.package) };
            self.announce("package.visibility_changed", &row.package, event, &caller).await;
            self.audit_with(
                &caller,
                "package.visibility_changed",
                &row.package,
                None,
                a.surface,
                Some(format!("Made the package {}", row.package.visibility)),
            )
            .await;
        }
        Ok(Outcome::Ok(self.summary(&row)))
    }

    /// Lets go of expired uploads, and of blobs no version has used for a day.
    async fn sweep(&self) -> Result<(u32, u32)> {
        let now = now_ms();
        let mut uploads = 0;
        for row in self.db.expired_uploads(now, SWEEP_BATCH).await? {
            if let Some(progress) = row.progress()
                && let Err(error) = upload::abort(&self.store, &progress).await
            {
                worker::console_error!("packages: upload {} not aborted: {error}", row.id);
            }
            self.db.delete_upload(&row.id).await?;
            uploads += 1;
        }
        let mut blobs = 0;
        for blob in self.db.unused_blobs(now, SWEEP_BATCH).await? {
            self.store.delete(&blob.object_key).await?;
            self.db.forget_blob(&blob.digest).await?;
            blobs += 1;
        }
        Ok((uploads, blobs))
    }

    /// Follows what happens elsewhere: workspaces renamed and deleted,
    /// repositories that change visibility, are renamed, move or go.
    async fn on_event(&self, env: &Env, event: &Event) -> Result<()> {
        // Composer packages are read from repositories: again when one is
        // pushed to (its default branch may have gained a composer.json),
        // restored, renamed or moved; gone when it is deleted. A failure is
        // logged, not retried with the batch: the next push reads it again.
        let repo_id = event.repo_id.clone().or_else(|| event.data["repoId"].as_str().map(str::to_owned));
        if let Some(repo_id) = repo_id.as_deref() {
            let synced = match event.kind.as_str() {
                "git.push" => {
                    let known = self.db.package_for_repo(repo_id, "composer").await?.is_some();
                    if known || event.data["defaultBranch"].as_bool() == Some(true) {
                        Some(self.sync_composer(repo_id).await.map(|_| ()))
                    } else {
                        None
                    }
                }
                "repo.deleted" => Some(self.composer_repo_gone(repo_id).await),
                "repo.restored" | "repo.renamed" | "repo.transferred" => Some(self.sync_composer(repo_id).await.map(|_| ())),
                _ => None,
            };
            if let Some(Err(error)) = synced {
                worker::console_error!("packages: composer {} for {repo_id}: {error}", event.kind);
            }
            if event.kind == "git.push" || event.kind == "repo.deleted" || event.kind == "repo.restored" {
                return Ok(());
            }
        }
        let db = &self.db.db;
        let protected = g1t_contracts::identity::protected_names(Some(&store::var(env, "PROTECTED_WORKSPACES")));
        match workspace_mark(event, &protected, &g1t_contracts::time::rfc3339(now_ms())) {
            Some(WorkspaceMark::Hide { workspace, at }) => return self.db.mark_workspace(&workspace, Some(&at)).await,
            Some(WorkspaceMark::Show { workspace }) => return self.db.mark_workspace(&workspace, None).await,
            None => {}
        }
        if g1t_kit::rename::on_event(env, db, event, &[
            "UPDATE packages SET workspace = ?1 WHERE workspace = ?2",
            "UPDATE uploads SET workspace = ?1 WHERE workspace = ?2",
            "UPDATE workspace_blobs SET workspace = ?1 WHERE workspace = ?2",
        ])
        .await?
        {
            return Ok(());
        }
        if g1t_kit::deleted::on_event(db, event, &[
            "DELETE FROM tags WHERE package_id IN (SELECT id FROM packages WHERE workspace = ?1)",
            "DELETE FROM version_files WHERE version_id IN (SELECT v.id FROM versions v JOIN packages p ON p.id = v.package_id WHERE p.workspace = ?1)",
            "DELETE FROM versions WHERE package_id IN (SELECT id FROM packages WHERE workspace = ?1)",
            "DELETE FROM package_blobs WHERE package_id IN (SELECT id FROM packages WHERE workspace = ?1)",
            "DELETE FROM package_access WHERE package_id IN (SELECT id FROM packages WHERE workspace = ?1)",
            "DELETE FROM package_actions_access WHERE package_id IN (SELECT id FROM packages WHERE workspace = ?1)",
            "DELETE FROM uploads WHERE workspace = ?1",
            "DELETE FROM workspace_blobs WHERE workspace = ?1",
            "DELETE FROM packages WHERE workspace = ?1",
        ])
        .await?
        {
            return Ok(());
        }
        // A repository renamed keeps its packages linked under its new
        // name; one moved to another workspace leaves them behind, unlinked.
        // Manage Actions access follows a rename, and lets go of a
        // repository that left the package's workspace.
        if g1t_kit::transfer::on_event(env, db, event, &[
            "UPDATE packages SET repo_name = ?6 WHERE repo_id = ?5 AND workspace = ?3",
            "UPDATE packages SET repo_id = NULL, repo_name = NULL WHERE repo_id = ?5 AND workspace <> ?3",
            "UPDATE package_actions_access SET repo_name = ?6 WHERE repo_id = ?5",
            "DELETE FROM package_actions_access WHERE repo_id = ?5 AND package_id IN (SELECT id FROM packages WHERE workspace <> ?3)",
        ])
        .await?
        {
            return Ok(());
        }
        if g1t_kit::lifecycle::on_purged(db, event, &[
            "UPDATE packages SET repo_id = NULL, repo_name = NULL, visibility = 'private' WHERE repo_id = ?1",
            "DELETE FROM package_actions_access WHERE repo_id = ?1",
        ])
        .await?
        {
            return Ok(());
        }
        // A team renamed or deleted: its roles on packages follow.
        if matches!(event.kind.as_str(), "team.edited" | "team.deleted") {
            let field = |snake: &str, camel: &str| {
                event.data[snake].as_str().or_else(|| event.data[camel].as_str()).map(str::to_owned)
            };
            if let Some(team_id) = field("team_id", "teamId") {
                let slug = field("team", "team");
                let renamed = (event.kind == "team.edited").then_some(slug.as_deref()).flatten();
                if event.kind == "team.deleted" || renamed.is_some() {
                    self.db.follow_team(&team_id, renamed).await?;
                }
            }
            return Ok(());
        }
        if event.kind == "repo.visibility_changed" {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Changed {
                repo_id: String,
                is_private: bool,
            }

            let Ok(changed) = serde_json::from_value::<Changed>(event.data.clone()) else {
                worker::console_error!("repo.visibility_changed {} could not be read", event.id);
                return Ok(());
            };
            self.db.follow_visibility(&changed.repo_id, changed.is_private).await?;
            for workspace in self.db.workspaces_linked_to(&changed.repo_id).await? {
                self.db.measure(&workspace).await?;
            }
        }
        Ok(())
    }
}

impl Packages {
    /// A registry request, to the registry its path names.
    async fn serve_registry(&self, request: Request, ctx: &Context) -> Result<Response> {
        let path = request.path();
        if path.starts_with("/-/npm/") || path == "/-/npm" {
            return self.npm(request, ctx).await;
        }
        if path.starts_with("/-/composer/") {
            return self.composer(request, ctx).await;
        }
        if path.starts_with("/-/cargo/") {
            return self.cargo(request, ctx).await;
        }
        if path.starts_with("/-/maven/") {
            return self.maven(request, ctx).await;
        }
        if path.starts_with("/-/nuget/") {
            return self.nuget(request, ctx).await;
        }
        if path.starts_with("/-/rubygems/") {
            return self.rubygems(request, ctx).await;
        }
        self.registry(request, ctx).await
    }
}

/// The policy for registry answers: what they serve is a publisher's bytes,
/// on the site's origin, so nothing in them may load or run.
const NOTHING_RUNS: &str = "default-src 'none'; sandbox";

/// Whether a browser could open a body of this type as a page: HTML, SVG,
/// any XML, or a type it does not know as data. Such a body is a download.
fn opens_as_document(content_type: Option<&str>) -> bool {
    let kind = content_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if kind.ends_with("+xml") || kind.ends_with("/xml") || kind.contains("html") || kind.contains("svg") || kind.contains("xsl") {
        return true;
    }
    let data = kind == "text/plain"
        || kind == "application/json"
        || (kind.starts_with("application/") && kind.ends_with("+json"))
        || matches!(
            kind.as_str(),
            "application/octet-stream"
                | "application/gzip"
                | "application/x-gzip"
                | "application/zip"
                | "application/x-tar"
                | "application/java-archive"
                | "application/pgp-signature"
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/avif"
        )
        || kind.starts_with("application/vnd.");
    !data
}

/// The headers every registry answer carries: no sniffing, nothing runs,
/// and a type a browser would open is an attachment. The site's Worker
/// sets the same (apps/web/app/lib/content-safety.ts); this keeps the
/// service safe on its own.
fn harden(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("content-security-policy", NOTHING_RUNS)?;
    if headers.get("content-disposition")?.is_none() && opens_as_document(headers.get("content-type")?.as_deref()) {
        headers.set("content-disposition", "attachment")?;
    }
    Ok(response)
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    let packages = Packages::from_env(&env)?;
    let Some(method) = rpc_method(&request) else {
        let answer = packages.serve_registry(request, &ctx).await?;
        return harden(answer);
    };
    let body: serde_json::Value = request.json().await?;
    match method.as_str() {
        "list_packages" => reply(&packages.list_packages(args(body)?).await?),
        "get_package" => reply(&packages.get_package(args(body)?).await?),
        "delete_version" => reply(&packages.delete_version(args(body)?).await?),
        "delete_package" => reply(&packages.delete_package(args(body)?).await?),
        "set_package" => reply(&packages.set_package(args(body)?).await?),
        // A package's settings, deleted packages and versions: settings.rs.
        "list_versions" => reply(&packages.list_versions(args(body)?).await?),
        "get_version" => reply(&packages.get_version(args(body)?).await?),
        "restore_version" => reply(&packages.restore_version(args(body)?).await?),
        "restore_package" => reply(&packages.restore_package(args(body)?).await?),
        "deleted_packages" => reply(&packages.deleted_packages(args(body)?).await?),
        "package_settings" => reply(&packages.package_settings(args(body)?).await?),
        "set_package_access" => reply(&packages.set_package_access(args(body)?).await?),
        "remove_package_access" => reply(&packages.remove_package_access(args(body)?).await?),
        "set_actions_access" => reply(&packages.set_actions_access(args(body)?).await?),
        "remove_actions_access" => reply(&packages.remove_actions_access(args(body)?).await?),
        // For billing: what a workspace's packages hold.
        "storage_all" => reply(&packages.db.storage_all().await?),
        // Read a repository's Composer package again now, as a push would.
        "sync_composer" => {
            let a: SyncComposerArgs = args(body)?;
            reply(&packages.sync_composer(&a.repo_id).await?)
        }
        "storage" => {
            let a: StorageArgs = args(body)?;
            let (public_bytes, private_bytes) = packages.db.storage(&a.workspace.to_lowercase()).await?;
            reply(&PackageStorage { public_bytes, private_bytes })
        }
        _ => Response::error("Unknown method", 404),
    }
}

/// Every hour: expired uploads are let go, packages and versions deleted
/// more than 30 days ago are purged, and blobs no version has used for a
/// day are deleted from the store.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let packages = match Packages::from_env(&env) {
        Ok(packages) => packages,
        Err(error) => {
            worker::console_error!("packages: the sweep could not start: {error}");
            return;
        }
    };
    // Before the sweep, so the files of what is purged go with it a day on.
    match packages.purge(now_ms()).await {
        Ok((0, 0)) => {}
        Ok((purged, versions)) => worker::console_log!("packages: purged {purged} deleted packages and {versions} deleted versions"),
        Err(error) => worker::console_error!("packages: the purge failed: {error}"),
    }
    match packages.sweep().await {
        Ok((0, 0)) => {}
        Ok((uploads, blobs)) => worker::console_log!("packages: let go of {uploads} uploads and {blobs} blobs"),
        Err(error) => worker::console_error!("packages: the sweep failed: {error}"),
    }
    // Repositories that had a composer.json before the registry did.
    match packages.composer_backfill().await {
        Ok(0) => {}
        Ok(found) => worker::console_log!("packages: found {found} Composer packages"),
        Err(error) => worker::console_error!("packages: the Composer backfill failed: {error}"),
    }
}

#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let packages = Packages::from_env(&env)?;
    // Each event is acknowledged or retried on its own, so one that fails
    // does not run the rest of its batch again.
    for message in batch.messages()? {
        match packages.on_event(&env, message.body()).await {
            Ok(_) => message.ack(),
            Err(error) => {
                worker::console_error!("packages: event {} failed: {error}", message.body().id);
                message.retry();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn publisher_documents_are_downloads() {
        for kind in ["application/xml", "text/xml; charset=utf-8", "application/xhtml+xml", "text/html", "image/svg+xml", "application/vnd.foo+xml", "", "text/javascript"] {
            assert!(opens_as_document(Some(kind)), "{kind}");
        }
        assert!(opens_as_document(None));
        for kind in [
            "application/json",
            "text/plain; charset=utf-8",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.npm.install-v1+json",
            "application/octet-stream",
            "application/java-archive",
            "application/gzip",
            "application/pgp-signature",
        ] {
            assert!(!opens_as_document(Some(kind)), "{kind}");
        }
    }

    fn event(kind: &str, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "identity".into(),
            time: "2026-10-06T00:00:00.000Z".into(),
            repo_id: None,
            actor: None,
            data,
        }
    }

    #[test]
    fn downloads_are_counted_by_version_and_written_in_batches() {
        let mut counts = (HashMap::new(), 0);
        let version = |v: &str| ("pkg_1".to_owned(), Some(v.to_owned()));
        // The first is written at once (nothing was written before).
        let first = tally(&mut counts, version("ver_1"), 100_000).unwrap();
        assert_eq!(first, vec![(version("ver_1"), 1)]);
        // Then they are kept until the flush is due, each version apart.
        assert!(tally(&mut counts, version("ver_1"), 101_000).is_none());
        assert!(tally(&mut counts, version("ver_1"), 102_000).is_none());
        assert!(tally(&mut counts, version("ver_2"), 103_000).is_none());
        let mut due = tally(&mut counts, ("pkg_1".to_owned(), None), 100_000 + DOWNLOADS_FLUSH_MS).unwrap();
        due.sort();
        assert_eq!(due, vec![(("pkg_1".to_owned(), None), 1), (version("ver_1"), 2), (version("ver_2"), 1)]);
        assert!(counts.0.is_empty());
    }

    fn package(deleted_at: Option<&str>, workspace_deleted_at: Option<&str>) -> PackageRow {
        PackageRow {
            id: "pkg_1".into(),
            workspace: "acme".into(),
            ecosystem: "npm".into(),
            name: "web".into(),
            repo_id: None,
            repo_name: None,
            visibility: "private".into(),
            description: None,
            created_by: "usr_1".into(),
            created_at: "2026-10-01T00:00:00.000Z".into(),
            updated_at: "2026-10-01T00:00:00.000Z".into(),
            downloads: 0,
            workspace_deleted_at: workspace_deleted_at.map(str::to_owned),
            inherit_access: 1,
            deleted_at: deleted_at.map(str::to_owned),
            deleted_by: deleted_at.map(|_| "ana".to_owned()),
        }
    }

    #[test]
    fn a_deleted_package_is_hidden_and_keeps_its_name_until_the_purge() {
        let deleted = package(Some("2026-10-02T09:00:00.000Z"), None);
        assert!(deleted.hidden());
        let refusal = Packages::hidden_refusal(&deleted);
        assert!(refusal.contains("was deleted"), "{refusal}");
        assert!(refusal.contains("2026-11-01"), "kept 30 days: {refusal}");
        let workspace_gone = package(None, Some("2026-10-02T09:00:00.000Z"));
        assert!(workspace_gone.hidden());
        assert!(Packages::hidden_refusal(&workspace_gone).contains("workspace acme is deleted"));
        assert!(!package(None, None).hidden());
    }

    #[test]
    fn the_purge_takes_what_was_deleted_more_than_thirty_days_ago() {
        let now = g1t_contracts::time::parse_rfc3339("2026-11-01T12:00:00.000Z").unwrap();
        let before = settings::purge_cutoff(now);
        assert_eq!(before, "2026-10-02T12:00:00.000Z");
        // Rows are purged when deleted_at < before: a day older goes, a
        // second newer stays restorable.
        assert!("2026-10-01T12:00:00.000Z" < before.as_str());
        assert!("2026-10-02T12:00:01.000Z" > before.as_str());
        assert!(settings::restorable("2026-10-02T12:00:01.000Z", now));
        assert!(!settings::restorable("2026-10-01T12:00:00.000Z", now));
    }

    #[test]
    fn a_deleted_workspace_is_hidden_and_a_restored_one_shown() {
        let protected = g1t_contracts::identity::protected_names(Some("wsp_keep"));
        let now = "2026-10-06T12:00:00.000Z";
        let deleting = event("workspace.deleting", json!({ "workspaceId": "wsp_1", "slug": "Acme", "by": "ana", "purgeAfter": "x" }));
        assert_eq!(
            workspace_mark(&deleting, &protected, now),
            Some(WorkspaceMark::Hide { workspace: "acme".into(), at: now.into() })
        );
        let restored = event("workspace.restored", json!({ "workspaceId": "wsp_1", "slug": "acme" }));
        assert_eq!(workspace_mark(&restored, &protected, now), Some(WorkspaceMark::Show { workspace: "acme".into() }));
    }

    #[test]
    fn protected_workspaces_and_other_events_are_left_alone() {
        let protected = g1t_contracts::identity::protected_names(Some("wsp_keep"));
        let now = "2026-10-06T12:00:00.000Z";
        let flagon = event("workspace.deleting", json!({ "workspaceId": "wsp_f", "slug": "flagon-io" }));
        assert_eq!(workspace_mark(&flagon, &protected, now), None, "always protected");
        let by_id = event("workspace.deleting", json!({ "workspaceId": "wsp_keep", "slug": "kept" }));
        assert_eq!(workspace_mark(&by_id, &protected, now), None, "protected by id");
        let purged = event("workspace.deleted", json!({ "workspaceId": "wsp_1", "slug": "acme" }));
        assert_eq!(workspace_mark(&purged, &protected, now), None, "the purge is handled apart");
        let nameless = event("workspace.deleting", json!({ "workspaceId": "wsp_1", "slug": "" }));
        assert_eq!(workspace_mark(&nameless, &protected, now), None);
    }
}
