//! Security updates: for each vulnerable package with a fix, g1t itself
//! opens a pull request that raises its version.
//!
//! 1. A dependency scan asks the runner for a `bump` (most severe first):
//!    a sandbox raises the package in each lockfile with the ecosystem's
//!    own tool and pushes that to `g1t/security/<package>-<version>`.
//! 2. That push (`git.push`) opens the pull request, authored by g1t
//!    (`User::system`). It lands through the branch's required checks like
//!    any other. An older one for the same package is closed as superseded.
//! 3. When its checks fail because code has to change, or the sandbox
//!    never pushed, the pull request is closed and an issue is opened for
//!    g1t to work on, started by g1t. That is the only time an agent is
//!    used.
//! 4. Once none of the alerts it fixes is open (fixed on the default
//!    branch, or dismissed), its pull request is closed with a comment
//!    saying why and its branch deleted (`resolved`).
//!
//! Each step is written to the alerts' activity log.

use std::collections::BTreeMap;

use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::{BumpArgs, UpdateState, update_branch};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{OpenIssueArgs, OpenPullArgs, Pull, PullActionArgs, PullDetail, PullStatus, Runtime, ViewArgs};
use g1t_contracts::{Outcome, User};
use g1t_kit::now_ms;
use g1t_scan::osv::{self, Severity};
use g1t_scan::version;
use serde_json::{Value, json};
use worker::Result;

use g1t_contracts::security::UPDATE_BRANCH_PREFIX;
use g1t_contracts::updates::{BumpPackage, IgnoreCondition, UpdatedDependency, VersionUpdateEntry, VersionUpdatesState};
use g1t_contracts::work::UpdatePullArgs;

use crate::Security;
use crate::config::{CommitMessage, Config, Entry, glob, matches};
use crate::deps::{advisory_table, issue_text};
use crate::pull_text;
use crate::ranges;
use crate::store::{Activity, RepoRow, UpdateRow, VulnRow};
use crate::update_store::NewPull;
use crate::version_updates::{Loaded, package_ecosystem};

/// Security updates asked for per scan, most severe first.
const MAX_NEW_UPDATES: usize = 8;
/// A sandbox that has not pushed its branch after this long is taken to
/// have failed.
const STALLED_MS: u64 = 45 * 60 * 1000;
/// A failed update is tried again after this long.
const RETRY_FAILED_MS: u64 = 24 * 60 * 60 * 1000;

/// What to do about a package's existing update, given the version it
/// should now reach.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// Leave it: in flight, done, or someone closed it.
    Wait,
    /// Ask for a new one.
    Request,
}

/// Whether a package with an update in `state` to `current`, last changed
/// at `updated_at`, needs a new one to reach `target`. A higher target
/// always does; the same one only when the last was superseded (it is
/// vulnerable again) or failed long enough ago.
pub fn next_step(state: UpdateState, current: &str, target: &str, updated_at: &str, retry_after: &str) -> Next {
    if version::compare(target, current) == std::cmp::Ordering::Greater {
        return Next::Request;
    }
    match state {
        UpdateState::Superseded => Next::Request,
        UpdateState::Failed if updated_at < retry_after => Next::Request,
        _ => Next::Wait,
    }
}

/// The pull request's title.
pub fn pull_title(package: &str, target: &str) -> String {
    format!("Upgrade {package} to {target}").chars().take(200).collect()
}

/// The pull request's body: what it fixes, where, and what happens if
/// raising the version is not enough.
pub fn pull_text(ecosystem: &str, package: &str, target: &str, vulns: &[&VulnRow]) -> String {
    let mut from: Vec<&str> = vulns.iter().map(|vuln| vuln.version.as_str()).collect();
    from.sort();
    from.dedup();
    let mut lockfiles: Vec<&str> = vulns.iter().map(|vuln| vuln.manifest.as_str()).collect();
    lockfiles.sort();
    lockfiles.dedup();
    let mut body = format!(
        "Upgrades `{package}` ({ecosystem}) from {} to **{target}**, which fixes these known vulnerabilities:\n\n",
        from.join(", ")
    );
    body.push_str(&advisory_table(vulns));
    body.push_str(&format!(
        "\nLockfiles changed: {}.\n\n\
         Only the version changes. This pull request lands through this branch's required checks like any other. \
         If they fail because code has to change, g1t closes it and puts g1t on an issue to make the change.\n\n\
         ---\n_Opened by g1t's security updates. Turn them off for this project on its Security page._",
        lockfiles.iter().map(|path| format!("`{path}`")).collect::<Vec<_>>().join(", ")
    ));
    body
}

/// A package a `security-updates` group gathers.
pub struct GroupMember {
    /// OSV's name.
    pub ecosystem: String,
    pub package: String,
    /// The lowest vulnerable version found.
    pub from: String,
    pub target: String,
    /// The lockfiles that resolve a vulnerable version.
    pub manifests: Vec<String>,
}

fn lowest(vulns: &[&VulnRow]) -> String {
    vulns.iter().map(|vuln| vuln.version.clone()).min_by(|a, b| version::compare(a, b)).unwrap_or_default()
}

/// Whether one of the file's directories (`/web`, or a glob) holds the
/// lockfile at `path`, from the root.
fn covers(directories: &[String], path: &str) -> bool {
    let directory = format!("/{}", path.rsplit_once('/').map_or("", |(dir, _)| dir));
    directories.iter().any(|wanted| if wanted.contains(['*', '?']) { glob(wanted, &directory) } else { *wanted == directory })
}

/// The `updates` entry that speaks for a vulnerable package: its
/// ecosystem, a directory holding one of its lockfiles, and no
/// `target-branch` but the default branch (security updates always go to
/// the default branch, and such an entry's options are for version
/// updates only).
pub fn security_entry<'a>(config: &'a Config, default_branch: &str, osv: &str, manifests: &[&str]) -> Option<&'a Entry> {
    let ecosystem = package_ecosystem(osv)?;
    config.updates.iter().find(|entry| {
        entry.ecosystem == ecosystem
            && entry.target_branch.as_deref().is_none_or(|branch| branch == default_branch)
            && manifests.iter().any(|path| covers(&entry.directories, path))
    })
}

/// Whether the file lets a security update raise `package` to `target`:
/// not ignored (by name, or for these versions) in the file or by a
/// comment, and named by `allow` when it names dependencies.
pub fn security_allowed(entry: &Entry, comments: &[IgnoreCondition], package: &str, target: &str) -> bool {
    let ignored = entry.ignore.iter().filter(|rule| matches(&rule.dependency, package)).any(|rule| {
        (rule.versions.is_empty() && rule.update_types.is_empty()) || rule.versions.iter().any(|versions| ranges::ignored_by(versions, target))
    });
    let commented = comments.iter().filter(|c| c.ecosystem == entry.ecosystem && c.dependency.eq_ignore_ascii_case(package)).any(|c| {
        (c.versions.is_none() && c.update_type.is_none()) || c.versions.as_deref().is_some_and(|versions| ranges::ignored_by(versions, target))
    });
    let named: Vec<&str> = entry.allow.iter().filter_map(|rule| rule.dependency.as_deref()).collect();
    let allowed = named.is_empty() || named.iter().any(|pattern| matches(pattern, package));
    !ignored && !commented && allowed
}

/// The `security-updates` group that gathers `package`, if any.
pub fn security_group(entry: &Entry, package: &str, from: &str, target: &str) -> Option<String> {
    let level = ranges::update_level(from, target);
    entry
        .groups
        .iter()
        .filter(|group| group.applies_to == "security-updates")
        .find(|group| {
            (group.patterns.is_empty() || group.patterns.iter().any(|pattern| matches(pattern, package)))
                && !group.exclude_patterns.iter().any(|pattern| matches(pattern, package))
                && (group.update_types.is_empty() || group.update_types.iter().any(|wanted| wanted == level))
        })
        .map(|group| group.name.clone())
}

/// The entry, as last read, that speaks for a package's security update.
pub fn security_settings<'a>(state: &'a VersionUpdatesState, osv: &str, manifests: &[&str]) -> Option<&'a VersionUpdateEntry> {
    let ecosystem = package_ecosystem(osv)?;
    state.updates.iter().find(|entry| {
        entry.ecosystem == ecosystem && entry.target_branch.is_none() && manifests.iter().any(|path| covers(&entry.directories, path))
    })
}

/// An entry's `commit-message`, as last read.
pub fn commit_message_of(entry: &VersionUpdateEntry) -> Option<CommitMessage> {
    let message = entry.options.get("commit-message")?;
    let text = |key: &str| message.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(CommitMessage { prefix: text("prefix"), prefix_development: text("prefix-development"), scope: text("include").as_deref() == Some("scope") })
}

/// A title with the file's commit message prefix, if it has one.
fn prefixed(prefix: &str, plain: String) -> String {
    let text = if prefix.is_empty() { plain } else { format!("{prefix}{}{}", plain[..1].to_lowercase(), &plain[1..]) };
    text.chars().take(200).collect()
}

/// A grouped security update's body.
pub fn group_text(group: &str, members: &[GroupMember], vulns: &[&VulnRow], file: &str) -> String {
    let mut body = format!("Upgrades the {group} group's vulnerable packages to the versions that fix them:\n\n| Package | From | To |\n| --- | --- | --- |\n");
    for member in members {
        body.push_str(&format!("| `{}` | {} | **{}** |\n", member.package, member.from, member.target));
    }
    body.push_str("\nThe known vulnerabilities they fix:\n\n");
    body.push_str(&advisory_table(vulns));
    body.push_str(&format!(
        "\nOnly the versions change. This pull request lands through this branch's required checks like any other. \
         If they fail because code has to change, g1t closes it and puts g1t on an issue to make the change.\n\n{}\n\n---\n\
         _Opened by g1t's security updates, grouped as `{file}` asks. Turn them off for this project on its Security page._",
        pull_text::COMMANDS
    ));
    body
}

impl Security {
    pub(crate) fn path_of(repo: &RepoRow) -> RepoPath {
        RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() }
    }

    pub(crate) async fn get_pull(&self, repo: &RepoRow, number: u32) -> Result<Option<Pull>> {
        let found: Outcome<PullDetail> = g1t_kit::call(
            &self.work,
            "get_pull",
            &ViewArgs { repo: Self::path_of(repo), number, viewer: Some(User::system(&repo.namespace)), after_seq: 0 },
        )
        .await?;
        Ok(found.into_result().ok().map(|detail| detail.pull))
    }

    /// Closes one of g1t's pull requests, saying why first. Returns
    /// whether it closed.
    pub(crate) async fn close_with(&self, repo: &RepoRow, number: u32, why: String) -> Result<bool> {
        let system = User::system(&repo.namespace);
        self.comment(&system, &Self::path_of(repo), number, why).await?;
        let closed: Outcome<Value> = g1t_kit::call(
            &self.work,
            "close_pull",
            &PullActionArgs {
                actor: system,
                repo: Self::path_of(repo),
                number,
                summary: String::new(),
                keep_issue_open: false,
                ignore_checks: false,
                bypass_rules: false,
            },
        )
        .await?;
        if let Outcome::Fail(refused) = &closed {
            worker::console_error!("security: #{number} of {} not closed: {}", repo.repo_id, refused.message);
        }
        Ok(matches!(closed, Outcome::Ok(_)))
    }

    /// Records `action` on every open alert of an update's package.
    async fn note(&self, row: &UpdateRow, action: &str, actor: Option<&str>, number: Option<u32>, comment: Option<&str>) -> Result<()> {
        let ids = self.store.open_ids(&row.repo_id, &row.ecosystem, &row.package).await?;
        let activity: Vec<Activity> = ids
            .iter()
            .map(|id| Activity { alert_id: id, action, actor, reason: None, comment, number })
            .collect();
        self.store.record(&row.repo_id, &activity).await
    }

    /// After a dependency scan: asks for an update for each vulnerable
    /// package with a fix (when `enabled`). Those no longer needed were
    /// closed already (`resolved`).
    ///
    /// The dependency update file, when there is one, applies as it does to
    /// version updates: `ignore` and `allow` by name, people's `@g1t ignore`
    /// comments, `groups` with `applies-to: security-updates` (one pull
    /// request for each group), and `assignees`, `reviewers` and
    /// `commit-message`. `open-pull-requests-limit` does not apply.
    pub async fn security_updates(&self, repo: &RepoRow, enabled: bool, rules: Option<&Loaded>) -> Result<()> {
        let open = self.store.open_vulnerabilities(&repo.repo_id).await?;
        let mut by_package: BTreeMap<(String, String), Vec<&VulnRow>> = BTreeMap::new();
        for vuln in &open {
            by_package.entry((vuln.ecosystem.clone(), vuln.package.clone())).or_default().push(vuln);
        }
        if !enabled {
            return Ok(());
        }
        let mut groups: Vec<((String, String), Vec<&VulnRow>)> = by_package
            .into_iter()
            .filter(|(_, vulns)| vulns.iter().any(|vuln| vuln.fixed_version.is_some()))
            .collect();
        groups.sort_by_key(|(_, vulns)| std::cmp::Reverse(vulns.iter().map(|v| Severity::parse(&v.severity)).max()));
        let retry_after = rfc3339(now_ms().saturating_sub(RETRY_FAILED_MS));
        let comments = self.store.ignores(&repo.repo_id).await?;
        let mut grouped: BTreeMap<(String, String), Vec<GroupMember>> = BTreeMap::new();
        let mut asked = 0;
        for ((ecosystem, package), vulns) in groups {
            if asked >= MAX_NEW_UPDATES {
                break;
            }
            let Some(target) = osv::upgrade_target(vulns.iter().filter_map(|v| v.fixed_version.as_deref())) else {
                continue;
            };
            let manifests: Vec<&str> = vulns.iter().map(|vuln| vuln.manifest.as_str()).collect();
            if let Some(entry) = rules.and_then(|loaded| security_entry(&loaded.config, &loaded.default_branch, &ecosystem, &manifests)) {
                if !security_allowed(entry, &comments, &package, &target) {
                    continue;
                }
                let from = lowest(&vulns);
                if let Some(group) = security_group(entry, &package, &from, &target) {
                    let key = (entry.id(), group);
                    if !grouped.contains_key(&key) {
                        asked += 1;
                    }
                    let manifests = manifests.iter().map(|path| (*path).to_owned()).collect();
                    grouped.entry(key).or_default().push(GroupMember { ecosystem: ecosystem.clone(), package: package.clone(), from, target, manifests });
                    continue;
                }
            }
            match self.store.update(&repo.repo_id, &ecosystem, &package).await? {
                Some(row) => {
                    if next_step(row.state(), &row.target, &target, &row.updated_at, &retry_after) == Next::Wait {
                        continue;
                    }
                }
                None => {
                    // An upgrade issue from before security updates, still
                    // open, is left to the agent on it.
                    if let Some(existing) = self.store.upgrade(&repo.repo_id, &ecosystem, &package).await?
                        && self
                            .issue(&User::system(&repo.namespace), &Self::path_of(repo), existing.number as u32)
                            .await?
                            .is_some_and(|issue| issue.state == g1t_contracts::work::State::Open)
                    {
                        continue;
                    }
                }
            }
            asked += 1;
            self.request(repo, &ecosystem, &package, &target, &vulns).await?;
        }
        for ((entry_id, group), members) in grouped {
            let Some(loaded) = rules else { continue };
            let Some(entry) = loaded.config.updates.iter().find(|entry| entry.id() == entry_id) else { continue };
            self.request_group(repo, loaded, entry, &group, members, &open).await?;
        }
        Ok(())
    }

    /// Asks for one pull request for a `security-updates` group's
    /// packages, unless one for the same versions is under way or was
    /// closed.
    async fn request_group(&self, repo: &RepoRow, loaded: &Loaded, entry: &Entry, group: &str, members: Vec<GroupMember>, open: &[VulnRow]) -> Result<()> {
        let subject = format!("security:{group}");
        let mut signature: Vec<String> = members.iter().map(|m| format!("{}@{}", m.package, m.target)).collect();
        signature.sort();
        let signature = signature.join(",");
        let existing = self.store.update_pulls(&repo.repo_id).await?;
        let known = |row: &&crate::update_store::PullRow| row.kind == "security" && row.subject == subject && row.signature == signature;
        if existing.iter().filter(known).any(|row| row.state().in_progress() || row.state() == UpdateState::Closed) {
            return Ok(());
        }
        let branch = format!("{UPDATE_BRANCH_PREFIX}{}-{}", group.to_lowercase().replace('|', "-"), pull_text::digest(&signature));
        let vulns: Vec<&VulnRow> = open.iter().filter(|vuln| members.iter().any(|m| m.ecosystem == vuln.ecosystem && m.package == vuln.package)).collect();
        let count = if members.len() == 1 { "1 security update".to_owned() } else { format!("{} security updates", members.len()) };
        let title = prefixed(&pull_text::prefix(entry.commit_message.as_ref(), false), format!("Bump the {group} group with {count}"));
        let body = group_text(group, &members, &vulns, &loaded.file);
        let mut lockfiles: Vec<String> = members.iter().flat_map(|m| m.manifests.clone()).collect();
        lockfiles.sort();
        lockfiles.dedup();
        let packages: Vec<BumpPackage> = members.iter().map(|m| BumpPackage { package: m.package.clone(), version: m.target.clone() }).collect();
        let bump = BumpArgs {
            repo: Self::path_of(repo),
            ecosystem: members[0].ecosystem.clone(),
            package: packages[0].package.clone(),
            version: packages[0].version.clone(),
            lockfiles,
            branch: branch.clone(),
            message: title.clone(),
            kind: None,
            packages,
            strategy: None,
            force: existing.iter().any(|row| row.branch == branch && row.state().in_progress()),
            registries: Vec::new(),
            base: None,
        };
        let dependencies: Vec<UpdatedDependency> = members
            .iter()
            .map(|m| UpdatedDependency {
                name: m.package.clone(),
                from: m.from.clone(),
                to: m.target.clone(),
                directory: m.manifests.first().map(|path| format!("/{}", path.rsplit_once('/').map_or("", |(dir, _)| dir))).unwrap_or_else(|| "/".to_owned()),
                dependency_type: String::new(),
                update_type: ranges::update_type(&m.from, &m.target),
            })
            .collect();
        let people = |names: &[String]| -> Vec<String> { names.iter().filter(|name| !name.contains('/')).cloned().collect() };
        let id = self
            .store
            .add_update_pull(&NewPull {
                repo_id: &repo.repo_id,
                kind: "security",
                entry: &entry.id(),
                ecosystem: &entry.ecosystem,
                subject: &subject,
                signature: &signature,
                group: Some(group),
                branch: &branch,
                title: &title,
                body: &body,
                dependencies: &dependencies,
                bump: &bump,
                assignees: &people(&entry.assignees),
                reviewers: &people(&entry.reviewers),
            })
            .await?;
        for member in &members {
            self.store.request_update(&repo.repo_id, &member.ecosystem, &member.package, &member.target, &branch).await?;
        }
        let started: std::result::Result<(), String> = match g1t_kit::call::<_, Outcome<bool>>(&self.runner, "bump", &bump).await {
            Ok(Outcome::Ok(_)) => Ok(()),
            Ok(Outcome::Fail(refused)) => Err(refused.message),
            Err(error) => Err(format!("the runner could not be reached: {error}")),
        };
        for member in &members {
            let Some(row) = self.store.update(&repo.repo_id, &member.ecosystem, &member.package).await? else { continue };
            match &started {
                Ok(()) => self.note(&row, "update_requested", Some(g1t_contracts::system::USERNAME), None, None).await?,
                Err(reason) => {
                    let error = format!("g1t could not start the security update: {reason}");
                    self.store.set_update(&row, UpdateState::Failed, row.pull(), None, Some(&error)).await?;
                    self.note(&row, "update_failed", Some(g1t_contracts::system::USERNAME), None, Some(&error)).await?;
                }
            }
        }
        if let Err(reason) = started {
            self.store.set_update_pull(&id, UpdateState::Failed, None, None, Some(&format!("g1t could not start the security update: {reason}"))).await?;
        }
        Ok(())
    }

    /// Asks the runner to make the change on its branch.
    async fn request(&self, repo: &RepoRow, ecosystem: &str, package: &str, target: &str, vulns: &[&VulnRow]) -> Result<()> {
        let branch = update_branch(package, target);
        let mut lockfiles: Vec<String> = vulns.iter().map(|vuln| vuln.manifest.clone()).collect();
        lockfiles.sort();
        lockfiles.dedup();
        let args = BumpArgs {
            repo: Self::path_of(repo),
            ecosystem: ecosystem.to_owned(),
            package: package.to_owned(),
            version: target.to_owned(),
            lockfiles,
            branch: branch.clone(),
            message: format!("Upgrade {package} to {target}"),
            kind: None,
            packages: Vec::new(),
            strategy: None,
            force: false,
            registries: Vec::new(),
            base: None,
        };
        let started: std::result::Result<(), String> = match g1t_kit::call::<_, Outcome<bool>>(&self.runner, "bump", &args).await {
            Ok(Outcome::Ok(_)) => Ok(()),
            Ok(Outcome::Fail(refused)) => Err(refused.message),
            Err(error) => Err(format!("the runner could not be reached: {error}")),
        };
        self.store.request_update(&repo.repo_id, ecosystem, package, target, &branch).await?;
        let Some(row) = self.store.update(&repo.repo_id, ecosystem, package).await? else {
            return Ok(());
        };
        match started {
            Ok(()) => self.note(&row, "update_requested", Some(g1t_contracts::system::USERNAME), None, None).await,
            Err(reason) => {
                let error = format!("g1t could not start the security update: {reason}");
                self.store.set_update(&row, UpdateState::Failed, row.pull(), None, Some(&error)).await?;
                self.note(&row, "update_failed", Some(g1t_contracts::system::USERNAME), None, Some(&error)).await
            }
        }
    }

    /// A security update's branch was pushed: its pull request opens, and
    /// an older one for the same package is closed as superseded.
    pub async fn update_pushed(&self, repo_id: &str, branch: &str, after: &str) -> Result<()> {
        let Some(row) = self.store.update_by_branch(repo_id, branch).await? else {
            return Ok(());
        };
        if row.state() == UpdateState::Superseded && row.pull().is_none() {
            // No longer needed by the time its sandbox pushed: the branch goes.
            return self.drop_pushed(repo_id, branch, after).await;
        }
        if row.state() != UpdateState::Requested {
            return Ok(());
        }
        let Some(repo) = self.store.repo(repo_id).await? else {
            return Ok(());
        };
        let open = self.store.open_vulnerabilities(repo_id).await?;
        let vulns: Vec<&VulnRow> = open
            .iter()
            .filter(|vuln| vuln.ecosystem == row.ecosystem && vuln.package == row.package)
            .collect();
        let system = User::system(&repo.namespace);
        // What the dependency update file says for this package's directory.
        let state = repo.version_updates();
        let manifests: Vec<&str> = vulns.iter().map(|vuln| vuln.manifest.as_str()).collect();
        let settings = security_settings(&state, &row.ecosystem, &manifests);
        let prefix = settings.map(|entry| pull_text::prefix(commit_message_of(entry).as_ref(), false)).unwrap_or_default();
        let opened: Outcome<Pull> = g1t_kit::call(
            &self.work,
            "open_pull",
            &OpenPullArgs {
                actor: system.clone(),
                repo: Self::path_of(&repo),
                issue: None,
                title: prefixed(&prefix, pull_title(&row.package, &row.target)),
                body: pull_text(&row.ecosystem, &row.package, &row.target, &vulns),
                branch: Some(branch.to_owned()),
                agent: String::new(),
                runtime: Runtime::External,
                // Security updates are for the default branch.
                base: None,
            },
        )
        .await?;
        let pull = match opened {
            Outcome::Ok(pull) => pull,
            Outcome::Fail(refused) => {
                let error = format!("The pull request could not be opened: {}", refused.message);
                self.store.set_update(&row, UpdateState::Failed, row.pull(), None, Some(&error)).await?;
                return self.note(&row, "update_failed", Some(g1t_contracts::system::USERNAME), None, Some(&error)).await;
            }
        };
        if let Some(older) = row.pull().filter(|older| *older != pull.number)
            && let Some(found) = self.get_pull(&repo, older).await?
            && matches!(found.status, PullStatus::Open | PullStatus::Draft)
            && self
                .close_with(&repo, older, format!("Closed: superseded by #{}, which upgrades `{}` to {}.", pull.number, row.package, row.target))
                .await?
            && found.branch.as_deref() != Some(branch)
        {
            self.delete_pull_branch(&repo, &Pull { status: PullStatus::Closed, ..found }).await;
        }
        self.store.set_update(&row, UpdateState::Open, Some(pull.number), None, None).await?;
        // Labelled as the entry for its directory says, or `dependencies`
        // and its ecosystem's label; assigned and in a milestone as it says.
        let ecosystem = package_ecosystem(&row.ecosystem).unwrap_or(row.ecosystem.as_str());
        let labels = crate::config::update_labels(settings.and_then(|entry| entry.labels.as_deref()), ecosystem);
        let people = |names: &[String]| -> Vec<String> { names.iter().filter(|name| !name.contains('/')).cloned().collect() };
        let (assignees, reviewers) = settings.map(|entry| (people(&entry.assignees), people(&entry.reviewers))).unwrap_or_default();
        if !assignees.is_empty() || !reviewers.is_empty() || !labels.is_empty() {
            let _: Outcome<Value> = g1t_kit::call(
                &self.work,
                "update_pull",
                &UpdatePullArgs {
                    actor: system.clone(),
                    repo: Self::path_of(&repo),
                    number: pull.number,
                    assignees: (!assignees.is_empty()).then_some(assignees),
                    reviewers: (!reviewers.is_empty()).then_some(reviewers),
                    labels: (!labels.is_empty()).then_some(labels),
                    milestone: None,
                    base: None,
                },
            )
            .await?;
        }
        if let Some(milestone) = settings.and_then(|entry| entry.milestone) {
            let _: Outcome<Value> = g1t_kit::call(
                &self.work,
                "update_pull",
                &UpdatePullArgs {
                    actor: system,
                    repo: Self::path_of(&repo),
                    number: pull.number,
                    assignees: None,
                    reviewers: None,
                    labels: None,
                    milestone: Some(milestone),
                    base: None,
                },
            )
            .await?;
        }
        self.note(&row, "update_opened", Some(g1t_contracts::system::USERNAME), Some(pull.number), None).await
    }

    /// A pull request merged, closed or checked: if it is a security
    /// update's, where the update stands now.
    pub async fn update_pull_event(&self, kind: &str, repo_id: &str, number: u32, status: Option<&str>, actor: Option<&str>) -> Result<()> {
        let Some(row) = self.store.update_by_pull(repo_id, number).await? else {
            return Ok(());
        };
        if row.state() != UpdateState::Open {
            return Ok(());
        }
        match kind {
            "pull.merged" => {
                self.store.set_update(&row, UpdateState::Merged, Some(number), None, None).await?;
                self.note(&row, "update_merged", actor, Some(number), None).await
            }
            "pull.closed" => {
                self.store.set_update(&row, UpdateState::Closed, Some(number), None, None).await?;
                self.note(&row, "update_closed", actor, Some(number), None).await
            }
            "checks.completed" if status == Some("failed") => {
                let Some(repo) = self.store.repo(repo_id).await? else {
                    return Ok(());
                };
                self.needs_code(&repo, &row, "Raising the version alone fails this branch's required checks").await
            }
            _ => Ok(()),
        }
    }

    /// Closes an update that is no longer needed: its pull request, if it
    /// has one still open (one that merged meanwhile is recorded merged).
    async fn supersede(&self, repo: &RepoRow, row: &UpdateRow, why: String) -> Result<()> {
        if let Some(number) = row.pull() {
            match self.get_pull(repo, number).await? {
                Some(pull) if pull.status == PullStatus::Merged => {
                    return self.store.set_update(row, UpdateState::Merged, Some(number), row.issue(), None).await;
                }
                Some(pull) if matches!(pull.status, PullStatus::Open | PullStatus::Draft) => {
                    self.store.set_update(row, UpdateState::Superseded, Some(number), row.issue(), None).await?;
                    self.close_with(repo, number, why).await?;
                    return self.note(row, "update_superseded", Some(g1t_contracts::system::USERNAME), Some(number), None).await;
                }
                _ => {}
            }
        }
        self.store.set_update(row, UpdateState::Superseded, row.pull(), row.issue(), None).await
    }

    /// Updates whose sandbox never pushed: raising the version did not
    /// work, so g1t gets an issue for it.
    pub async fn stalled_updates(&self) -> Result<()> {
        let before = rfc3339(now_ms().saturating_sub(STALLED_MS));
        for row in self.store.stalled_updates(&before, 10).await? {
            let Some(repo) = self.store.repo(&row.repo_id).await? else { continue };
            if repo.upkeep == 0 || !self.active(&repo.repo_id).await? {
                self.store
                    .set_update(&row, UpdateState::Failed, row.pull(), None, Some("The version could not be raised in a sandbox."))
                    .await?;
                continue;
            }
            self.needs_code(&repo, &row, "The version could not be raised in a sandbox on its own").await?;
        }
        Ok(())
    }

    /// Raising the version is not enough: closes g1t's pull request, opens
    /// an issue for the change, and puts g1t to work on it.
    async fn needs_code(&self, repo: &RepoRow, row: &UpdateRow, why: &str) -> Result<()> {
        let path = Self::path_of(repo);
        let system = User::system(&repo.namespace);
        let open = self.store.open_vulnerabilities(&repo.repo_id).await?;
        let vulns: Vec<&VulnRow> = open
            .iter()
            .filter(|vuln| vuln.ecosystem == row.ecosystem && vuln.package == row.package)
            .collect();
        if vulns.is_empty() {
            return self.supersede(repo, row, format!("`{}` is no longer vulnerable here.", row.package)).await;
        }
        let issue: Outcome<g1t_contracts::work::Issue> = g1t_kit::call(
            &self.work,
            "open_issue",
            &OpenIssueArgs {
                actor: system.clone(),
                repo: path.clone(),
                title: format!("Upgrade {} to {}: needs code changes", row.package, row.target).chars().take(200).collect(),
                body: issue_text(&row.ecosystem, &row.package, &row.target, &vulns, &[]),
                labels: vec!["dependencies".to_owned(), "security".to_owned()],
                checks: Vec::new(),
                milestone: None,
            },
        )
        .await?;
        let issue = match issue {
            Outcome::Ok(issue) => issue,
            Outcome::Fail(refused) => {
                let error = format!("{why}, and the issue for it could not be opened: {}", refused.message);
                self.store.set_update(row, UpdateState::Failed, row.pull(), None, Some(&error)).await?;
                return self.note(row, "update_failed", Some(g1t_contracts::system::USERNAME), None, Some(&error)).await;
            }
        };
        self.store
            .set_update(row, UpdateState::NeedsCode, row.pull(), Some(issue.number), Some(why))
            .await?;
        if let Some(number) = row.pull() {
            self.close_with(repo, number, format!("{why}, so code has to change too. g1t is making the change in #{}.", issue.number))
                .await?;
        }
        let started: Outcome<Value> =
            g1t_kit::call(&self.runner, "run", &json!({ "actor": system, "repo": path, "issue": issue.number })).await?;
        if let Outcome::Fail(refused) = started {
            self.comment(&system, &path, issue.number, format!(
                "g1t could not put an agent on this upgrade: {}\n\nAssign it to g1t once agents can run here, or upgrade it by hand.",
                refused.message
            ))
            .await?;
        }
        self.note(row, "update_needs_code", Some(g1t_contracts::system::USERNAME), Some(issue.number), Some(why)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(extra: &str) -> Config {
        let source = format!(
            "version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: [\"/\", \"/apps/*\"]\n    schedule: {{interval: weekly}}\n{extra}  - package-ecosystem: npm\n    directory: /legacy\n    target-branch: develop\n    schedule: {{interval: weekly}}\n"
        );
        let found = crate::config::read(&source);
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        found.config
    }

    #[test]
    fn security_updates_follow_the_file() {
        let config = rules(
            "    ignore:\n      - dependency-name: left-pad\n      - dependency-name: react\n        versions: [\">=19\"]\n    groups:\n      fixes:\n        applies-to: security-updates\n        patterns: [\"@babel/*\"]\n        update-types: [patch, minor]\n      minor:\n        patterns: [\"*\"]\n",
        );
        let entry = security_entry(&config, "main", "npm", &["apps/web/package-lock.json"]).unwrap();
        assert_eq!(entry.id(), "npm:/,/apps/*");
        // An entry for another branch never speaks for security updates.
        assert!(security_entry(&config, "main", "npm", &["legacy/package-lock.json"]).is_none());
        assert!(security_entry(&config, "main", "crates.io", &["Cargo.lock"]).is_none());
        assert!(!security_allowed(entry, &[], "left-pad", "1.3.0"));
        assert!(!security_allowed(entry, &[], "react", "19.0.1"));
        assert!(security_allowed(entry, &[], "react", "18.3.1"));
        let comment = IgnoreCondition { ecosystem: "npm".into(), dependency: "Lodash".into(), versions: None, update_type: None, by: "ana".into(), pull: None, at: String::new() };
        assert!(!security_allowed(entry, &[comment], "lodash", "4.17.21"));
        assert_eq!(security_group(entry, "@babel/core", "7.0.0", "7.24.1").as_deref(), Some("fixes"));
        // A major bump is outside the group's update types, and only security groups count.
        assert_eq!(security_group(entry, "@babel/core", "6.0.0", "7.24.1"), None);
        assert_eq!(security_group(entry, "lodash", "4.17.20", "4.17.21"), None);
        let named = rules("    allow:\n      - dependency-name: \"lodash\"\n");
        let entry = security_entry(&named, "main", "npm", &["package-lock.json"]).unwrap();
        assert!(security_allowed(entry, &[], "lodash", "4.17.21") && !security_allowed(entry, &[], "minimist", "1.2.6"));
    }

    #[test]
    fn grouped_security_updates_say_what_they_fix() {
        let vuln = row("4.17.20", "4.17.21");
        let members = vec![GroupMember { ecosystem: "npm".into(), package: "lodash".into(), from: "4.17.20".into(), target: "4.17.21".into(), manifests: vec!["package-lock.json".into()] }];
        let body = group_text("fixes", &members, &[&vuln], ".github/dependabot.yml");
        assert!(body.starts_with("Upgrades the fixes group's vulnerable packages"));
        assert!(body.contains("| `lodash` | 4.17.20 | **4.17.21** |"));
        assert!(body.contains("GHSA-35jh-r3h4-6jhm") && body.contains("`@g1t rebase`"));
        assert!(body.ends_with("on its Security page._"));
        assert_eq!(prefixed("build(deps): ", "Upgrade lodash to 4.17.21".into()), "build(deps): upgrade lodash to 4.17.21");
        assert_eq!(prefixed("", "Upgrade lodash to 4.17.21".into()), "Upgrade lodash to 4.17.21");
    }

    fn row(version: &str, fixed: &str) -> VulnRow {
        VulnRow {
            id: "vul_1".into(),
            repo_id: "rep_1".into(),
            ecosystem: "npm".into(),
            package: "lodash".into(),
            version: version.into(),
            manifest: "web/package-lock.json".into(),
            osv_id: "GHSA-35jh-r3h4-6jhm".into(),
            advisory: "GHSA-35jh-r3h4-6jhm".into(),
            summary: "Command Injection in lodash".into(),
            severity: "high".into(),
            fixed_version: Some(fixed.into()),
            status: "open".into(),
            found_at: "2026-10-04T00:00:00Z".into(),
            fixed_at: None,
            number: None,
            dismiss_reason: None,
            dismiss_comment: None,
            dismissed_by: None,
            dismissed_at: None,
        }
    }

    #[test]
    fn a_newer_fix_asks_again_and_the_same_one_waits() {
        let retry = "2026-10-05T00:00:00Z";
        let at = "2026-10-06T00:00:00Z";
        assert_eq!(next_step(UpdateState::Open, "4.17.20", "4.17.21", at, retry), Next::Request);
        assert_eq!(next_step(UpdateState::Open, "4.17.21", "4.17.21", at, retry), Next::Wait);
        assert_eq!(next_step(UpdateState::Requested, "4.17.21", "4.17.21", at, retry), Next::Wait);
        assert_eq!(next_step(UpdateState::Merged, "4.17.21", "4.17.21", at, retry), Next::Wait);
        // A person closed it: left alone until a newer fix.
        assert_eq!(next_step(UpdateState::Closed, "4.17.21", "4.17.21", at, retry), Next::Wait);
        assert_eq!(next_step(UpdateState::Closed, "4.17.21", "4.17.22", at, retry), Next::Request);
        // Vulnerable again after it was no longer needed.
        assert_eq!(next_step(UpdateState::Superseded, "4.17.21", "4.17.21", at, retry), Next::Request);
        // Failed: tried again a day later.
        assert_eq!(next_step(UpdateState::Failed, "4.17.21", "4.17.21", at, retry), Next::Wait);
        assert_eq!(next_step(UpdateState::Failed, "4.17.21", "4.17.21", "2026-10-04T00:00:00Z", retry), Next::Request);
        assert_eq!(next_step(UpdateState::NeedsCode, "4.17.21", "4.17.21", at, retry), Next::Wait);
    }

    #[test]
    fn the_pull_request_says_what_it_fixes_and_where() {
        let a = row("4.17.20", "4.17.21");
        let mut b = row("4.17.19", "4.17.21");
        b.manifest = "package-lock.json".into();
        let body = pull_text("npm", "lodash", "4.17.21", &[&a, &b]);
        assert!(body.starts_with("Upgrades `lodash` (npm) from 4.17.19, 4.17.20 to **4.17.21**"));
        assert!(body.contains("[GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm)"));
        assert!(body.contains("Lockfiles changed: `package-lock.json`, `web/package-lock.json`."));
        assert!(body.contains("required checks"));
        assert_eq!(pull_title("lodash", "4.17.21"), "Upgrade lodash to 4.17.21");
        assert_eq!(update_branch("@babel/core", "7.24.1"), "g1t/security/babel-core-7.24.1");
        assert_eq!(update_branch("golang.org/x/net", "v0.23.0"), "g1t/security/golang.org-x-net-v0.23.0");
    }
}
