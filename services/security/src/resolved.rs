//! Update pull requests that are no longer needed, and the branches g1t
//! leaves behind.
//!
//! After every dependency scan of the default branch, and when someone
//! dismisses an alert, g1t looks at its own open update pull requests:
//!
//! - A security update (one package, or a `security-updates` group) is
//!   closed once none of the alerts it fixes is open: each was fixed on the
//!   default branch (its vulnerable version left the lockfiles) or
//!   dismissed. An alert counts as one the update fixes when it is on the
//!   update's package at a version below the update's target.
//! - A version update into the default branch is closed once every
//!   dependency it raises is already at its new version or later in the
//!   lockfiles, or is no longer a dependency.
//!
//! g1t comments why, closes the pull request and deletes its branch. The
//! update is recorded as superseded, so a later scan asks for a new one
//! only when one of its packages is vulnerable again.
//!
//! Branches: when one of these pull requests closes or merges, by g1t or
//! by a person, its branch is deleted, and each scan removes those still
//! left from update pull requests already closed. Only a branch g1t made
//! for an update, with no update in progress on it, still at the commit its
//! pull request last had, is deleted.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::repos::{Branch, BranchesArgs, DeleteBranchArgs};
use g1t_contracts::security::UpdateState;
use g1t_contracts::updates::UpdatedDependency;
use g1t_contracts::work::{Pull, PullStatus};
use g1t_contracts::{Outcome, User};
use g1t_scan::version;
use worker::Result;

use crate::Security;
use crate::deps::Located;
use crate::store::{Activity, RepoRow, VulnRow};
use crate::version_updates::{lockfiles_for, normalize, osv_ecosystem};

/// Branches of closed update pull requests removed per scan, at most.
const BRANCHES_PER_SCAN: usize = 10;

/// The alerts an update to `target` fixes: those on `package` at a lower
/// version, whatever their state now.
pub fn targeted<'a>(alerts: &'a [VulnRow], ecosystem: &str, package: &str, target: &str) -> Vec<&'a VulnRow> {
    alerts
        .iter()
        .filter(|alert| alert.ecosystem == ecosystem && alert.package == package && version::compare(&alert.version, target).is_lt())
        .collect()
}

/// Whether one of the alerts an update fixes is still open.
pub fn still_needed(targeted: &[&VulnRow]) -> bool {
    targeted.iter().any(|alert| alert.status == "open")
}

fn join(items: &[String], last: &str) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., end] => format!("{} {last} {end}", rest.join(", ")),
    }
}

/// The comment g1t closes a security update with once none of the alerts
/// it fixes is open. `packages` names the update's packages, for when no
/// alert is left to name.
pub fn resolved_text(base: &str, packages: &[String], targeted: &[&VulnRow]) -> String {
    let fixed: Vec<&&VulnRow> = targeted.iter().filter(|alert| alert.status == "fixed").collect();
    let dismissed = targeted.iter().any(|alert| alert.status == "dismissed");
    let advisories: BTreeSet<&str> = targeted.iter().map(|alert| alert.osv_id.as_str()).collect();
    let (one, plural) = (advisories.len() <= 1, advisories.len() > 1);
    let subject = if one { "the alert this fixed" } else { "the alerts this fixed" };
    if fixed.is_empty() && !dismissed {
        let names: Vec<String> = packages.iter().map(|name| format!("`{name}`")).collect();
        return format!(
            "Closed: {} no longer vulnerable on `{base}`, so this update is no longer needed.",
            if names.len() == 1 { format!("{} is", names[0]) } else { format!("{} are", join(&names, "and")) }
        );
    }
    if fixed.is_empty() {
        return format!("Closed: {subject} {} dismissed, so this update is no longer needed.", if plural { "were" } else { "was" });
    }
    // Each package with the vulnerable versions that left, and where from.
    let mut versions: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut lockfiles: BTreeSet<&str> = BTreeSet::new();
    for alert in &fixed {
        versions.entry(alert.package.as_str()).or_default().insert(alert.version.as_str());
        lockfiles.insert(alert.manifest.as_str());
    }
    let count: usize = versions.values().map(BTreeSet::len).sum();
    let named: Vec<String> = versions
        .iter()
        .map(|(package, found)| {
            let found: Vec<String> = found.iter().map(|v| (*v).to_owned()).collect();
            format!("`{package}` {}", join(&found, "and"))
        })
        .collect();
    let files: Vec<String> = lockfiles.iter().map(|path| format!("`{path}`")).collect();
    format!(
        "Closed: {subject} {} resolved on `{base}`{} ({} {} no longer in {}).",
        if one { "is" } else { "are" },
        if dismissed { " or dismissed" } else { "" },
        join(&named, "and"),
        if count == 1 { "is" } else { "are" },
        join(&files, "or"),
    )
}

/// Where a dependency a version update raises stands on the default branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Now {
    /// The highest version its lockfiles resolve.
    At(String),
    /// Its lockfiles no longer have it.
    Gone,
    /// No lockfile for its directory could be read: nothing is decided.
    Unknown,
}

/// Where `dependency` stands in the lockfiles a scan read.
pub fn now_of(ecosystem: &str, dependency: &UpdatedDependency, located: &[Located], paths: &[String]) -> Now {
    let lockfiles = lockfiles_for(ecosystem, &dependency.directory, paths);
    let read: Vec<&Located> = located.iter().filter(|item| lockfiles.contains(&item.path)).collect();
    if read.is_empty() {
        return Now::Unknown;
    }
    let name = normalize(ecosystem, &dependency.name);
    read.iter()
        .filter(|item| normalize(ecosystem, &item.package.name) == name)
        .map(|item| item.package.version.clone())
        .max_by(|a, b| version::compare(a, b))
        .map_or(Now::Gone, Now::At)
}

/// The comment g1t closes a version update with when every dependency it
/// raises is already there, or `None` while one still needs it.
pub fn version_resolved_text(base: &str, dependencies: &[(UpdatedDependency, Now)]) -> Option<String> {
    if dependencies.is_empty() {
        return None;
    }
    for (dependency, now) in dependencies {
        match now {
            Now::Unknown => return None,
            Now::At(current) if version::compare(current, &dependency.to).is_lt() => return None,
            _ => {}
        }
    }
    if let [(dependency, now)] = dependencies {
        return Some(match now {
            Now::At(current) => format!(
                "Closed: `{}` is already at {current} on `{base}`, so this update to {} is no longer needed.",
                dependency.name, dependency.to
            ),
            _ => format!("Closed: `{}` is no longer a dependency on `{base}`, so this update is no longer needed.", dependency.name),
        });
    }
    let each: Vec<String> = dependencies
        .iter()
        .map(|(dependency, now)| match now {
            Now::At(current) => format!("`{}` is at {current}", dependency.name),
            _ => format!("`{}` is no longer a dependency", dependency.name),
        })
        .collect();
    Some(format!(
        "Closed: every dependency this updates is already at its new version or later on `{base}` ({}), so this update is no longer needed.",
        join(&each, "and")
    ))
}

/// The closing comment, given the pull request's base branch.
type Why<'a> = Box<dyn FnOnce(&str) -> String + 'a>;

/// What closing a no longer needed update pull request found.
#[derive(Debug, PartialEq, Eq)]
pub enum Retired {
    /// It was open: g1t commented, closed it and deleted its branch.
    Closed,
    /// It merged meanwhile.
    Merged,
    /// Already closed, or not found.
    Left,
}

impl Security {
    /// Closes one of g1t's update pull requests that is no longer needed,
    /// with the comment `why` gives for its base branch, and deletes its
    /// branch.
    pub(crate) async fn retire(&self, repo: &RepoRow, number: u32, why: impl FnOnce(&str) -> String) -> Result<Retired> {
        let Some(pull) = self.get_pull(repo, number).await? else { return Ok(Retired::Left) };
        match pull.status {
            PullStatus::Merged => Ok(Retired::Merged),
            PullStatus::Closed => Ok(Retired::Left),
            PullStatus::Open | PullStatus::Draft => {
                let base = pull.base.clone().unwrap_or_else(|| "the default branch".to_owned());
                if self.close_with(repo, number, why(&base)).await? {
                    let closed = Pull { status: PullStatus::Closed, ..pull };
                    self.delete_pull_branch(repo, &closed).await;
                }
                Ok(Retired::Closed)
            }
        }
    }

    /// Deletes a closed or merged update pull request's branch, if it is
    /// still at the pull request's last commit. Failures are logged: a
    /// branch left behind is removed by a later scan.
    pub(crate) async fn delete_pull_branch(&self, repo: &RepoRow, pull: &Pull) {
        if matches!(pull.status, PullStatus::Open | PullStatus::Draft) || pull.fork.is_some() || pull.fork_repo_id.is_some() {
            return;
        }
        let (Some(branch), Some(head)) = (pull.branch.clone(), pull.head_commit.clone()) else { return };
        if pull.base.as_deref() == Some(branch.as_str()) {
            return;
        }
        let deleted: Result<Outcome<bool>> =
            g1t_kit::call(&self.repos, "delete_branch", &DeleteBranchArgs { repo_id: repo.repo_id.clone(), branch: branch.clone(), head: Some(head) }).await;
        match deleted {
            Ok(Outcome::Ok(_)) => {}
            Ok(Outcome::Fail(refused)) => worker::console_log!("security: branch {branch} of {} kept: {}", repo.repo_id, refused.message),
            Err(error) => worker::console_error!("security: branch {branch} of {} not deleted: {error}", repo.repo_id),
        }
    }

    /// An update branch pushed by its sandbox after the update stopped
    /// being needed: deleted, while still at what the sandbox pushed.
    pub(crate) async fn drop_pushed(&self, repo_id: &str, branch: &str, after: &str) -> Result<()> {
        if after.is_empty() || after.bytes().all(|byte| byte == b'0') {
            return Ok(());
        }
        let deleted: Outcome<bool> = g1t_kit::call(
            &self.repos,
            "delete_branch",
            &DeleteBranchArgs { repo_id: repo_id.to_owned(), branch: branch.to_owned(), head: Some(after.to_owned()) },
        )
        .await?;
        if let Outcome::Fail(refused) = deleted {
            worker::console_log!("security: branch {branch} of {repo_id} kept: {}", refused.message);
        }
        Ok(())
    }

    /// A pull request closed or merged: if it is one of g1t's update pull
    /// requests, its branch goes.
    pub(crate) async fn pull_finished(&self, repo_id: &str, number: u32) -> Result<()> {
        let ours = self.store.update_by_pull(repo_id, number).await?.is_some() || self.store.update_pull_by_number(repo_id, number).await?.is_some();
        if !ours {
            return Ok(());
        }
        let Some(repo) = self.store.repo(repo_id).await? else { return Ok(()) };
        if let Some(pull) = self.get_pull(&repo, number).await?
            && !self.branch_in_use(&repo.repo_id, pull.branch.as_deref().unwrap_or_default()).await?
        {
            self.delete_pull_branch(&repo, &pull).await;
        }
        Ok(())
    }

    /// Whether an update still in progress is made on `branch`.
    async fn branch_in_use(&self, repo_id: &str, branch: &str) -> Result<bool> {
        let single = self.store.updates(repo_id).await?.into_iter().any(|row| row.state().in_progress() && row.branch.as_deref() == Some(branch));
        let pulls = self.store.update_pulls(repo_id).await?.into_iter().any(|row| row.state().in_progress() && row.branch == branch);
        Ok(single || pulls)
    }

    /// Closes g1t's update pull requests that are no longer needed (see the
    /// module), then removes branches left by closed ones. `lockfiles` is
    /// what a scan of the default branch read, when one did: without it,
    /// version updates are left as they are.
    pub(crate) async fn resolve_updates(&self, repo: &RepoRow, lockfiles: Option<(&[Located], &[String])>) -> Result<()> {
        let alerts = self.store.all_vulnerabilities(&repo.repo_id).await?;
        let pulls = self.store.update_pulls(&repo.repo_id).await?;
        let grouped: BTreeSet<u32> = pulls.iter().filter(|row| row.kind == "security").filter_map(|row| row.pull()).collect();
        let system = g1t_contracts::system::USERNAME;
        // One package's security update.
        for row in self.store.updates(&repo.repo_id).await? {
            if !row.state().in_progress() || row.pull().is_some_and(|number| grouped.contains(&number)) {
                continue;
            }
            let fixes = targeted(&alerts, &row.ecosystem, &row.package, &row.target);
            if still_needed(&fixes) {
                continue;
            }
            self.store.set_update(&row, UpdateState::Superseded, row.pull(), row.issue(), None).await?;
            let Some(number) = row.pull() else { continue };
            let packages = [row.package.clone()];
            match self.retire(repo, number, |base| resolved_text(base, &packages, &fixes)).await? {
                Retired::Merged => self.store.set_update(&row, UpdateState::Merged, Some(number), row.issue(), None).await?,
                Retired::Closed => {
                    let activity: Vec<Activity> =
                        fixes.iter().map(|alert| Activity { alert_id: &alert.id, action: "update_superseded", actor: Some(system), reason: None, comment: None, number: Some(number) }).collect();
                    self.store.record(&repo.repo_id, &activity).await?;
                }
                Retired::Left => {}
            }
        }
        // Grouped security updates, and version updates.
        for row in &pulls {
            if !matches!(row.state(), UpdateState::Open | UpdateState::Requested) {
                continue;
            }
            let dependencies = row.dependencies();
            let why: Option<Why<'_>> = if row.kind == "security" {
                let Some(osv) = osv_ecosystem(&row.ecosystem) else { continue };
                let fixes: Vec<&VulnRow> = dependencies.iter().flat_map(|dependency| targeted(&alerts, osv, &dependency.name, &dependency.to)).collect();
                if dependencies.is_empty() || still_needed(&fixes) {
                    None
                } else {
                    let packages: Vec<String> = dependencies.iter().map(|dependency| dependency.name.clone()).collect();
                    Some(Box::new(move |base: &str| resolved_text(base, &packages, &fixes)))
                }
            } else {
                // Only into the default branch, which the scan read, and
                // only once its pull request is open.
                let into_default = row.bump().is_none_or(|bump| bump.base.is_none());
                match lockfiles {
                    Some((located, paths)) if into_default && row.state() == UpdateState::Open => {
                        let now: Vec<(UpdatedDependency, Now)> =
                            dependencies.iter().map(|dependency| (dependency.clone(), now_of(&row.ecosystem, dependency, located, paths))).collect();
                        version_resolved_text("", &now).is_some().then(|| {
                            Box::new(move |base: &str| version_resolved_text(base, &now).unwrap_or_default()) as Why<'_>
                        })
                    }
                    _ => None,
                }
            };
            let Some(why) = why else { continue };
            self.store.set_update_pull(&row.id, UpdateState::Superseded, row.pull(), None, None).await?;
            let retired = match row.pull() {
                Some(number) => self.retire(repo, number, why).await?,
                None => Retired::Left,
            };
            if retired == Retired::Merged {
                self.store.set_update_pull(&row.id, UpdateState::Merged, row.pull(), None, None).await?;
            }
            // A grouped security update stands for each package's own.
            if row.kind == "security"
                && let Some(osv) = osv_ecosystem(&row.ecosystem)
            {
                let state = if retired == Retired::Merged { UpdateState::Merged } else { UpdateState::Superseded };
                for dependency in &dependencies {
                    if let Some(update) = self.store.update(&repo.repo_id, osv, &dependency.name).await?
                        && (update.state().in_progress() && (update.pull() == row.pull() || update.branch.as_deref() == Some(row.branch.as_str())))
                    {
                        self.store.set_update(&update, state, update.pull(), update.issue(), None).await?;
                    }
                }
            }
        }
        if let Err(error) = self.clean_update_branches(repo).await {
            worker::console_error!("security: update branches of {} not cleaned: {error}", repo.repo_id);
        }
        Ok(())
    }

    /// Removes branches left by g1t's update pull requests that are already
    /// closed or merged: a few per scan, only those no update in progress
    /// uses, and only while they are at the pull request's last commit.
    async fn clean_update_branches(&self, repo: &RepoRow) -> Result<()> {
        let updates = self.store.updates(&repo.repo_id).await?;
        let pulls = self.store.update_pulls(&repo.repo_id).await?;
        let finished = |state: UpdateState| matches!(state, UpdateState::Closed | UpdateState::Merged | UpdateState::Superseded);
        let in_use: BTreeSet<&str> = updates
            .iter()
            .filter(|row| row.state().in_progress())
            .filter_map(|row| row.branch.as_deref())
            .chain(pulls.iter().filter(|row| row.state().in_progress()).map(|row| row.branch.as_str()))
            .collect();
        let mut candidates: BTreeMap<&str, u32> = BTreeMap::new();
        for (branch, number) in updates
            .iter()
            .filter(|row| finished(row.state()))
            .filter_map(|row| Some((row.branch.as_deref()?, row.pull()?)))
            .chain(pulls.iter().filter(|row| finished(row.state())).filter_map(|row| Some((row.branch.as_str(), row.pull()?))))
        {
            if !branch.is_empty() && !in_use.contains(branch) {
                candidates.entry(branch).or_insert(number);
            }
        }
        if candidates.is_empty() {
            return Ok(());
        }
        let listed: Outcome<Vec<Branch>> = g1t_kit::call(
            &self.repos,
            "branches",
            &BranchesArgs { path: Self::path_of(repo), viewer: Some(User::system(&repo.namespace)) },
        )
        .await?;
        let Outcome::Ok(branches) = listed else { return Ok(()) };
        let tips: BTreeMap<&str, &str> = branches.iter().map(|branch| (branch.name.as_str(), branch.hash.as_str())).collect();
        let mut looked = 0;
        for (branch, number) in candidates {
            if looked >= BRANCHES_PER_SCAN {
                break;
            }
            let Some(tip) = tips.get(branch) else { continue };
            looked += 1;
            let Some(pull) = self.get_pull(repo, number).await? else { continue };
            if pull.branch.as_deref() == Some(branch) && pull.head_commit.as_deref() == Some(*tip) {
                self.delete_pull_branch(repo, &pull).await;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_scan::lockfiles::{Lockfile, Package};

    fn alert(package: &str, version: &str, manifest: &str, osv: &str, status: &str) -> VulnRow {
        VulnRow {
            id: format!("vul_{package}_{version}_{osv}"),
            repo_id: "rep_1".into(),
            ecosystem: "npm".into(),
            package: package.into(),
            version: version.into(),
            manifest: manifest.into(),
            osv_id: osv.into(),
            advisory: osv.into(),
            summary: String::new(),
            severity: "high".into(),
            fixed_version: Some("0.35.5".into()),
            status: status.into(),
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
    fn an_update_is_needed_while_an_alert_below_its_target_is_open() {
        let alerts = vec![
            alert("sharp", "0.34.1", "package-lock.json", "GHSA-1", "open"),
            // At or above the target: another update's business.
            alert("sharp", "0.35.5", "package-lock.json", "GHSA-2", "open"),
            alert("lodash", "4.17.20", "package-lock.json", "GHSA-3", "open"),
        ];
        let fixes = targeted(&alerts, "npm", "sharp", "0.35.5");
        assert_eq!(fixes.len(), 1);
        assert!(still_needed(&fixes));
        let alerts = vec![alert("sharp", "0.34.1", "package-lock.json", "GHSA-1", "fixed"), alert("sharp", "0.35.5", "package-lock.json", "GHSA-2", "open")];
        let fixes = targeted(&alerts, "npm", "sharp", "0.35.5");
        assert!(!still_needed(&fixes), "an alert the update would not fix keeps nothing open");
        assert!(targeted(&alerts, "crates.io", "sharp", "0.35.5").is_empty());
    }

    #[test]
    fn the_closing_comment_says_why() {
        let packages = ["sharp".to_owned()];
        let fixed = alert("sharp", "0.34.1", "package-lock.json", "GHSA-1", "fixed");
        assert_eq!(
            resolved_text("main", &packages, &[&fixed]),
            "Closed: the alert this fixed is resolved on `main` (`sharp` 0.34.1 is no longer in `package-lock.json`)."
        );
        let other = alert("sharp", "0.33.0", "web/package-lock.json", "GHSA-9", "fixed");
        assert_eq!(
            resolved_text("main", &packages, &[&fixed, &other]),
            "Closed: the alerts this fixed are resolved on `main` (`sharp` 0.33.0 and 0.34.1 are no longer in `package-lock.json` or `web/package-lock.json`)."
        );
        let dismissed = alert("sharp", "0.34.1", "package-lock.json", "GHSA-9", "dismissed");
        assert_eq!(resolved_text("main", &packages, &[&dismissed]), "Closed: the alert this fixed was dismissed, so this update is no longer needed.");
        assert!(resolved_text("main", &packages, &[&fixed, &dismissed]).starts_with("Closed: the alerts this fixed are resolved on `main` or dismissed ("));
        assert_eq!(resolved_text("trunk", &packages, &[]), "Closed: `sharp` is no longer vulnerable on `trunk`, so this update is no longer needed.");
    }

    fn dependency(name: &str, to: &str, directory: &str) -> UpdatedDependency {
        UpdatedDependency {
            name: name.into(),
            from: "1.0.0".into(),
            to: to.into(),
            directory: directory.into(),
            dependency_type: "direct:production".into(),
            update_type: "version-update:semver-minor".into(),
        }
    }

    fn located(name: &str, version: &str, path: &str) -> Located {
        let lockfile = Lockfile::for_path(path).unwrap();
        Located { package: Package { name: name.into(), version: version.into(), ecosystem: lockfile.ecosystem() }, lockfile, path: path.into() }
    }

    #[test]
    fn a_version_update_is_done_once_the_lockfile_has_its_version() {
        let paths = vec!["package-lock.json".to_owned(), "apps/web/package.json".to_owned()];
        let read = vec![located("lodash", "4.17.21", "package-lock.json"), located("react", "18.2.0", "package-lock.json")];
        let lodash = dependency("lodash", "4.17.21", "/");
        let react = dependency("react", "18.3.1", "/apps/web");
        let gone = dependency("left-pad", "1.3.0", "/");
        // A workspace directory is resolved by the lockfile above it.
        assert_eq!(now_of("npm", &react, &read, &paths), Now::At("18.2.0".into()));
        assert_eq!(now_of("npm", &gone, &read, &paths), Now::Gone);
        assert_eq!(now_of("cargo", &dependency("serde", "1.0.200", "/"), &read, &paths), Now::Unknown);
        let at = now_of("npm", &lodash, &read, &paths);
        assert_eq!(
            version_resolved_text("main", &[(lodash.clone(), at.clone())]).as_deref(),
            Some("Closed: `lodash` is already at 4.17.21 on `main`, so this update to 4.17.21 is no longer needed.")
        );
        assert_eq!(
            version_resolved_text("main", &[(gone.clone(), Now::Gone)]).as_deref(),
            Some("Closed: `left-pad` is no longer a dependency on `main`, so this update is no longer needed.")
        );
        // One dependency still behind keeps the whole pull request.
        assert_eq!(version_resolved_text("main", &[(lodash.clone(), at.clone()), (react.clone(), Now::At("18.2.0".into()))]), None);
        assert_eq!(version_resolved_text("main", &[(lodash.clone(), Now::Unknown)]), None);
        let both = version_resolved_text("main", &[(lodash, at), (gone, Now::Gone)]).unwrap();
        assert!(both.contains("`lodash` is at 4.17.21 and `left-pad` is no longer a dependency"), "{both}");
    }
}
