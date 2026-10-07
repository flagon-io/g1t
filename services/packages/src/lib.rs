//! The packages service: the registries a workspace publishes to and
//! installs from, beside its code (docs/PACKAGES.md). Container images
//! first, over OCI Distribution 1.1 on `g1t.sh/v2/` (oci.rs).
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::packages` for the methods and their arguments. Any
//! other request is a registry's own protocol. Files are kept through the
//! `BlobStore` port (store/), metadata in D1 (db.rs).

mod access;
mod composer;
mod composer_http;
mod db;
mod digest;
mod limits;
mod manifest;
mod names;
mod npm;
mod npm_http;
mod oci;
mod quota;
mod range;
mod sigv4;
mod store;
mod token;
mod upload;

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
use worker::{Context, Env, Fetcher, MessageBatch, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

use access::{Action, LinkedTo, Target};
use db::{Db, PackageRow};
use store::{BlobStore, Store};

pub(crate) const SOURCE: &str = "packages";
/// How large a request body may be: Cloudflare's limit on the zone's plan.
const DEFAULT_MAX_REQUEST_BYTES: u64 = 100_000_000;
/// How many packages a listing shows.
const LIST_LIMIT: u32 = 200;
const VERSIONS_SHOWN: u32 = 200;
/// How much one sweep lets go of.
const SWEEP_BATCH: u32 = 200;

thread_local! {
    /// Pulls counted since the last write, by package: written at most
    /// every few seconds, so a busy image costs one write, not one a pull.
    /// What an isolate holds when it goes away is lost: the count is
    /// approximate.
    static DOWNLOADS: RefCell<(HashMap<String, u64>, u64)> = RefCell::new((HashMap::new(), 0));
}
const DOWNLOADS_FLUSH_MS: u64 = 10_000;

thread_local! {
    /// What billing allows each workspace, as asked last, and when.
    static ALLOWANCES: RefCell<HashMap<String, (quota::Allowance, u64)>> = RefCell::new(HashMap::new());
}
/// How long billing's answer is kept.
const ALLOWANCE_TTL_MS: u64 = 5 * 60 * 1000;

/// Who made a registry request, as its audit entries and versions name them.
pub struct Caller {
    pub actor: Option<AuditActor>,
}

/// What access decisions need about a package, owned.
pub struct TargetOf {
    workspace: String,
    repo: Option<(String, String, bool)>,
    public: bool,
}

impl TargetOf {
    pub fn package(row: &PackageRow) -> TargetOf {
        TargetOf {
            workspace: row.workspace.clone(),
            repo: row
                .repo_id
                .as_ref()
                .map(|id| (id.clone(), row.repo_name.clone().unwrap_or_default(), !row.public())),
            public: row.public(),
        }
    }

    pub fn view(&self) -> Target<'_> {
        Target {
            workspace: &self.workspace,
            repo: self.repo.as_ref().map(|(id, name, private)| LinkedTo { id, name, private: *private }),
            public: self.public,
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
            store: Store::from_env(env)?,
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
        g1t_kit::call(
            &self.identity,
            "user_for_git_credentials",
            &GitCredentialsArgs { username: username.to_owned(), secret: secret.to_owned() },
        )
        .await
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
        Ok(TargetOf {
            workspace: name.workspace.clone(),
            repo: repo.map(|repo| (repo.id, repo.name, repo.is_private)),
            public: false,
        })
    }

    /// What billing allows the workspace, kept for five minutes. `None`
    /// when billing cannot be asked: the push is then let through.
    async fn allowance(&self, workspace: &str) -> Option<quota::Allowance> {
        let now = now_ms();
        let kept = ALLOWANCES.with(|kept| kept.borrow().get(workspace).copied());
        if let Some((allowance, at)) = kept
            && now.saturating_sub(at) < ALLOWANCE_TTL_MS
        {
            return Some(allowance);
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
                Some(allowance)
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
        let Some(allowance) = self.allowance(&package.workspace).await else {
            return Ok(None);
        };
        let (public_bytes, private_bytes) = self.db.storage(&package.workspace).await?;
        let public = package.public();
        let used = if public { public_bytes } else { private_bytes };
        Ok(quota::decide(&allowance, public, used, adding)
            .err()
            .map(|refusal| quota::message(&package.workspace, &refusal)))
    }

    fn count_download(&self, package_id: &str, ctx: &Context) {
        let due = DOWNLOADS.with(|counts| {
            let mut counts = counts.borrow_mut();
            *counts.0.entry(package_id.to_owned()).or_default() += 1;
            let now = now_ms();
            if now.saturating_sub(counts.1) < DOWNLOADS_FLUSH_MS {
                return None;
            }
            counts.1 = now;
            Some(counts.0.drain().collect::<Vec<_>>())
        });
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
            latest: row.latest_tag.clone().or_else(|| row.latest_version.as_deref().and_then(db::newest_version)),
            size: row.bytes,
            downloads: p.downloads,
            created_at: p.created_at.clone(),
            updated_at: p.updated_at.clone(),
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
            latest_version: None,
        }))
    }

    async fn list_packages(&self, a: ListPackagesArgs) -> Result<Outcome<Vec<PackageSummary>>> {
        let workspace = a.workspace.to_lowercase();
        let rows = self
            .db
            .list(&workspace, a.ecosystem.map(Ecosystem::as_str), a.repo_id.as_deref(), a.query.as_deref(), LIST_LIMIT)
            .await?;
        let visible = rows
            .iter()
            .filter(|row| access::decide(a.viewer.as_ref(), &TargetOf::package(&row.package).view(), Action::Pull).allowed)
            .map(|row| self.summary(row))
            .collect();
        Ok(Outcome::Ok(visible))
    }

    async fn get_package(&self, a: GetPackageArgs) -> Result<Outcome<PackageDetail>> {
        let workspace = a.workspace.to_lowercase();
        let Some(row) = self.listed(&workspace, a.ecosystem, &a.name).await? else {
            return Ok(not_found());
        };
        let target = TargetOf::package(&row.package);
        let permissions = access::permissions(a.viewer.as_ref(), &target.view());
        if !permissions.pull {
            return Ok(not_found());
        }
        let tags = self.db.tags(&row.package.id).await?;
        let versions = self
            .db
            .versions(&row.package.id, VERSIONS_SHOWN)
            .await?
            .into_iter()
            .map(|version| {
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
                    id: version.id,
                    version: version.version,
                    digest: version.digest,
                    size: version.size,
                    subject: version.subject,
                    published_by: version.published_by,
                    published_at: version.published_at,
                    deprecated: version.deprecated,
                }
            })
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
    async fn for_change(&self, actor: &User, workspace: &str, ecosystem: Ecosystem, name: &str, action: Action) -> Result<Outcome<PackageRow>> {
        let Some(package) = self.db.package(&workspace.to_lowercase(), ecosystem.as_str(), name).await?.filter(|p| !p.hidden()) else {
            return Ok(not_found());
        };
        let target = TargetOf::package(&package);
        let decision = access::decide(Some(actor), &target.view(), action);
        if decision.allowed {
            return Ok(Outcome::Ok(package));
        }
        if !access::decide(Some(actor), &target.view(), Action::Pull).allowed {
            return Ok(not_found());
        }
        Ok(Outcome::fail(FailureCode::Forbidden, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned())))
    }

    async fn delete_version(&self, a: DeleteVersionArgs) -> Result<Outcome<()>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(version) = self.db.find_version(&package.id, &a.version).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Version not found."));
        };
        let caller = Caller { actor: Some(AuditActor::of(&a.actor)) };
        self.remove_version(&package, &version, &caller).await?;
        Ok(Outcome::Ok(()))
    }

    async fn delete_package(&self, a: DeletePackageArgs) -> Result<Outcome<()>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        self.db.delete_package(&package.id).await?;
        self.db.measure(&package.workspace).await?;
        let caller = Caller { actor: Some(AuditActor::of(&a.actor)) };
        self.announce("package.deleted", &package, self.event_of(&package), &caller).await;
        self.audit(&caller, "package.delete", &package, None, a.surface).await;
        Ok(Outcome::Ok(()))
    }

    async fn set_package(&self, a: SetPackageArgs) -> Result<Outcome<PackageSummary>> {
        let package = match self.for_change(&a.actor, &a.workspace, a.ecosystem, &a.name, Action::Delete).await? {
            Outcome::Ok(package) => package,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let caller = Caller { actor: Some(AuditActor::of(&a.actor)) };
        let now = now_ms();
        let before = package.visibility.clone();
        if a.unlink {
            self.db.set_link(&package.id, None, "private", now).await?;
        } else if let Some(link) = a.link.as_deref() {
            let Some(repo) = self.repo_by_name(&package.workspace, link).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no repository {}/{link}.", package.workspace)));
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
            let visibility = if repo.is_private { "private" } else { "public" };
            self.db.set_link(&package.id, Some((&repo.id, &repo.name)), visibility, now).await?;
        }
        if let Some(visibility) = a.visibility {
            let linked = if a.unlink { false } else { a.link.is_some() || package.repo_id.is_some() };
            if linked {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "A linked package has its repository's visibility. Change the repository's, or unlink the package.",
                ));
            }
            self.db.set_visibility(&package.id, visibility.as_str(), now).await?;
        }
        self.audit(&caller, "package.update", &package, None, a.surface).await;
        let Some(row) = self.listed(&package.workspace, a.ecosystem, &package.name).await? else {
            return Ok(not_found());
        };
        if row.package.visibility != before {
            self.db.measure(&package.workspace).await?;
            let event = PackageEvent { visibility: Some(row.package.visibility.clone()), ..self.event_of(&row.package) };
            self.announce("package.visibility_changed", &row.package, event, &caller).await;
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
        if g1t_kit::transfer::on_event(env, db, event, &[
            "UPDATE packages SET repo_name = ?6 WHERE repo_id = ?5 AND workspace = ?3",
            "UPDATE packages SET repo_id = NULL, repo_name = NULL WHERE repo_id = ?5 AND workspace <> ?3",
        ])
        .await?
        {
            return Ok(());
        }
        if g1t_kit::lifecycle::on_purged(db, event, &["UPDATE packages SET repo_id = NULL, repo_name = NULL, visibility = 'private' WHERE repo_id = ?1"])
            .await?
        {
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

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    let packages = Packages::from_env(&env)?;
    let Some(method) = rpc_method(&request) else {
        if request.path().starts_with("/-/npm/") || request.path() == "/-/npm" {
            return packages.npm(request, &ctx).await;
        }
        if request.path().starts_with("/-/composer/") {
            return packages.composer(request, &ctx).await;
        }
        return packages.registry(request, &ctx).await;
    };
    let body: serde_json::Value = request.json().await?;
    match method.as_str() {
        "list_packages" => reply(&packages.list_packages(args(body)?).await?),
        "get_package" => reply(&packages.get_package(args(body)?).await?),
        "delete_version" => reply(&packages.delete_version(args(body)?).await?),
        "delete_package" => reply(&packages.delete_package(args(body)?).await?),
        "set_package" => reply(&packages.set_package(args(body)?).await?),
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

/// Every hour: expired uploads are let go, and blobs no version has used
/// for a day are deleted from the store.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let packages = match Packages::from_env(&env) {
        Ok(packages) => packages,
        Err(error) => {
            worker::console_error!("packages: the sweep could not start: {error}");
            return;
        }
    };
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
    for message in batch.messages()? {
        packages.on_event(&env, message.body()).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
