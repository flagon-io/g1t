//! Version updates: pull requests that keep dependencies current, as the
//! dependency update file (`dependabot.yml`, version 2) asks.
//!
//! 1. Reading the file (`deps::read_version_updates`, on every dependency
//!    scan) schedules each entry g1t can act on: a new entry runs at once,
//!    then on its `schedule`. A sweep every few minutes runs those due.
//! 2. A run reads the entry's manifests and lockfiles on the default
//!    branch, asks each dependency's registry for its versions, and picks
//!    each one's target with `allow`, `ignore`, people's `@g1t ignore`
//!    comments, `cooldown` and `versioning-strategy` (`planning`). Updates
//!    are gathered by `groups`, and up to `open-pull-requests-limit` pull
//!    requests are asked of the runner's `bump` sandbox, the same one
//!    security updates use.
//! 3. The sandbox's push opens the pull request as g1t (`User::system`),
//!    titled and described as `pull_text` says, assigned and with reviews
//!    asked as the file says. An older one for the same dependency or group
//!    is closed as superseded.
//! 4. The sweep watches open ones: a failing required check closes it and
//!    puts g1t on an issue to make the code changes, as security updates
//!    do; one asked to merge (`@g1t merge`) merges once its checks pass;
//!    one in conflict is made again from its base (`rebase-strategy`).
//! 5. `@g1t` comments on these pull requests are commands
//!    (`g1t_contracts::updates::update_command`).

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::access::{Capability, CollaboratorPermissionArgs, PermissionInfo};
use g1t_contracts::actions::{ResolveSettingsArgs, ResolvedSettings};
use g1t_contracts::events::Event;
use g1t_contracts::repos::{BlobArgs, BlobView, BlobText, FileList, ListFilesArgs, RawFile, RawFileArgs, ReadBlobsArgs, RepoPath};
use g1t_contracts::security::{BumpArgs, UpdateState};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::updates::{
    BumpPackage, BumpRegistry, CheckUpdatesArgs, DEPENDABOT_CHECK, DEPENDABOT_PATHS, IgnoreCondition, UpdateCommand, UpdatedDependency,
    VersionUpdatesState, update_command,
};
use g1t_contracts::work::{
    Mergeable, OpenIssueArgs, OpenPullArgs, Pull, PullActionArgs, PullDetail, PullStatus, RequiredState, Runtime, SetCommitStatusArgs,
    UpdatePullArgs, ViewArgs,
};
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use g1t_scan::lockfiles::Lockfile;
use g1t_scan::version;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Security;
use crate::config::{self, Config, Entry, Registry, glob};
use crate::manifests::{self, Declared, DependencyType};
use crate::planning::{self, Candidate, Planned, PullPlan, Skip};
use crate::pull_text;
use crate::ranges::{self, Bare};
use crate::registries::{self, Package, Source};
use crate::store::RepoRow;
use crate::update_store::{NewPull, PullRow};
use crate::updates;

/// Entries run per sweep.
const DUE_PER_SWEEP: u32 = 3;
/// Open update pull requests looked at per sweep.
const WATCHED_PER_SWEEP: u32 = 10;
/// Dependencies one run asks registries about, at most.
const MAX_PACKAGES: usize = 200;
/// Registry requests in flight at once.
const FETCH_AT_ONCE: usize = 8;
/// Versions whose publish time a Go module's run asks the proxy for.
const GO_TIMES: usize = 3;
/// A sandbox that has not pushed after this long is taken to have failed.
const STALLED_MS: u64 = 45 * 60 * 1000;
const MAX_BLOB_BYTES: u32 = 5_000_000;
const SKIPPED_DIRECTORIES: [&str; 6] = ["node_modules", ".git", "target", "dist", "build", ".venv"];

/// OSV's name for a `package-ecosystem`, as lockfiles and the bump sandbox name it.
pub fn osv_ecosystem(ecosystem: &str) -> Option<&'static str> {
    Some(match ecosystem {
        "npm" => "npm",
        "cargo" => "crates.io",
        "gomod" => "Go",
        "pip" => "PyPI",
        _ => return None,
    })
}

/// The `package-ecosystem` for one of OSV's names.
pub fn package_ecosystem(osv: &str) -> Option<&'static str> {
    Some(match osv {
        "npm" => "npm",
        "crates.io" => "cargo",
        "Go" => "gomod",
        "PyPI" => "pip",
        _ => return None,
    })
}

/// A package name as its ecosystem compares names.
pub(crate) fn normalize(ecosystem: &str, name: &str) -> String {
    if ecosystem == "pip" { manifests::python_name(name) } else { name.to_owned() }
}

fn bare(ecosystem: &str) -> Bare {
    if ecosystem == "cargo" { Bare::Caret } else { Bare::Exact }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(BASE64[(n >> shift & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0;
    for c in text.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        let value = BASE64.iter().position(|known| *known == c)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits & 0xff) as u8);
        }
    }
    Some(out)
}

/// `${{secrets.NAME}}` in `text` with each secret's value; the names of
/// those that are not set.
pub fn fill_secrets(text: &str, secrets: &serde_json::Map<String, Value>) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut missing = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return (out, missing);
        };
        let inner = after[..end].trim();
        match inner.strip_prefix("secrets.").map(str::trim) {
            Some(name) => match secrets.get(name).and_then(Value::as_str) {
                Some(value) => out.push_str(value),
                None => missing.push(name.to_owned()),
            },
            None => out.push_str(&rest[start..start + 3 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    (out, missing)
}

/// Whether a pull request's required checks passed (`Some(true)`), one
/// failed (`Some(false)`), or they are still to come. Without required
/// checks, what its workflows reported on its head.
pub fn checks_verdict(detail: &PullDetail) -> Option<bool> {
    if !detail.required_checks.is_empty() {
        if detail.required_checks.iter().any(|check| check.state == RequiredState::Failure) {
            return Some(false);
        }
        return detail.required_checks.iter().all(|check| check.state == RequiredState::Success).then_some(true);
    }
    if detail.statuses.iter().any(|status| matches!(status.state.as_str(), "failure" | "error")) {
        return Some(false);
    }
    detail.statuses.iter().all(|status| status.state == "success").then_some(true)
}

/// The directories of `entry` that hold one of its manifests: each
/// `directory`, and what each `directories` glob matches, without those
/// `exclude-paths` covers. From the root, starting with `/`.
pub fn entry_directories(entry: &Entry, files: &[String]) -> Vec<String> {
    let names = manifests::manifest_names(&entry.ecosystem);
    let mut found = BTreeSet::new();
    for file in files {
        let (directory, name) = file.rsplit_once('/').map_or(("", file.as_str()), |(directory, name)| (directory, name));
        if !names.contains(&name) {
            continue;
        }
        let directory = format!("/{directory}");
        let directory = if directory == "/" { directory } else { directory.trim_end_matches('/').to_owned() };
        for wanted in &entry.directories {
            let hit = if wanted.contains(['*', '?']) { glob(wanted, &directory) } else { *wanted == directory };
            if !hit {
                continue;
            }
            let relative = file.strip_prefix(wanted.trim_start_matches('/')).unwrap_or(file).trim_start_matches('/');
            let excluded = entry.exclude_paths.iter().any(|pattern| {
                let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
                glob(pattern, relative) || relative.starts_with(&format!("{}/", pattern.trim_end_matches('/')))
            });
            if !excluded {
                found.insert(directory.clone());
            }
        }
    }
    found.into_iter().collect()
}

/// The lockfiles that resolve `directory`'s dependencies in `ecosystem`:
/// its own, or the nearest above it (a workspace's).
pub fn lockfiles_for(ecosystem: &str, directory: &str, files: &[String]) -> Vec<String> {
    let Some(osv) = osv_ecosystem(ecosystem) else { return Vec::new() };
    let mut at = directory.trim_matches('/').to_owned();
    loop {
        let found: Vec<String> = files
            .iter()
            .filter(|file| {
                let (dir, _) = file.rsplit_once('/').unwrap_or(("", file));
                dir == at && Lockfile::for_path(file).is_some_and(|lockfile| lockfile.ecosystem().osv() == osv)
            })
            .cloned()
            .collect();
        if !found.is_empty() || at.is_empty() {
            return found;
        }
        at = at.rsplit_once('/').map_or(String::new(), |(parent, _)| parent.to_owned());
    }
}

/// What a run reads in one directory.
pub struct Directory {
    pub path: String,
    pub declared: Vec<Declared>,
    /// Each package the lockfiles resolve, by name, with every version.
    pub locked: BTreeMap<String, Vec<String>>,
    pub lockfiles: Vec<String>,
}

/// The dependencies a run looks at in one directory, with the version
/// each is at now. A declared dependency with no version to be found is
/// left out.
pub fn directory_candidates(entry: &Entry, directory: &Directory) -> Vec<(String, DependencyType, String, Option<String>)> {
    let ecosystem = entry.ecosystem.as_str();
    let mut out = Vec::new();
    let mut named = BTreeSet::new();
    for declared in &directory.declared {
        let name = normalize(ecosystem, &declared.name);
        named.insert(name.clone());
        let locked = directory.locked.get(&name).cloned().unwrap_or_default();
        let fitting: Vec<&String> = locked
            .iter()
            .filter(|version| declared.requirement.as_deref().is_none_or(|req| ranges::satisfies(req, version, bare(ecosystem)) != Some(false)))
            .collect();
        let current = fitting
            .into_iter()
            .max_by(|a, b| version::compare(a, b))
            .cloned()
            .or_else(|| locked.iter().max_by(|a, b| version::compare(a, b)).cloned())
            .or_else(|| match (ecosystem, declared.requirement.as_deref()) {
                ("gomod", Some(version)) => Some(version.to_owned()),
                ("pip", Some(requirement)) => requirement.strip_prefix("==").filter(|v| !v.contains([',', '*'])).map(str::to_owned),
                _ => None,
            });
        if let Some(current) = current {
            out.push((declared.name.clone(), declared.kind, current, declared.requirement.clone()));
        }
    }
    let wants_indirect = entry.allow.iter().any(|rule| matches!(rule.dependency_type.as_deref(), Some("indirect" | "all")));
    if wants_indirect && matches!(ecosystem, "cargo" | "gomod" | "pip") {
        for (name, versions) in &directory.locked {
            if named.contains(name) {
                continue;
            }
            if let Some(current) = versions.iter().max_by(|a, b| version::compare(a, b)) {
                out.push((name.clone(), DependencyType::Indirect, current.clone(), None));
            }
        }
    }
    out
}

/// What the run decided for the open-pull-requests limit: the plans to
/// ask for now (replacing an older one when `Some`), and how many waited.
pub fn admit<'a>(plans: &'a [PullPlan], existing: &'a [PullRow], limit: u32) -> (Vec<(&'a PullPlan, Option<&'a PullRow>)>, usize) {
    let in_progress = |row: &&PullRow| matches!(row.state(), UpdateState::Requested | UpdateState::Open);
    let mut open = existing.iter().filter(in_progress).count();
    let mut admitted = Vec::new();
    let mut held = 0;
    let mut fresh = Vec::new();
    for plan in plans {
        let subject = plan.subject();
        let signature = plan.signature();
        let mine: Vec<&PullRow> = existing.iter().filter(|row| row.subject == subject).collect();
        // Already open for these versions, or closed by a person for them.
        if mine.iter().any(|row| row.signature == signature && (in_progress(row) || matches!(row.state(), UpdateState::Closed | UpdateState::NeedsCode))) {
            continue;
        }
        match mine.into_iter().find(in_progress) {
            Some(older) => admitted.push((plan, Some(older))),
            None => fresh.push(plan),
        }
    }
    for plan in fresh {
        if open < limit as usize {
            open += 1;
            admitted.push((plan, None));
        } else {
            held += 1;
        }
    }
    (admitted, held)
}

/// What the dependency update file says, as a run uses it.
pub struct Loaded {
    pub config: Config,
    pub file: String,
    pub default_branch: String,
}

#[derive(Deserialize)]
struct CommentAuthor {
    username: String,
}

impl Security {
    fn repo_path(repo: &RepoRow) -> RepoPath {
        RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() }
    }

    /// The dependency update file on the default branch, if it is there
    /// and has no problems.
    pub(crate) async fn load_config(&self, repo: &RepoRow) -> Result<Option<Loaded>> {
        let path = Self::repo_path(repo);
        let mut found = Vec::new();
        let mut default_branch = None;
        for file in DEPENDABOT_PATHS {
            let read: Outcome<BlobView> = g1t_kit::call(
                &self.repos,
                "blob",
                &BlobArgs { path: path.clone(), viewer: Some(User::system(&repo.namespace)), git_ref: String::new(), file_path: file.to_owned() },
            )
            .await?;
            if let Outcome::Ok(blob) = read {
                default_branch = Some(blob.repo.default_branch.clone());
                found.push((file.to_owned(), blob.text));
            }
        }
        let Some(((file, Some(text)), _)) = updates::choose(found) else { return Ok(None) };
        let read = config::read(&text);
        if !read.problems.is_empty() {
            return Ok(None);
        }
        Ok(Some(Loaded { config: read.config, file, default_branch: default_branch.unwrap_or_default() }))
    }

    /// Schedules each entry g1t can act on, after the file is read: a new
    /// one runs now, the rest when their schedule next says since they last
    /// ran. A file with problems runs nothing.
    pub(crate) async fn schedule_entries(&self, repo: &RepoRow, config: Option<&Config>, default_branch: Option<&str>) -> Result<()> {
        let known: BTreeMap<String, Option<String>> =
            self.store.runs(&repo.repo_id).await?.into_iter().map(|run| (run.entry, run.last_checked_at)).collect();
        let now = now_ms();
        let mut rows = Vec::new();
        for entry in config.map(|config| config.updates.as_slice()).unwrap_or_default() {
            if !runnable(entry, default_branch) {
                continue;
            }
            let Some(schedule) = &entry.schedule else { continue };
            let next = match known.get(&entry.id()) {
                Some(Some(last)) => schedule.next_run(parse_rfc3339(last).unwrap_or(now), &updates::seed(&repo.repo_id, entry)),
                _ => Some(now),
            };
            rows.push((entry.id(), next.map(rfc3339)));
        }
        self.store.set_runs(&repo.repo_id, &rows).await
    }

    /// The sweep's part for version updates: due entries, open update
    /// pull requests, and sandboxes that never pushed.
    pub async fn version_update_sweep(&self) -> Result<()> {
        for run in self.store.due_runs(&rfc3339(now_ms()), DUE_PER_SWEEP).await? {
            let Some(repo) = self.store.repo(&run.repo_id).await? else { continue };
            if let Err(error) = self.run_claimed(&repo, &run.entry).await {
                worker::console_error!("security: version updates for {} {} failed: {error}", run.repo_id, run.entry);
            }
        }
        for row in self.store.open_update_pulls(WATCHED_PER_SWEEP).await? {
            if let Err(error) = self.watch_update_pull(&row).await {
                worker::console_error!("security: update pull request {} not looked at: {error}", row.id);
            }
        }
        let before = rfc3339(now_ms().saturating_sub(STALLED_MS));
        for row in self.store.stalled_update_pulls(&before, 10).await? {
            let error = "The update could not be made in a sandbox: its packages may need code changes to move, or a registry could not be reached.";
            self.store.set_update_pull(&row.id, UpdateState::Failed, row.pull(), None, Some(error)).await?;
        }
        Ok(())
    }

    /// Runs one entry if no one else is, and schedules its next run.
    async fn run_claimed(&self, repo: &RepoRow, entry_id: &str) -> Result<()> {
        if !self.store.claim_run(&repo.repo_id, entry_id).await? {
            return Ok(());
        }
        let loaded = self.load_config(repo).await;
        let (result, error, next) = match loaded {
            Ok(Some(loaded)) => match loaded.config.updates.iter().find(|entry| entry.id() == entry_id && runnable(entry, Some(&loaded.default_branch))) {
                Some(entry) => {
                    let next = entry
                        .schedule
                        .as_ref()
                        .and_then(|schedule| schedule.next_run(now_ms(), &updates::seed(&repo.repo_id, entry)))
                        .map(rfc3339);
                    match self.run_entry(repo, &loaded, entry).await {
                        Ok(Ok(summary)) => (Some(summary), None, next),
                        Ok(Err(problem)) => (None, Some(problem), next),
                        Err(error) => (None, Some(format!("The check could not finish: {error}")), next),
                    }
                }
                None => (None, None, None),
            },
            Ok(None) => (None, Some("The dependency update file is missing or has problems.".to_owned()), None),
            Err(error) => (None, Some(format!("The dependency update file could not be read: {error}")), None),
        };
        self.store.finish_run(&repo.repo_id, entry_id, next.as_deref(), result.as_deref(), error.as_deref()).await
    }

    /// `check_updates`: one entry, now.
    pub async fn check_updates(&self, a: CheckUpdatesArgs) -> Result<Outcome<VersionUpdatesState>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), Capability::Push).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let state = repo.version_updates();
        let Some(entry) = state.updates.iter().find(|entry| entry.id == a.entry) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "The dependency update file has no such entry."));
        };
        if !entry.supported {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("g1t does not open version updates for {} yet.", entry.ecosystem)));
        }
        if !self.store.claim_run(&repo.repo_id, &a.entry).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "This entry is being checked now."));
        }
        // Claimed: run_claimed would claim again, so run it here.
        let loaded = self.load_config(&repo).await?;
        let (result, error) = match loaded.as_ref().and_then(|loaded| loaded.config.updates.iter().find(|entry| entry.id() == a.entry).map(|entry| (loaded, entry))) {
            Some((loaded, entry)) => match self.run_entry(&repo, loaded, entry).await {
                Ok(Ok(summary)) => (Some(summary), None),
                Ok(Err(problem)) => (None, Some(problem)),
                Err(error) => (None, Some(format!("The check could not finish: {error}"))),
            },
            None => (None, Some("The dependency update file is missing or has problems.".to_owned())),
        };
        let next = self
            .store
            .runs(&repo.repo_id)
            .await?
            .into_iter()
            .find(|run| run.entry == a.entry)
            .and_then(|run| run.next_run_at);
        self.store.finish_run(&repo.repo_id, &a.entry, next.as_deref(), result.as_deref(), error.as_deref()).await?;
        Ok(Outcome::Ok(self.version_updates_view(&repo).await?))
    }

    /// The registries an entry may use, ready for the sandbox and for
    /// asking about versions, and what kept any from being used.
    async fn entry_registries(&self, repo: &RepoRow, loaded: &Loaded, entry: &Entry) -> Result<(Vec<(Registry, BumpRegistry, Source)>, Vec<String>)> {
        let kind_for = |ecosystem: &str| match ecosystem {
            "npm" => "npm-registry",
            "cargo" => "cargo-registry",
            "pip" => "python-index",
            "gomod" => "goproxy-server",
            _ => "",
        };
        let wanted: Vec<&Registry> = entry
            .registries
            .iter()
            .filter_map(|name| loaded.config.registries.iter().find(|registry| &registry.name == name))
            .filter(|registry| registry.kind == kind_for(&entry.ecosystem))
            .collect();
        if wanted.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let settings: ResolvedSettings = g1t_kit::call(
            &self.actions,
            "resolve_settings",
            &ResolveSettingsArgs {
                repo_id: repo.repo_id.clone(),
                repo: Self::repo_path(repo),
                project_id: None,
                project_slug: None,
                consumer: "workflows".to_owned(),
                environment: None,
                trusted: true,
            },
        )
        .await
        .unwrap_or_default();
        let mut ready = Vec::new();
        let mut notes = Vec::new();
        for registry in wanted {
            if registry.oidc {
                notes.push(format!("Registry {} signs in with OIDC, which g1t cannot do, so it was not used.", registry.name));
                continue;
            }
            let mut missing = Vec::new();
            let mut fill = |text: &Option<String>| {
                text.as_deref().map(|text| {
                    let (filled, absent) = fill_secrets(text, &settings.secrets);
                    missing.extend(absent);
                    filled
                })
            };
            let username = fill(&registry.username);
            let password = fill(&registry.password);
            let token = fill(&registry.token).or_else(|| fill(&registry.key));
            if !missing.is_empty() {
                notes.push(format!(
                    "Registry {} names secrets that are not set for this repository's workflows: {}.",
                    registry.name,
                    missing.join(", ")
                ));
                continue;
            }
            let url = registry.url.trim_end_matches('/').to_owned();
            let authorization = match (&token, &username, &password) {
                (Some(token), _, _) if registry.kind == "cargo-registry" => Some(token.clone()),
                (Some(token), _, _) if registry.kind == "npm-registry" => Some(format!("Bearer {token}")),
                (Some(token), _, _) => Some(format!("Basic {}", base64_encode(format!("__token__:{token}").as_bytes()))),
                (None, Some(user), Some(password)) => Some(format!("Basic {}", base64_encode(format!("{user}:{password}").as_bytes()))),
                _ => None,
            };
            let bump = BumpRegistry {
                kind: registry.kind.clone(),
                url: url.clone(),
                username,
                password,
                token,
                replaces_base: registry.replaces_base,
                scopes: registry.scopes.clone(),
            };
            ready.push((registry.clone(), bump, Source { url, authorization }));
        }
        Ok((ready, notes))
    }

    async fn get(&self, url: &str, source: Option<&Source>, accept: &str) -> Result<Option<String>> {
        let headers = Headers::new();
        headers.set("user-agent", "g1t (+https://g1t.sh)")?;
        headers.set("accept", accept)?;
        if let Some(authorization) = source.and_then(|source| source.authorization.as_deref()) {
            headers.set("authorization", authorization)?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(headers);
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
        match response.status_code() {
            200..=299 => Ok(Some(response.text().await?)),
            404 | 410 => Ok(None),
            status => Err(worker::Error::RustError(format!("{} answered {status}", url.split('/').take(3).collect::<Vec<_>>().join("/")))),
        }
    }

    /// What `name`'s registry says, from the private one that serves it if
    /// the entry names one.
    async fn package(&self, ecosystem: &str, name: &str, current: &str, registries: &[(Registry, BumpRegistry, Source)]) -> Result<Option<Package>> {
        let private = registries.iter().find(|(registry, _, _)| {
            registry.replaces_base || registry.scopes.iter().any(|scope| name.starts_with(&format!("{scope}/")))
        });
        let source = private.map(|(_, _, source)| source);
        let Some(url) = registries::package_url(ecosystem, name, source) else { return Ok(None) };
        let accept = if ecosystem == "pip" && source.is_some() { "application/vnd.pypi.simple.v1+json" } else { "application/json, text/plain" };
        let Some(body) = self.get(&url, source, accept).await? else { return Ok(None) };
        let mut package = registries::read(ecosystem, name, source.is_some(), &body);
        if ecosystem == "gomod" {
            // When the newest few were published, for the cooldown.
            let mut newer: Vec<usize> = (0..package.releases.len())
                .filter(|at| version::compare(&package.releases[*at].version, current).is_gt())
                .collect();
            newer.sort_by(|a, b| version::compare(&package.releases[*b].version, &package.releases[*a].version));
            for at in newer.into_iter().take(GO_TIMES) {
                let info = url.replace("/@v/list", &format!("/@v/{}.info", package.releases[at].version));
                if let Some(text) = self.get(&info, source, "application/json").await? {
                    package.releases[at].published_ms = serde_json::from_str(&text).ok().and_then(|value: Value| registries::go_info_time(&value));
                }
            }
        }
        Ok(Some(package))
    }

    /// One run of one entry: what it found, as a sentence, or why it could
    /// not run.
    async fn run_entry(&self, repo: &RepoRow, loaded: &Loaded, entry: &Entry) -> Result<std::result::Result<String, String>> {
        if !self.active(&repo.repo_id).await? {
            return Ok(Err("Version updates wait while the repository is archived or deleted.".to_owned()));
        }
        if entry.open_pull_requests_limit == 0 {
            return Ok(Ok("open-pull-requests-limit is 0, so no version updates open.".to_owned()));
        }
        let listed: FileList = g1t_kit::call(
            &self.repos,
            "list_files",
            &ListFilesArgs {
                repo_id: repo.repo_id.clone(),
                // The branch its updates are for: `target-branch`, or the default.
                git_ref: target_of(entry, &loaded.default_branch),
                skip_dirs: SKIPPED_DIRECTORIES.iter().map(|dir| (*dir).to_owned()).collect(),
                limit: g1t_contracts::repos::MAX_LISTED_FILES,
            },
        )
        .await?;
        let paths: Vec<String> = listed.files.iter().filter(|file| file.hash.is_some()).map(|file| file.path.clone()).collect();
        let hash_of = |path: &str| listed.files.iter().find(|file| file.path == path).and_then(|file| file.hash.clone());
        let directories = entry_directories(entry, &paths);
        if directories.is_empty() {
            return Ok(Err(format!("No {} manifest was found in {}.", entry.ecosystem, entry.directories.join(", "))));
        }
        // Each directory's manifests and lockfiles, read at once.
        let mut wanted: BTreeMap<String, String> = BTreeMap::new();
        let mut plan: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
        for directory in &directories {
            let base = directory.trim_start_matches('/');
            let manifests: Vec<String> = manifests::manifest_names(&entry.ecosystem)
                .iter()
                .map(|name| if base.is_empty() { (*name).to_owned() } else { format!("{base}/{name}") })
                .filter(|path| paths.contains(path))
                .collect();
            let lockfiles = lockfiles_for(&entry.ecosystem, directory, &paths);
            for path in manifests.iter().chain(&lockfiles) {
                if let Some(hash) = hash_of(path) {
                    wanted.insert(path.clone(), hash);
                }
            }
            plan.push((directory.clone(), manifests, lockfiles));
        }
        let mut texts: BTreeMap<String, String> = BTreeMap::new();
        let entries: Vec<(String, String)> = wanted.into_iter().collect();
        for chunk in entries.chunks(g1t_contracts::repos::MAX_READ_BLOBS) {
            let blobs: Vec<BlobText> = g1t_kit::call(
                &self.repos,
                "read_blobs",
                &ReadBlobsArgs { repo_id: repo.repo_id.clone(), hashes: chunk.iter().map(|(_, hash)| hash.clone()).collect(), max_bytes: MAX_BLOB_BYTES },
            )
            .await?;
            for ((path, _), blob) in chunk.iter().zip(blobs) {
                if let Some(text) = blob.text {
                    texts.insert(path.clone(), text);
                }
            }
        }
        let mut read: Vec<Directory> = Vec::new();
        for (path, manifest_paths, lockfiles) in plan {
            let mut declared = Vec::new();
            for manifest in &manifest_paths {
                let name = manifest.rsplit('/').next().unwrap_or(manifest);
                // A pinned requirements.txt is also read as a lockfile.
                declared.extend(texts.get(manifest).map(|text| manifests::declared(name, text)).unwrap_or_default());
            }
            let mut locked: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for lockfile in &lockfiles {
                let Some(kind) = Lockfile::for_path(lockfile) else { continue };
                for package in texts.get(lockfile).map(|text| kind.parse(text)).unwrap_or_default() {
                    locked.entry(normalize(&entry.ecosystem, &package.name)).or_default().push(package.version);
                }
            }
            read.push(Directory { path, declared, locked, lockfiles });
        }
        let (registries, mut notes) = self.entry_registries(repo, loaded, entry).await?;
        let comments = self.store.ignores(&repo.repo_id).await?;
        // Every dependency to ask about, once.
        let mut candidates: Vec<(String, String, DependencyType, String, Option<String>)> = Vec::new();
        for directory in &read {
            for (name, kind, current, requirement) in directory_candidates(entry, directory) {
                if planning::allowed(entry, &name, kind) {
                    candidates.push((directory.path.clone(), name, kind, current, requirement));
                }
            }
        }
        let names: Vec<(String, String)> = {
            let mut seen = BTreeMap::new();
            for (_, name, _, current, _) in &candidates {
                let lowest = seen.entry(name.clone()).or_insert_with(|| current.clone());
                if version::compare(current, lowest).is_lt() {
                    *lowest = current.clone();
                }
            }
            seen.into_iter().collect()
        };
        if names.len() > MAX_PACKAGES {
            notes.push(format!("Only the first {MAX_PACKAGES} of {} dependencies were checked this time.", names.len()));
        }
        let mut packages: BTreeMap<String, Package> = BTreeMap::new();
        let mut failures = Vec::new();
        for chunk in names.iter().take(MAX_PACKAGES).collect::<Vec<_>>().chunks(FETCH_AT_ONCE) {
            let asks = chunk.iter().map(|(name, current)| self.package(&entry.ecosystem, name, current, &registries));
            for ((name, _), found) in chunk.iter().zip(futures_util::future::join_all(asks).await) {
                match found {
                    Ok(Some(package)) => {
                        packages.insert(name.clone(), package);
                    }
                    Ok(None) => {}
                    Err(error) => failures.push(format!("{name} ({error})")),
                }
            }
        }
        let now = now_ms();
        let mut planned = Vec::new();
        let mut up_to_date = 0;
        let mut ignored = 0;
        for (directory, name, kind, current, requirement) in candidates {
            let Some(package) = packages.get(&name) else { continue };
            let candidate = Candidate { name, directory, kind, current, requirement, package: package.clone() };
            match planning::target(entry, &comments, &candidate, now) {
                Ok(update) => planned.push(update),
                Err(Skip::UpToDate) => up_to_date += 1,
                Err(Skip::Ignored) => ignored += 1,
                Err(Skip::NotAllowed) => {}
            }
        }
        let plans = planning::gather(&entry.groups, "version-updates", planned);
        let existing: Vec<PullRow> = self
            .store
            .update_pulls(&repo.repo_id)
            .await?
            .into_iter()
            .filter(|row| row.kind == "version" && row.entry == entry.id())
            .collect();
        let (admitted, held) = admit(&plans, &existing, entry.open_pull_requests_limit);
        let lockfiles_of = |plan: &PullPlan| -> Vec<String> {
            let mut all: Vec<String> = read
                .iter()
                .filter(|directory| plan.directories().contains(&directory.path))
                .flat_map(|directory| directory.lockfiles.clone())
                .collect();
            all.sort();
            all.dedup();
            all
        };
        let mut asked = 0;
        for (plan, _) in &admitted {
            let lockfiles = lockfiles_of(plan);
            if lockfiles.is_empty() {
                notes.push(format!("{} has no lockfile, so it was not updated.", plan.directories().join(", ")));
                continue;
            }
            // The same branch as one in progress is replaced in place.
            let branch = pull_text::branch(entry, plan);
            let force = existing.iter().any(|row| row.branch == branch && row.state().in_progress());
            self.ask_version_update(repo, loaded, entry, plan, lockfiles, &registries, force).await?;
            asked += 1;
        }
        let mut summary = format!(
            "Checked {} {}: {} up to date{}, {} {} asked for",
            names.len().min(MAX_PACKAGES),
            if names.len() == 1 { "dependency" } else { "dependencies" },
            up_to_date,
            if ignored > 0 { format!(", {ignored} ignored") } else { String::new() },
            asked,
            if asked == 1 { "pull request" } else { "pull requests" },
        );
        if held > 0 {
            summary.push_str(&format!(", {held} waiting for open-pull-requests-limit"));
        }
        summary.push('.');
        if !failures.is_empty() {
            notes.push(format!("These could not be looked up: {}.", failures.join(", ")));
        }
        for note in notes {
            summary.push(' ');
            summary.push_str(&note);
        }
        Ok(Ok(summary))
    }

    /// Asks the runner for one version update pull request.
    #[allow(clippy::too_many_arguments)]
    async fn ask_version_update(
        &self,
        repo: &RepoRow,
        loaded: &Loaded,
        entry: &Entry,
        plan: &PullPlan,
        lockfiles: Vec<String>,
        registries: &[(Registry, BumpRegistry, Source)],
        force: bool,
    ) -> Result<()> {
        let Some(osv) = osv_ecosystem(&entry.ecosystem) else { return Ok(()) };
        let branch = pull_text::branch(entry, plan);
        let title = pull_text::title(entry, plan);
        let body = pull_text::body(entry, plan, &loaded.file);
        // One version per package: the highest any directory needs.
        let mut highest: BTreeMap<String, String> = BTreeMap::new();
        for update in &plan.updates {
            let known = highest.entry(update.name.clone()).or_insert_with(|| update.to.clone());
            if version::compare(&update.to, known).is_gt() {
                *known = update.to.clone();
            }
        }
        let packages: Vec<BumpPackage> = highest.into_iter().map(|(package, version)| BumpPackage { package, version }).collect();
        let strategy = match entry.versioning_strategy.as_deref() {
            Some("lockfile-only") => "lockfile-only",
            Some("increase-if-necessary") => "increase-if-necessary",
            Some("widen") => "widen",
            _ => "increase",
        };
        let mut bump = BumpArgs {
            repo: Self::repo_path(repo),
            ecosystem: osv.to_owned(),
            package: packages[0].package.clone(),
            version: packages[0].version.clone(),
            lockfiles,
            branch: branch.clone(),
            message: pull_text::commit_message(entry, plan),
            kind: Some("version".to_owned()),
            packages,
            strategy: Some(strategy.to_owned()),
            force,
            registries: Vec::new(),
            base: target_of(entry, &loaded.default_branch),
        };
        let dependencies: Vec<UpdatedDependency> = plan.updates.iter().map(updated).collect();
        let people = |names: &[String]| -> Vec<String> { names.iter().filter(|name| !name.contains('/')).cloned().collect() };
        let id = self
            .store
            .add_update_pull(&NewPull {
                repo_id: &repo.repo_id,
                kind: "version",
                entry: &entry.id(),
                ecosystem: &entry.ecosystem,
                subject: &plan.subject(),
                signature: &plan.signature(),
                group: plan.group.as_deref(),
                branch: &branch,
                title: &title,
                body: &body,
                dependencies: &dependencies,
                bump: &bump,
                assignees: &people(&entry.assignees),
                reviewers: &people(&entry.reviewers),
            })
            .await?;
        bump.registries = registries.iter().map(|(_, ready, _)| ready.clone()).collect();
        if let Err(reason) = self.start_bump(&bump).await {
            self.store.set_update_pull(&id, UpdateState::Failed, None, None, Some(&format!("g1t could not start the update: {reason}"))).await?;
        }
        Ok(())
    }

    async fn start_bump(&self, bump: &BumpArgs) -> std::result::Result<(), String> {
        match g1t_kit::call::<_, Outcome<bool>>(&self.runner, "bump", bump).await {
            Ok(Outcome::Ok(_)) => Ok(()),
            Ok(Outcome::Fail(refused)) => Err(refused.message),
            Err(error) => Err(format!("the runner could not be reached: {error}")),
        }
    }

    /// Makes an open update pull request again from its base, on the same
    /// branch: a rebase, a recreate, or a reopen.
    async fn remake(&self, repo: &RepoRow, row: &PullRow) -> std::result::Result<(), String> {
        let Some(mut bump) = row.bump() else { return Err("it was made before g1t kept how".to_owned()) };
        bump.force = true;
        bump.registries.clear();
        // Credentials are never stored, and g1t's own push is awaited: see
        // `update_pull_pushed`.
        self.store.remake_update_pull(&row.id, &bump).await.map_err(|error| error.to_string())?;
        if row.kind == "version"
            && let Ok(Some(loaded)) = self.load_config(repo).await
            && let Some(entry) = loaded.config.updates.iter().find(|entry| entry.id() == row.entry)
            && let Ok((registries, _)) = self.entry_registries(repo, &loaded, entry).await
        {
            bump.registries = registries.into_iter().map(|(_, ready, _)| ready).collect();
        }
        self.start_bump(&bump).await
    }

    /// An update branch was pushed: its pull request opens, or a remade one
    /// carries on. Returns whether the branch was one of these.
    pub async fn update_pull_pushed(&self, repo_id: &str, branch: &str, after: &str) -> Result<bool> {
        let Some(row) = self.store.update_pull_by_branch(repo_id, branch).await? else { return Ok(false) };
        match row.state() {
            UpdateState::Open => {
                // g1t's own push after a rebase leaves `head` empty; anyone
                // else's leaves it, so a rebase knows not to overwrite them.
                if row.head.is_none() {
                    self.store.set_update_pull_head(&row.id, after).await?;
                }
                Ok(true)
            }
            UpdateState::Requested => {
                let Some(repo) = self.store.repo(repo_id).await? else { return Ok(true) };
                self.open_update_pull(&repo, &row, after).await?;
                Ok(true)
            }
            // No longer needed by the time its sandbox pushed: the branch goes.
            UpdateState::Superseded if row.pull().is_none() => {
                self.drop_pushed(repo_id, branch, after).await?;
                Ok(true)
            }
            _ => Ok(true),
        }
    }

    async fn open_update_pull(&self, repo: &RepoRow, row: &PullRow, after: &str) -> Result<()> {
        let system = User::system(&repo.namespace);
        let opened: Outcome<Pull> = g1t_kit::call(
            &self.work,
            "open_pull",
            &OpenPullArgs {
                actor: system.clone(),
                repo: Self::repo_path(repo),
                issue: None,
                title: row.title.clone(),
                body: row.body.clone(),
                branch: Some(row.branch.clone()),
                agent: String::new(),
                runtime: Runtime::External,
                // Into `target-branch`, which it was made from.
                base: row.bump().and_then(|bump| bump.base),
                draft: false,
            },
        )
        .await?;
        let pull = match opened {
            Outcome::Ok(pull) => pull,
            Outcome::Fail(refused) => {
                let error = format!("The pull request could not be opened: {}", refused.message);
                return self.store.set_update_pull(&row.id, UpdateState::Failed, None, None, Some(&error)).await;
            }
        };
        self.store.set_update_pull(&row.id, UpdateState::Open, Some(pull.number), None, None).await?;
        self.store.set_update_pull_head(&row.id, after).await?;
        let (assignees, reviewers) = (row.names("assignees"), row.names("reviewers"));
        // Its labels and milestone, as the entry says now.
        let entry = match self.load_config(repo).await {
            Ok(Some(loaded)) => loaded.config.updates.into_iter().find(|entry| entry.id() == row.entry),
            _ => None,
        };
        let labels = config::update_labels(entry.as_ref().and_then(|entry| entry.labels.as_deref()), &row.ecosystem);
        let milestone = entry.as_ref().and_then(|entry| entry.milestone);
        let _: Outcome<Value> = g1t_kit::call(
            &self.work,
            "update_pull",
            &UpdatePullArgs {
                actor: system.clone(),
                repo: Self::repo_path(repo),
                number: pull.number,
                assignees: (!assignees.is_empty()).then_some(assignees),
                reviewers: (!reviewers.is_empty()).then_some(reviewers),
                labels: (!labels.is_empty()).then_some(labels),
                milestone: None,
                base: None,
            },
        )
        .await?;
        // Apart, so that a milestone the repository lacks leaves the rest.
        if milestone.is_some() {
            let _: Outcome<Value> = g1t_kit::call(
                &self.work,
                "update_pull",
                &UpdatePullArgs {
                    actor: system.clone(),
                    repo: Self::repo_path(repo),
                    number: pull.number,
                    assignees: None,
                    reviewers: None,
                    labels: None,
                    milestone,
                    base: None,
                },
            )
            .await?;
        }
        // Older ones for the same dependency or group are replaced.
        for older in self.store.update_pulls(&repo.repo_id).await? {
            if older.id == row.id || older.subject != row.subject || older.entry != row.entry || older.state() != UpdateState::Open {
                continue;
            }
            self.store.set_update_pull(&older.id, UpdateState::Superseded, older.pull(), None, None).await?;
            if let Some(number) = older.pull()
                && let Some(found) = self.get_pull(repo, number).await?
                && matches!(found.status, PullStatus::Open | PullStatus::Draft)
                && self.close_with(repo, number, format!("Closed: superseded by #{}.", pull.number)).await?
                && older.branch != row.branch
            {
                self.delete_pull_branch(repo, &Pull { status: PullStatus::Closed, ..found }).await;
            }
        }
        // A grouped security update stands for each package's own.
        if row.kind == "security" {
            for dependency in row.dependencies() {
                let Some(osv) = osv_ecosystem(&row.ecosystem) else { continue };
                if let Some(update) = self.store.update(&repo.repo_id, osv, &dependency.name).await? {
                    self.store.set_update(&update, UpdateState::Open, Some(pull.number), None, None).await?;
                }
            }
        }
        Ok(())
    }

    /// A pull request merged or closed: if it is an update's, where it
    /// stands now. Returns whether it was one.
    pub async fn update_pull_closed(&self, kind: &str, repo_id: &str, number: u32) -> Result<bool> {
        let Some(row) = self.store.update_pull_by_number(repo_id, number).await? else { return Ok(false) };
        if row.state() != UpdateState::Open {
            return Ok(true);
        }
        let state = if kind == "pull.merged" { UpdateState::Merged } else { UpdateState::Closed };
        self.store.set_update_pull(&row.id, state, Some(number), None, None).await?;
        if row.kind == "security" {
            for dependency in row.dependencies() {
                let Some(osv) = osv_ecosystem(&row.ecosystem) else { continue };
                if let Some(update) = self.store.update(repo_id, osv, &dependency.name).await? {
                    self.store.set_update(&update, state, Some(number), None, None).await?;
                }
            }
        }
        Ok(true)
    }

    async fn pull_detail(&self, repo: &RepoRow, number: u32) -> Result<Option<PullDetail>> {
        let found: Outcome<PullDetail> = g1t_kit::call(
            &self.work,
            "get_pull",
            &ViewArgs { repo: Self::repo_path(repo), number, viewer: Some(User::system(&repo.namespace)), after_seq: 0 },
        )
        .await?;
        Ok(found.into_result().ok())
    }

    /// Looks at one open update pull request: merged or closed meanwhile,
    /// its checks failing or passing, or in conflict with its base.
    async fn watch_update_pull(&self, row: &PullRow) -> Result<()> {
        self.store.touch_update_pull(&row.id).await?;
        let (Some(repo), Some(number)) = (self.store.repo(&row.repo_id).await?, row.pull()) else { return Ok(()) };
        let Some(detail) = self.pull_detail(&repo, number).await? else { return Ok(()) };
        match detail.pull.status {
            PullStatus::Merged => return self.update_pull_closed("pull.merged", &row.repo_id, number).await.map(|_| ()),
            PullStatus::Closed => return self.update_pull_closed("pull.closed", &row.repo_id, number).await.map(|_| ()),
            _ => {}
        }
        let ours = row.head.is_some() && row.head == detail.pull.head_commit;
        match checks_verdict(&detail) {
            Some(false) if ours => return self.update_needs_code(&repo, row, &detail).await,
            Some(true) if row.merge_by.is_some() => {
                let merged: Outcome<Pull> = g1t_kit::call(
                    &self.work,
                    "merge_pull",
                    &PullActionArgs {
                        actor: User::system(&repo.namespace),
                        repo: Self::repo_path(&repo),
                        number,
                        summary: String::new(),
                        keep_issue_open: false,
                        ignore_checks: false,
                        bypass_rules: false,
                    },
                )
                .await?;
                if let Outcome::Fail(refused) = merged {
                    self.store.set_merge_by(&row.id, None).await?;
                    self.comment(&User::system(&repo.namespace), &Self::repo_path(&repo), number, format!("I could not merge this: {}", refused.message))
                        .await?;
                }
                return Ok(());
            }
            _ => {}
        }
        let rebases = row.kind == "security" || self.rebase_strategy(&repo, &row.entry) != "disabled";
        if detail.mergeable == Mergeable::Conflicting
            && ours
            && rebases
            && let Err(reason) = self.remake(&repo, row).await
        {
            worker::console_error!("security: update {} not rebased: {reason}", row.id);
        }
        Ok(())
    }

    /// An entry's `rebase-strategy`, as last read.
    fn rebase_strategy(&self, repo: &RepoRow, entry: &str) -> String {
        repo.version_updates()
            .updates
            .iter()
            .find(|found| found.id == entry)
            .and_then(|found| found.options.get("rebase-strategy").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "auto".to_owned())
    }

    /// An update that breaks the branch's required checks: closed, and an
    /// issue opened for g1t to make the code changes it needs.
    async fn update_needs_code(&self, repo: &RepoRow, row: &PullRow, detail: &PullDetail) -> Result<()> {
        let system = User::system(&repo.namespace);
        let path = Self::repo_path(repo);
        let failing: Vec<String> = if detail.required_checks.is_empty() {
            detail.statuses.iter().filter(|status| matches!(status.state.as_str(), "failure" | "error")).map(|status| status.context.clone()).collect()
        } else {
            detail.required_checks.iter().filter(|check| check.state == RequiredState::Failure).map(|check| check.name.clone()).collect()
        };
        let issue: Outcome<g1t_contracts::work::Issue> = g1t_kit::call(
            &self.work,
            "open_issue",
            &OpenIssueArgs {
                actor: system.clone(),
                repo: path.clone(),
                title: format!("{}: needs code changes", row.title).chars().take(200).collect(),
                body: needs_code_text(row, &failing, detail.pull.number),
                labels: vec!["dependencies".to_owned()],
                checks: Vec::new(),
                milestone: None,
            },
        )
        .await?;
        let issue = match issue {
            Outcome::Ok(issue) => issue,
            Outcome::Fail(refused) => {
                let error = format!("Its checks fail, and the issue for it could not be opened: {}", refused.message);
                return self.store.set_update_pull(&row.id, UpdateState::Failed, row.pull(), None, Some(&error)).await;
            }
        };
        self.store.set_update_pull(&row.id, UpdateState::NeedsCode, row.pull(), Some(issue.number), Some("Raising the versions fails this branch's required checks.")).await?;
        self.close_with(repo, detail.pull.number, format!("Raising the versions alone fails this branch's required checks, so code has to change too. g1t is making the change in #{}.", issue.number))
            .await?;
        let started: Outcome<Value> = g1t_kit::call(&self.runner, "run", &json!({ "actor": system, "repo": path, "issue": issue.number })).await?;
        if let Outcome::Fail(refused) = started {
            self.comment(&system, &path, issue.number, format!(
                "g1t could not put an agent on this update: {}\n\nAssign it to g1t once agents can run here, or make the change by hand.",
                refused.message
            ))
            .await?;
        }
        Ok(())
    }

    /// A comment on an update pull request: a command, if it is one.
    pub async fn update_comment(&self, event: &Event) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Commented {
            comment_id: String,
            repo_id: String,
            number: u32,
            #[serde(default)]
            pull_id: Option<String>,
        }
        let Ok(commented) = serde_json::from_value::<Commented>(event.data.clone()) else { return Ok(()) };
        if commented.pull_id.is_none() || event.actor.as_deref().is_some_and(g1t_contracts::system::is_system_id) {
            return Ok(());
        }
        let row = self.store.update_pull_by_number(&commented.repo_id, commented.number).await?;
        let single = self.store.update_by_pull(&commented.repo_id, commented.number).await?;
        if row.is_none() && single.is_none() {
            return Ok(());
        }
        let Some(repo) = self.store.repo(&commented.repo_id).await? else { return Ok(()) };
        let Some(detail) = self.pull_detail(&repo, commented.number).await? else { return Ok(()) };
        let Some(comment) = detail.comments.iter().find(|comment| comment.id == commented.comment_id) else { return Ok(()) };
        let Some(command) = update_command(&comment.body) else { return Ok(()) };
        let author = serde_json::from_value::<CommentAuthor>(serde_json::to_value(&comment.author)?).map(|a| a.username).unwrap_or_default();
        let system = User::system(&repo.namespace);
        let path = Self::repo_path(&repo);
        let needed = if matches!(command, UpdateCommand::Merge | UpdateCommand::SquashAndMerge | UpdateCommand::CancelMerge) {
            Capability::Merge
        } else {
            Capability::Push
        };
        let permission: Outcome<PermissionInfo> = g1t_kit::call(
            &self.identity,
            "collaborator_permission",
            &CollaboratorPermissionArgs { viewer: Some(system.clone()), path: path.clone(), username: author.clone() },
        )
        .await?;
        let allowed = matches!(&permission, Outcome::Ok(info) if info.capabilities.contains(&needed));
        if !allowed {
            let text = format!("@{author}, that takes the {} role on this repository.", if needed == Capability::Merge { "Maintain or Write" } else { "Write" });
            return self.comment(&system, &path, commented.number, text).await;
        }
        let Some(row) = row else {
            // A security update for one package: the commands that make sense for it.
            return self.single_update_command(&repo, single.as_ref(), &command, &author, commented.number, &detail).await;
        };
        let reply = self.command(&repo, &row, &command, &author, &detail).await?;
        if let Some(reply) = reply {
            self.comment(&system, &path, commented.number, reply).await?;
        }
        Ok(())
    }

    /// Acts on a command on an update pull request; what to say back.
    async fn command(&self, repo: &RepoRow, row: &PullRow, command: &UpdateCommand, author: &str, detail: &PullDetail) -> Result<Option<String>> {
        let number = detail.pull.number;
        let open = detail.pull.status.is_active();
        let ignore = |dependency: &str, versions: Option<String>, update_type: Option<String>| IgnoreCondition {
            ecosystem: row.ecosystem.clone(),
            dependency: dependency.to_owned(),
            versions,
            update_type,
            by: author.to_owned(),
            pull: Some(number),
            at: String::new(),
        };
        let dependencies = row.dependencies();
        Ok(Some(match command {
            UpdateCommand::Rebase | UpdateCommand::Recreate => {
                if !open {
                    return Ok(Some(format!("@{author}, this pull request is {}; `@g1t reopen` opens it again.", detail.pull.status.as_str())));
                }
                let pushed_by_others = row.head.is_some() && row.head != detail.pull.head_commit;
                if *command == UpdateCommand::Rebase && pushed_by_others {
                    return Ok(Some(format!("@{author}, someone else has pushed to this branch, so a rebase would drop their commits. `@g1t recreate` makes it again from scratch.")));
                }
                match self.remake(repo, row).await {
                    Ok(()) => format!("@{author}, {} this pull request from its base branch now.", if *command == UpdateCommand::Rebase { "rebasing" } else { "recreating" }),
                    Err(reason) => format!("@{author}, I could not start that: {reason}"),
                }
            }
            UpdateCommand::Merge | UpdateCommand::SquashAndMerge => {
                if !open {
                    return Ok(Some(format!("@{author}, this pull request is already {}.", detail.pull.status.as_str())));
                }
                self.store.set_merge_by(&row.id, Some(author)).await?;
                match checks_verdict(detail) {
                    Some(false) => format!("@{author}, its required checks are failing; it merges once they pass."),
                    Some(true) => {
                        self.watch_update_pull(row).await?;
                        return Ok(None);
                    }
                    None => format!("@{author}, it merges once its required checks pass."),
                }
            }
            UpdateCommand::CancelMerge => {
                self.store.set_merge_by(&row.id, None).await?;
                format!("@{author}, it will not merge on its own now.")
            }
            UpdateCommand::Close => {
                self.store.set_update_pull(&row.id, UpdateState::Closed, row.pull(), None, None).await?;
                self.close_with(repo, number, format!("@{author}, closed. g1t will not open a pull request for these versions again, but will when a newer one is out.")).await?;
                return Ok(None);
            }
            UpdateCommand::Reopen => {
                if open {
                    return Ok(Some(format!("@{author}, this pull request is already open.")));
                }
                self.store.set_update_pull(&row.id, UpdateState::Requested, None, None, None).await?;
                match self.remake(repo, row).await {
                    Ok(()) => format!("@{author}, making it again; it opens as a new pull request on the same branch."),
                    Err(reason) => format!("@{author}, I could not start that: {reason}"),
                }
            }
            UpdateCommand::IgnoreDependency | UpdateCommand::IgnoreVersion { .. } => {
                if row.group_name.is_some() && dependencies.len() > 1 {
                    return Ok(Some(format!(
                        "@{author}, this pull request updates several dependencies. Name one: `@g1t ignore <dependency>`, or `@g1t ignore <dependency> major version`."
                    )));
                }
                for dependency in &dependencies {
                    let condition = match command {
                        UpdateCommand::IgnoreVersion { level } => ignore(&dependency.name, Some(ranges::ignore_level(&dependency.to, level)), None),
                        _ => ignore(&dependency.name, None, None),
                    };
                    self.store.add_ignore(&repo.repo_id, &condition).await?;
                }
                self.store.set_update_pull(&row.id, UpdateState::Closed, row.pull(), None, None).await?;
                let what = match command {
                    UpdateCommand::IgnoreVersion { level } => format!("this {level} version"),
                    _ => "this dependency".to_owned(),
                };
                self.close_with(repo, number, format!("@{author}, g1t will skip {what} from now on. `@g1t unignore {}` undoes it.", dependencies.first().map(|d| d.name.as_str()).unwrap_or("*")))
                    .await?;
                return Ok(None);
            }
            UpdateCommand::IgnoreNamed { dependency, level } => {
                let Some(found) = dependencies.iter().find(|d| d.name.eq_ignore_ascii_case(dependency)) else {
                    return Ok(Some(format!("@{author}, this pull request does not update {dependency}.")));
                };
                let condition = match level {
                    Some(level) => ignore(&found.name, Some(ranges::ignore_level(&found.to, level)), None),
                    None => ignore(&found.name, None, None),
                };
                self.store.add_ignore(&repo.repo_id, &condition).await?;
                format!("@{author}, g1t will skip {}{}; the next check leaves it out of this group.", found.name, level.as_deref().map(|level| format!(" {level} versions like {}", found.to)).unwrap_or_default())
            }
            UpdateCommand::Unignore { dependency, level } => {
                let condition = match (level, dependencies.iter().find(|d| d.name.eq_ignore_ascii_case(dependency))) {
                    (Some(level), Some(found)) => Some(ranges::ignore_level(&found.to, level)),
                    _ => None,
                };
                let removed = self.store.remove_ignores(&repo.repo_id, &row.ecosystem, dependency, condition.as_deref()).await?;
                if removed == 0 {
                    format!("@{author}, nothing was being ignored for {dependency}.")
                } else {
                    format!("@{author}, removed {removed} ignore {} for {dependency}.", if removed == 1 { "condition" } else { "conditions" })
                }
            }
            UpdateCommand::ShowIgnores { dependency } => {
                let names: Vec<String> = match dependency {
                    Some(name) => vec![name.clone()],
                    None => dependencies.iter().map(|d| d.name.clone()).collect(),
                };
                self.ignore_report(repo, &row.ecosystem, &row.entry, &names).await?
            }
        }))
    }

    /// The ignore conditions on some dependencies, from the file and from
    /// comments, as a reply.
    async fn ignore_report(&self, repo: &RepoRow, ecosystem: &str, entry: &str, names: &[String]) -> Result<String> {
        let state = repo.version_updates();
        let rules = state.updates.iter().find(|found| found.id == entry).map(|found| found.ignore.clone()).unwrap_or_default();
        let comments = self.store.ignores(&repo.repo_id).await?;
        let mut lines = Vec::new();
        for name in names {
            for rule in rules.iter().filter(|rule| config::matches(&rule.dependency, name)) {
                let what = if !rule.versions.is_empty() {
                    format!("versions {}", rule.versions.join(", "))
                } else if !rule.update_types.is_empty() {
                    rule.update_types.join(", ")
                } else {
                    "every version".to_owned()
                };
                lines.push(format!("- `{name}`: {what} (in the dependency update file, `{}`)", rule.dependency));
            }
            for condition in comments.iter().filter(|c| c.ecosystem == ecosystem && c.dependency.eq_ignore_ascii_case(name)) {
                let what = condition
                    .versions
                    .clone()
                    .map(|versions| format!("versions `{versions}`"))
                    .or_else(|| condition.update_type.clone())
                    .unwrap_or_else(|| "every version".to_owned());
                lines.push(format!(
                    "- `{name}`: {what} (asked by @{}{})",
                    condition.by,
                    condition.pull.map(|pull| format!(" in #{pull}")).unwrap_or_default()
                ));
            }
        }
        Ok(if lines.is_empty() {
            format!("Nothing is ignored for {}.", names.join(", "))
        } else {
            format!("Ignore conditions:\n\n{}", lines.join("\n"))
        })
    }

    /// Commands on a security update for one package.
    async fn single_update_command(
        &self,
        repo: &RepoRow,
        update: Option<&crate::store::UpdateRow>,
        command: &UpdateCommand,
        author: &str,
        number: u32,
        detail: &PullDetail,
    ) -> Result<()> {
        let Some(update) = update else { return Ok(()) };
        let system = User::system(&repo.namespace);
        let path = Self::repo_path(repo);
        let Some(ecosystem) = package_ecosystem(&update.ecosystem) else { return Ok(()) };
        let ignore = |versions: Option<String>| IgnoreCondition {
            ecosystem: ecosystem.to_owned(),
            dependency: update.package.clone(),
            versions,
            update_type: None,
            by: author.to_owned(),
            pull: Some(number),
            at: String::new(),
        };
        let reply = match command {
            UpdateCommand::Close => {
                self.store.set_update(update, UpdateState::Closed, Some(number), None, None).await?;
                self.close_with(repo, number, format!("@{author}, closed. g1t will not open a security update for {} {} again.", update.package, update.target)).await?;
                return Ok(());
            }
            UpdateCommand::IgnoreDependency | UpdateCommand::IgnoreVersion { .. } => {
                let versions = match command {
                    UpdateCommand::IgnoreVersion { level } => Some(ranges::ignore_level(&update.target, level)),
                    _ => None,
                };
                self.store.add_ignore(&repo.repo_id, &ignore(versions)).await?;
                self.store.set_update(update, UpdateState::Closed, Some(number), None, None).await?;
                self.close_with(repo, number, format!("@{author}, g1t will skip that for {} from now on. `@g1t unignore {}` undoes it.", update.package, update.package)).await?;
                return Ok(());
            }
            UpdateCommand::Unignore { dependency, .. } => {
                let removed = self.store.remove_ignores(&repo.repo_id, ecosystem, dependency, None).await?;
                format!("@{author}, removed {removed} ignore conditions for {dependency}.")
            }
            UpdateCommand::ShowIgnores { dependency } => {
                let name = dependency.clone().unwrap_or_else(|| update.package.clone());
                self.ignore_report(repo, ecosystem, "", &[name]).await?
            }
            UpdateCommand::Merge | UpdateCommand::SquashAndMerge => match checks_verdict(detail) {
                Some(true) => {
                    let merged: Outcome<Pull> = g1t_kit::call(
                        &self.work,
                        "merge_pull",
                        &PullActionArgs { actor: system.clone(), repo: path.clone(), number, summary: String::new(), keep_issue_open: false, ignore_checks: false, bypass_rules: false },
                    )
                    .await?;
                    match merged {
                        Outcome::Ok(_) => return Ok(()),
                        Outcome::Fail(refused) => format!("@{author}, I could not merge this: {}", refused.message),
                    }
                }
                _ => format!("@{author}, its required checks have not passed yet; merge it once they do."),
            },
            _ => format!("@{author}, a security update is made again by `Re-scan now` on the Security page; this command is for version updates."),
        };
        self.comment(&system, &path, number, reply).await
    }

    /// A pull request that changes the dependency update file gets a
    /// status saying whether the file is valid.
    pub async fn check_dependabot_file(&self, event: &Event) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Changed {
            repo_id: String,
            number: u32,
        }
        let Ok(changed) = serde_json::from_value::<Changed>(event.data.clone()) else { return Ok(()) };
        let Some(repo) = self.store.repo(&changed.repo_id).await? else { return Ok(()) };
        let Some(detail) = self.pull_detail(&repo, changed.number).await? else { return Ok(()) };
        let pull = &detail.pull;
        let Some(file) = pull.files.iter().find(|file| DEPENDABOT_PATHS.contains(&file.path.as_str())) else { return Ok(()) };
        let Some(head) = pull.head_commit.clone() else { return Ok(()) };
        let found: Option<RawFile> = g1t_kit::call(
            &self.repos,
            "raw_file",
            &RawFileArgs {
                repo_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.repo_id.clone()),
                git_ref: head.clone(),
                path: file.path.clone(),
                max_bytes: 1_000_000,
            },
        )
        .await?;
        let (state, description) = match found.and_then(|raw| base64_decode(&raw.data)).map(String::from_utf8) {
            None => ("success".to_owned(), format!("{} is removed.", file.path)),
            Some(Err(_)) => ("failure".to_owned(), format!("{} is not text.", file.path)),
            Some(Ok(text)) => {
                let read = config::read(&text);
                match read.problems.first() {
                    None => ("success".to_owned(), format!("{} is valid: {} entries.", file.path, read.config.updates.len())),
                    Some(problem) => {
                        let more = if read.problems.len() > 1 { format!(" (and {} more)", read.problems.len() - 1) } else { String::new() };
                        ("failure".to_owned(), format!("{}{more}", problem.sentence()))
                    }
                }
            }
        };
        let site = format!("https://g1t.sh/{}/{}/blob/{head}/{}", repo.namespace, repo.name, file.path);
        let _: Outcome<bool> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &SetCommitStatusArgs {
                repo_id: repo.repo_id.clone(),
                sha: head,
                context: DEPENDABOT_CHECK.to_owned(),
                state,
                description: Some(description.chars().take(400).collect()),
                target_url: Some(site),
                source: Some("security".to_owned()),
            },
        )
        .await?;
        Ok(())
    }

    /// What the Security page shows: the file as last read, with each
    /// entry's runs, the update pull requests, and comment ignores.
    pub async fn version_updates_view(&self, repo: &RepoRow) -> Result<VersionUpdatesState> {
        let mut state = repo.version_updates();
        let runs = self.store.runs(&repo.repo_id).await?;
        for entry in &mut state.updates {
            if let Some(run) = runs.iter().find(|run| run.entry == entry.id) {
                entry.next_run_at = run.next_run_at.clone();
                entry.last_checked_at = run.last_checked_at.clone();
                entry.last_result = run.last_result.clone();
                entry.last_error = run.last_error.clone();
            }
        }
        let rows = self.store.update_pulls(&repo.repo_id).await?;
        let (live, done): (Vec<&PullRow>, Vec<&PullRow>) = rows.iter().partition(|row| row.state().in_progress());
        state.pulls = live.into_iter().chain(done.into_iter().take(20)).map(PullRow::to_contract).collect();
        state.ignores = self.store.ignores(&repo.repo_id).await?;
        Ok(state)
    }
}

/// Whether g1t runs an entry: an ecosystem it updates, and pull requests
/// it can open (`open-pull-requests-limit` above 0), into the default
/// branch or the entry's `target-branch`.
pub fn runnable(entry: &Entry, _default_branch: Option<&str>) -> bool {
    entry.supported() && entry.open_pull_requests_limit > 0 && entry.schedule.is_some()
}

/// The branch an entry's updates start from and merge into, when it is not
/// the default branch.
pub fn target_of(entry: &Entry, default_branch: &str) -> Option<String> {
    entry.target_branch.clone().filter(|branch| !branch.is_empty() && branch != default_branch)
}

fn updated(update: &Planned) -> UpdatedDependency {
    UpdatedDependency {
        name: update.name.clone(),
        from: update.from.clone(),
        to: update.to.clone(),
        directory: update.directory.clone(),
        dependency_type: update.kind.label().to_owned(),
        update_type: format!("version-update:semver-{}", update.level),
    }
}

/// The issue for an update that breaks the build, for the agent that takes
/// it as much as for a person.
pub fn needs_code_text(row: &PullRow, failing: &[String], pull: u32) -> String {
    let mut body = format!(
        "#{pull} raises these dependencies, and this branch's required checks fail with only the versions changed{}:\n\n| Package | Directory | From | To |\n| --- | --- | --- | --- |\n",
        if failing.is_empty() { String::new() } else { format!(" ({})", failing.join(", ")) }
    );
    for dependency in row.dependencies() {
        body.push_str(&format!("| `{}` | `{}` | {} | {} |\n", dependency.name, dependency.directory, dependency.from, dependency.to));
    }
    body.push_str(
        "\nUpgrade them as #{pull} does and change the code that depends on them until the checks pass, keeping other changes to what the upgrade needs. Read each package's release notes for what changed.",
    );
    let body = body.replace("#{pull}", &format!("#{pull}"));
    let mut body = g1t_contracts::work::with_definition_of_done(&body, &["Every dependency above is at its new version, and the required checks pass.".to_owned()]);
    body.push_str("\n\n---\n_Opened by g1t's version updates._");
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::read;
    use g1t_contracts::work::{CommitStatus, RequiredCheck};

    fn entry(extra: &str) -> Entry {
        let found = read(&format!("version: 2\nupdates:\n  - package-ecosystem: npm\n{extra}    schedule: {{interval: daily}}\n"));
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        found.config.updates.into_iter().next().unwrap()
    }

    #[test]
    fn base64_round_trips() {
        for text in ["", "a", "ab", "abc", "user:pa$$word", "version: 2\n"] {
            assert_eq!(base64_decode(&base64_encode(text.as_bytes())).unwrap(), text.as_bytes());
        }
        assert_eq!(base64_encode(b"ci:secret"), "Y2k6c2VjcmV0");
    }

    #[test]
    fn secrets_are_filled_in() {
        let mut secrets = serde_json::Map::new();
        secrets.insert("TOKEN".into(), json!("t0k"));
        assert_eq!(fill_secrets("${{secrets.TOKEN}}", &secrets), ("t0k".to_owned(), vec![]));
        assert_eq!(fill_secrets("Bearer ${{ secrets.TOKEN }}!", &secrets).0, "Bearer t0k!");
        assert_eq!(fill_secrets("${{secrets.NOPE}}", &secrets).1, ["NOPE"]);
        assert_eq!(fill_secrets("plain", &secrets).0, "plain");
    }

    #[test]
    fn directories_from_globs_and_exclusions() {
        let files: Vec<String> = ["package.json", "apps/web/package.json", "apps/admin/package.json", "apps/web/vendor/x/package.json", "docs/readme.md"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(entry_directories(&entry("    directory: /\n"), &files), ["/"]);
        assert_eq!(entry_directories(&entry("    directories: [\"/apps/*\"]\n"), &files), ["/apps/admin", "/apps/web"]);
        assert_eq!(
            entry_directories(&entry("    directories: [\"/apps/**\"]\n    exclude-paths: [\"**/vendor/**\"]\n"), &files),
            ["/apps/admin", "/apps/web"]
        );
        assert!(entry_directories(&entry("    directory: /missing\n"), &files).is_empty());
        let locks: Vec<String> = ["package-lock.json", "apps/web/package.json", "Cargo.lock"].map(str::to_owned).to_vec();
        assert_eq!(lockfiles_for("npm", "/apps/web", &locks), ["package-lock.json"]);
        assert!(lockfiles_for("pip", "/", &locks).is_empty());
    }

    #[test]
    fn current_versions_come_from_the_lockfile() {
        let directory = Directory {
            path: "/".into(),
            declared: manifests::package_json(r#"{"dependencies":{"lodash":"^4.17.0","left-pad":"1.0.0"},"devDependencies":{"vitest":"^1"}}"#),
            locked: BTreeMap::from([
                ("lodash".to_owned(), vec!["4.17.20".to_owned(), "3.10.1".to_owned()]),
                ("minimist".to_owned(), vec!["1.2.0".to_owned()]),
            ]),
            lockfiles: vec!["package-lock.json".into()],
        };
        let found = directory_candidates(&entry("    directory: /\n"), &directory);
        assert_eq!(found, [("lodash".to_owned(), DependencyType::Production, "4.17.20".to_owned(), Some("^4.17.0".to_owned()))]);
        let go = Directory {
            path: "/".into(),
            declared: manifests::go_mod("require golang.org/x/net v0.7.0\n"),
            locked: BTreeMap::new(),
            lockfiles: vec!["go.mod".into()],
        };
        let mut go_entry = entry("    directory: /\n");
        go_entry.ecosystem = "gomod".into();
        let found = directory_candidates(&go_entry, &go);
        assert_eq!(found[0].2, "v0.7.0");
    }

    fn row(subject: &str, signature: &str, state: &str) -> PullRow {
        PullRow {
            id: format!("upd_{subject}_{state}"),
            repo_id: "rep_1".into(),
            kind: "version".into(),
            entry: "npm:/".into(),
            ecosystem: "npm".into(),
            subject: subject.into(),
            signature: signature.into(),
            group_name: None,
            branch: "g1t/npm_and_yarn/x".into(),
            title: String::new(),
            body: String::new(),
            dependencies: "[]".into(),
            bump: "{}".into(),
            assignees: "[]".into(),
            reviewers: "[]".into(),
            state: state.into(),
            pull: Some(3),
            head: None,
            merge_by: None,
            error: None,
            updated_at: String::new(),
        }
    }

    fn plan(name: &str, to: &str) -> PullPlan {
        PullPlan {
            group: None,
            by_name: false,
            updates: vec![Planned {
                name: name.into(),
                directory: "/".into(),
                kind: DependencyType::Production,
                from: "1.0.0".into(),
                to: to.into(),
                level: "minor",
                source: None,
                changelog: None,
                page: None,
            }],
        }
    }

    #[test]
    fn the_limit_counts_open_pull_requests_and_replacements_do_not() {
        let plans = vec![plan("a", "1.1.0"), plan("b", "1.1.0"), plan("c", "1.1.0"), plan("d", "1.1.0")];
        let existing = vec![
            row("dependency:/:a", "/a@1.0.5", "open"),
            row("dependency:/:b", "/b@1.1.0", "open"),
            row("dependency:/:c", "/c@1.1.0", "closed"),
        ];
        let (admitted, held) = admit(&plans, &existing, 3);
        let names: Vec<(&str, bool)> = admitted.iter().map(|(plan, older)| (plan.updates[0].name.as_str(), older.is_some())).collect();
        // a replaces its older pull request; b is open already; c was closed by a person for this version; d is new, and fits.
        assert_eq!(names, [("a", true), ("d", false)]);
        assert_eq!(held, 0);
        let (admitted, held) = admit(&plans, &existing, 2);
        assert_eq!(admitted.len(), 1);
        assert_eq!(held, 1);
    }

    #[test]
    fn checks_decide_failure_and_success() {
        let check = |state| RequiredCheck { name: "CI".into(), state, description: None, target_url: None };
        let status = |state: &str| CommitStatus { context: "CI / push".into(), state: state.into(), description: None, target_url: None, updated_at: String::new(), source: None, check_run_id: None };
        let detail = |required: Vec<RequiredCheck>, statuses: Vec<CommitStatus>| {
            let mut detail: PullDetail = serde_json::from_value(json!({
                "pull": {"id": "pul_1", "repoId": "rep_1", "number": 1, "issue": null, "title": "t", "body": null, "agent": "", "runtime": "external",
                         "status": "open", "fork": null, "forkRepoId": null, "branch": "b", "headCommit": "c", "mergeBase": null, "mergedBy": null,
                         "mergedAt": null, "supersededBy": null, "checkStatus": null,
                         "author": {"id": "g1t", "username": "g1t", "kind": "system"}, "createdAt": "", "updatedAt": ""},
                "issue": null, "comments": [], "checks": null
            }))
            .unwrap();
            detail.required_checks = required;
            detail.statuses = statuses;
            detail
        };
        assert_eq!(checks_verdict(&detail(vec![check(RequiredState::Success)], vec![])), Some(true));
        assert_eq!(checks_verdict(&detail(vec![check(RequiredState::Success), check(RequiredState::Failure)], vec![])), Some(false));
        assert_eq!(checks_verdict(&detail(vec![check(RequiredState::Pending)], vec![])), None);
        assert_eq!(checks_verdict(&detail(vec![], vec![status("error")])), Some(false));
        assert_eq!(checks_verdict(&detail(vec![], vec![status("pending")])), None);
        assert_eq!(checks_verdict(&detail(vec![], vec![])), Some(true));
    }

    #[test]
    fn which_entries_run() {
        assert!(runnable(&entry("    directory: /\n"), Some("main")));
        assert!(!runnable(&entry("    directory: /\n    open-pull-requests-limit: 0\n"), Some("main")));
        assert!(runnable(&entry("    directory: /\n    target-branch: main\n"), Some("main")));
        assert!(runnable(&entry("    directory: /\n    target-branch: develop\n"), Some("main")));
        assert_eq!(target_of(&entry("    directory: /\n    target-branch: develop\n"), "main").as_deref(), Some("develop"));
        assert_eq!(target_of(&entry("    directory: /\n    target-branch: main\n"), "main"), None);
        assert_eq!(target_of(&entry("    directory: /\n"), "main"), None);
        assert_eq!(osv_ecosystem("gomod"), Some("Go"));
        assert_eq!(package_ecosystem("crates.io"), Some("cargo"));
    }

    #[test]
    fn the_issue_names_what_broke() {
        let mut found = row("group:lint", "", "open");
        found.dependencies = serde_json::to_string(&[UpdatedDependency {
            name: "eslint".into(),
            from: "8.0.0".into(),
            to: "9.0.0".into(),
            directory: "/".into(),
            dependency_type: "direct:development".into(),
            update_type: "version-update:semver-major".into(),
        }])
        .unwrap();
        let text = needs_code_text(&found, &["CI".into()], 12);
        assert!(text.starts_with("#12 raises these dependencies, and this branch's required checks fail with only the versions changed (CI):"));
        assert!(text.contains("| `eslint` | `/` | 8.0.0 | 9.0.0 |"));
        assert!(text.contains("Upgrade them as #12 does"));
        assert!(text.contains("## Definition of done"));
    }
}
