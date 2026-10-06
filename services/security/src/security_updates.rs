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
//! 4. A package no longer vulnerable closes its update as superseded.
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

use crate::Security;
use crate::deps::{advisory_table, issue_text};
use crate::store::{Activity, RepoRow, UpdateRow, VulnRow};

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

impl Security {
    fn path_of(repo: &RepoRow) -> RepoPath {
        RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() }
    }

    async fn get_pull(&self, repo: &RepoRow, number: u32) -> Result<Option<Pull>> {
        let found: Outcome<PullDetail> = g1t_kit::call(
            &self.work,
            "get_pull",
            &ViewArgs { repo: Self::path_of(repo), number, viewer: Some(User::system(&repo.namespace)), after_seq: 0 },
        )
        .await?;
        Ok(found.into_result().ok().map(|detail| detail.pull))
    }

    /// Closes one of g1t's pull requests, saying why first.
    async fn close_with(&self, repo: &RepoRow, number: u32, why: String) -> Result<()> {
        let system = User::system(&repo.namespace);
        self.comment(&system, &Self::path_of(repo), number, why).await?;
        let _: Outcome<Value> = g1t_kit::call(
            &self.work,
            "close_pull",
            &PullActionArgs {
                actor: system,
                repo: Self::path_of(repo),
                number,
                summary: String::new(),
                keep_issue_open: false,
                ignore_checks: false,
            },
        )
        .await?;
        Ok(())
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
    /// package with a fix (when `enabled`), and supersedes those whose
    /// package is no longer vulnerable.
    pub async fn security_updates(&self, repo: &RepoRow, enabled: bool) -> Result<()> {
        let open = self.store.open_vulnerabilities(&repo.repo_id).await?;
        let mut by_package: BTreeMap<(String, String), Vec<&VulnRow>> = BTreeMap::new();
        for vuln in &open {
            by_package.entry((vuln.ecosystem.clone(), vuln.package.clone())).or_default().push(vuln);
        }
        // In flight for a package that is no longer vulnerable: no longer needed.
        for row in self.store.updates(&repo.repo_id).await? {
            if !row.state().in_progress() || by_package.contains_key(&(row.ecosystem.clone(), row.package.clone())) {
                continue;
            }
            self.supersede(repo, &row, format!("`{}` is no longer vulnerable here, so this is no longer needed.", row.package))
                .await?;
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
        let mut asked = 0;
        for ((ecosystem, package), vulns) in groups {
            if asked >= MAX_NEW_UPDATES {
                break;
            }
            let Some(target) = osv::upgrade_target(vulns.iter().filter_map(|v| v.fixed_version.as_deref())) else {
                continue;
            };
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
    pub async fn update_pushed(&self, repo_id: &str, branch: &str) -> Result<()> {
        let Some(row) = self.store.update_by_branch(repo_id, branch).await? else {
            return Ok(());
        };
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
        let opened: Outcome<Pull> = g1t_kit::call(
            &self.work,
            "open_pull",
            &OpenPullArgs {
                actor: system,
                repo: Self::path_of(&repo),
                issue: None,
                title: pull_title(&row.package, &row.target),
                body: pull_text(&row.ecosystem, &row.package, &row.target, &vulns),
                branch: Some(branch.to_owned()),
                agent: String::new(),
                runtime: Runtime::External,
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
        if let Some(older) = row.pull().filter(|older| *older != pull.number) {
            self.close_with(&repo, older, format!("Superseded by #{}, which upgrades `{}` to {}.", pull.number, row.package, row.target))
                .await?;
        }
        self.store.set_update(&row, UpdateState::Open, Some(pull.number), None, None).await?;
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
