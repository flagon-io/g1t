//! The supply chain: a repository's dependency graph, read from the same
//! lockfiles as its vulnerability alerts; the graph as an SPDX SBOM; and
//! dependency review, which compares a pull request's dependencies with
//! its base and fails the `Dependency review` check when it adds a package
//! with a known vulnerability at or above the repository's threshold, or a
//! license the repository does not allow.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::{FindLockfilesArgs, Lockfiles};
use g1t_contracts::security_suite::{
    DEPENDENCY_REVIEW_CHECK, DependencyGraph, DependencyGraphArgs, DependencyReview, DependencyReviewArgs, GraphDependency,
    GraphManifest, PaidFeature, ReviewChange, ReviewVulnerability, SbomArgs,
};
use g1t_contracts::work::AddCommentArgs;
use g1t_contracts::{Outcome, User};
use g1t_scan::graph::{self, Dependency, Relationship};
use g1t_scan::lockfiles::{Ecosystem, Lockfile, Package};
use g1t_scan::osv::{self, Severity};
use g1t_scan::review::{self, ChangeKind, Finding, Policy, Verdict};
use g1t_scan::sbom;
use serde_json::Value;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;
use crate::suite_store::DependencyRow;

/// Added packages a review asks OSV about, at most; the rest are listed
/// without.
const MAX_REVIEWED: usize = 500;

/// Every package `files` resolve, with what each lockfile says of it. A
/// directory with a `go.mod` is read from it rather than its `go.sum`.
pub fn graph_of(files: &Lockfiles) -> Vec<Dependency> {
    let go_mods: BTreeSet<&str> = files
        .files
        .iter()
        .filter(|file| file.path.ends_with("go.mod"))
        .map(|file| file.path.trim_end_matches("go.mod"))
        .collect();
    let mut deps = Vec::new();
    for file in &files.files {
        let Some(lockfile) = Lockfile::for_path(&file.path) else { continue };
        if lockfile == Lockfile::GoSum && go_mods.contains(file.path.trim_end_matches("go.sum")) {
            continue;
        }
        deps.extend(graph::dependencies(lockfile, &file.path, &file.text));
    }
    deps
}

fn row_dependency(row: &DependencyRow) -> Option<Dependency> {
    Some(Dependency {
        package: Package { ecosystem: Ecosystem::parse(&row.ecosystem)?, name: row.name.clone(), version: row.version.clone() },
        manifest: row.manifest.clone(),
        relationship: Relationship::parse(&row.relationship),
        development: row.development != 0,
        license: row.license.clone(),
    })
}

/// The policy a repository's settings make.
pub fn policy_of(fail_on: &str, deny: &[String]) -> Policy {
    Policy {
        fail_on: match fail_on {
            "none" => None,
            other => Some(Severity::parse(other)).filter(|severity| *severity != Severity::Unknown),
        },
        deny_licenses: deny.iter().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).collect(),
    }
}

/// The review as the API and the pull request page show it.
pub fn review_view(base: &str, head: &str, verdict: &Verdict, policy: &Policy) -> DependencyReview {
    let change = |kind: &str, dep: &Dependency, findings: &[Finding], failing: &[Finding], denied: bool| ReviewChange {
        change_type: kind.to_owned(),
        manifest: dep.manifest.clone(),
        ecosystem: dep.package.ecosystem.osv().to_owned(),
        name: dep.package.name.clone(),
        version: dep.package.version.clone(),
        relationship: dep.relationship.as_str().to_owned(),
        development: dep.development,
        license: dep.license.clone(),
        purl: dep.purl(),
        vulnerabilities: findings
            .iter()
            .map(|finding| ReviewVulnerability {
                advisory: finding.advisory.clone(),
                osv_id: finding.osv_id.clone(),
                summary: finding.summary.clone(),
                severity: finding.severity.as_str().to_owned(),
                fixed_version: finding.fixed.clone(),
                url: osv::page_url(&finding.osv_id),
            })
            .collect(),
        denied_license: denied,
        failing: !failing.is_empty() || denied,
    };
    let mut changes: Vec<ReviewChange> = verdict
        .added
        .iter()
        .map(|reviewed| change("added", &reviewed.dependency, &reviewed.findings, &reviewed.failing, reviewed.denied_license))
        .collect();
    changes.extend(verdict.removed.iter().map(|dep| change("removed", dep, &[], &[], false)));
    DependencyReview {
        base: base.to_owned(),
        head: head.to_owned(),
        changes,
        passed: verdict.passed,
        headline: verdict.headline(),
        fail_on: policy.fail_on.map_or("none", |severity| severity.as_str()).to_owned(),
        deny_licenses: policy.deny_licenses.clone(),
    }
}

/// Whether a comparison touches any lockfile: if not, nothing in the
/// dependency graph can have changed.
pub fn touches_lockfiles(paths: &[String]) -> bool {
    paths.iter().any(|path| Lockfile::for_path(path).is_some())
}

impl Security {
    /// Keeps the dependency graph the lockfiles describe. Called with the
    /// lockfiles each dependency read fetched.
    pub(crate) async fn record_graph(&self, repo: &RepoRow, files: &Lockfiles) -> Result<()> {
        self.store.replace_dependencies(&repo.repo_id, &graph_of(files)).await
    }

    async fn lockfiles_at(&self, repo_id: &str, git_ref: Option<&str>) -> Result<Lockfiles> {
        g1t_kit::call(&self.repos, "find_lockfiles", &FindLockfilesArgs { repo_id: repo_id.to_owned(), git_ref: git_ref.map(str::to_owned) }).await
    }

    pub(crate) async fn dependency_graph(&self, a: DependencyGraphArgs) -> Result<Outcome<DependencyGraph>> {
        let mut repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if repo.deps_scanned_at.is_none() {
            self.scan_dependencies(&repo).await?;
            repo = self.store.repo(&repo.repo_id).await?.unwrap_or(repo);
        }
        let rows = self.store.dependencies(&repo.repo_id).await?;
        let mut vulnerable: HashMap<(String, String, String), u32> = HashMap::new();
        for vuln in self.store.open_vulnerabilities(&repo.repo_id).await? {
            *vulnerable.entry((vuln.ecosystem, vuln.package, vuln.version)).or_default() += 1;
        }
        let mut manifests: BTreeMap<String, GraphManifest> = BTreeMap::new();
        let mut dependencies = Vec::with_capacity(rows.len());
        for row in &rows {
            let Some(dep) = row_dependency(row) else { continue };
            let manifest = manifests.entry(row.manifest.clone()).or_insert_with(|| GraphManifest {
                path: row.manifest.clone(),
                ecosystem: row.ecosystem.clone(),
                dependencies: 0,
                direct: 0,
            });
            manifest.dependencies += 1;
            manifest.direct += u32::from(dep.relationship == Relationship::Direct);
            dependencies.push(GraphDependency {
                vulnerabilities: vulnerable.get(&(row.ecosystem.clone(), row.name.clone(), row.version.clone())).copied().unwrap_or(0),
                purl: dep.purl(),
                ecosystem: row.ecosystem.clone(),
                name: row.name.clone(),
                version: row.version.clone(),
                manifest: row.manifest.clone(),
                relationship: row.relationship.clone(),
                development: row.development != 0,
                license: row.license.clone(),
            });
        }
        // Lockfiles with nothing in them still show.
        for path in repo.scan_state().lockfiles {
            manifests.entry(path.clone()).or_insert_with(|| GraphManifest {
                ecosystem: Lockfile::for_path(&path).map(|lockfile| lockfile.ecosystem().osv().to_owned()).unwrap_or_default(),
                path,
                dependencies: 0,
                direct: 0,
            });
        }
        Ok(Outcome::Ok(DependencyGraph { commit: self.store.deps_commit(&repo.repo_id).await?, manifests: manifests.into_values().collect(), dependencies }))
    }

    pub(crate) async fn sbom(&self, a: SbomArgs) -> Result<Outcome<Value>> {
        let graph = match self.dependency_graph(DependencyGraphArgs { viewer: a.viewer, repo: a.repo.clone() }).await? {
            Outcome::Ok(graph) => graph,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let deps: Vec<Dependency> = graph
            .dependencies
            .iter()
            .filter_map(|dep| {
                Some(Dependency {
                    package: Package { ecosystem: Ecosystem::parse(&dep.ecosystem)?, name: dep.name.clone(), version: dep.version.clone() },
                    manifest: dep.manifest.clone(),
                    relationship: Relationship::parse(&dep.relationship),
                    development: dep.development,
                    license: dep.license.clone(),
                })
            })
            .collect();
        let full_name = format!("{}/{}", a.repo.namespace, a.repo.name);
        let url = format!("https://g1t.sh/{full_name}");
        let unique = g1t_contracts::new_id("sbom", g1t_kit::now_ms());
        let created = format!("{}Z", &crate::store::now()[..19]);
        Ok(Outcome::Ok(sbom::spdx(
            &sbom::Subject { full_name: &full_name, url: &url, commit: graph.commit.as_deref(), unique: &unique, created: &created },
            &deps,
        )))
    }

    /// Asks OSV about the packages a change adds.
    async fn findings_for(&self, added: &[&Dependency]) -> Result<BTreeMap<String, Vec<Finding>>> {
        let packages: Vec<Package> = added.iter().map(|dep| dep.package.clone()).collect::<BTreeSet<_>>().into_iter().take(MAX_REVIEWED).collect();
        if packages.is_empty() {
            return Ok(BTreeMap::new());
        }
        let (ids, _) = self.query_osv(&packages).await?;
        let wanted: BTreeSet<String> = ids.iter().flatten().cloned().collect();
        let (records, _) = self.advisories(&wanted).await?;
        let mut found = BTreeMap::new();
        for (package, ids) in packages.iter().zip(ids) {
            let findings: Vec<Finding> = ids
                .iter()
                .filter_map(|id| osv::read_vuln(records.get(id)?, package))
                .map(|advisory| Finding {
                    advisory: advisory.display_id,
                    osv_id: advisory.id,
                    summary: advisory.summary,
                    severity: advisory.severity,
                    fixed: advisory.fixed,
                })
                .collect();
            if !findings.is_empty() {
                found.insert(graph::purl(package.ecosystem, &package.name, &package.version), findings);
            }
        }
        Ok(found)
    }

    /// Reviews the change from `base` (in `base_repo`) to `head` (in
    /// `head_repo`, a fork's for a pull request from one).
    async fn review(&self, base_repo: &str, base: &str, head_repo: &str, head: &str, policy: &Policy) -> Result<(Verdict, DependencyReview)> {
        let (before, after) = (self.lockfiles_at(base_repo, Some(base)).await?, self.lockfiles_at(head_repo, Some(head)).await?);
        let changes = review::diff(&graph_of(&before), &graph_of(&after));
        let added: Vec<&Dependency> = changes.iter().filter(|change| change.kind == ChangeKind::Added).map(|change| &change.dependency).collect();
        let findings = self.findings_for(&added).await?;
        let verdict = review::judge(&changes, &findings, policy);
        let view = review_view(base, head, &verdict, policy);
        Ok((verdict, view))
    }

    pub(crate) async fn dependency_review(&self, a: DependencyReviewArgs) -> Result<Outcome<DependencyReview>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Some(refusal) = self.gate(&repo, PaidFeature::DependencyReview).await? {
            return Ok(refusal);
        }
        let (settings, _) = self.store.repo_settings(&repo.repo_id).await?;
        let policy = policy_of(&settings.review_fail_on, &settings.review_deny_licenses);
        let (_, view) = self.review(&repo.repo_id, &a.base, &repo.repo_id, &a.head, &policy).await?;
        Ok(Outcome::Ok(view))
    }

    /// The `Dependency review` check on a pull request whose head moved.
    pub(crate) async fn review_pull(&self, repo_id: &str, number: u32) -> Result<()> {
        let Some(repo) = self.register_by_id(repo_id).await? else { return Ok(()) };
        let (settings, _) = self.store.repo_settings(&repo.repo_id).await?;
        if !settings.dependency_review || !self.entitled(&repo).await? {
            return Ok(());
        }
        let Some(pull) = self.pull_by_number(&repo, number).await? else { return Ok(()) };
        let Some(head) = pull.head_commit.clone() else { return Ok(()) };
        if let Some(previous) = self.store.pull_check(&repo.repo_id, number, "review").await?
            && previous.commit_sha == head
        {
            return Ok(());
        }
        let Some(comparison) = self.pull_comparison(&repo, &pull).await? else { return Ok(()) };
        let policy = policy_of(&settings.review_fail_on, &settings.review_deny_licenses);
        let paths: Vec<String> = comparison.files.iter().map(|file| file.path.clone()).collect();
        let (state, description, detail, summary) = if !touches_lockfiles(&paths) {
            let view = DependencyReview {
                head: head.clone(),
                passed: true,
                headline: "No dependency changes".to_owned(),
                fail_on: policy.fail_on.map_or("none", |severity| severity.as_str()).to_owned(),
                deny_licenses: policy.deny_licenses.clone(),
                ..DependencyReview::default()
            };
            ("success", view.headline.clone(), view, None)
        } else {
            let base = comparison.base.clone().unwrap_or_else(|| "HEAD".to_owned());
            let head_repo = pull.fork_repo_id.clone().unwrap_or_else(|| repo.repo_id.clone());
            let (verdict, view) = self.review(&repo.repo_id, &base, &head_repo, &head, &policy).await?;
            let summary = verdict.summary(&policy);
            (if verdict.passed { "success" } else { "failure" }, verdict.headline(), view, Some(summary))
        };
        self.store
            .set_pull_check(&repo.repo_id, number, "review", &head, state, &description, &serde_json::to_value(&detail)?, &[])
            .await?;
        self.set_status(&repo, &head, DEPENDENCY_REVIEW_CHECK, state, &description, number).await;
        if let (Some(summary), true) = (summary, settings.review_comment) {
            let _: Result<Outcome<Value>> = g1t_kit::call(
                &self.work,
                "add_comment",
                &AddCommentArgs {
                    actor: User::system(&repo.namespace),
                    repo: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                    number,
                    body: summary,
                    path: None,
                    line: None,
                    verdict: None,
                },
            )
            .await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::security::LockfileText;

    #[test]
    fn the_graph_reads_every_lockfile_and_skips_go_sum_beside_go_mod() {
        let files = Lockfiles {
            commit: None,
            files: vec![
                LockfileText { path: "go.mod".into(), text: "require golang.org/x/net v0.7.0 // indirect\n".into() },
                LockfileText { path: "go.sum".into(), text: "golang.org/x/net v0.1.0 h1:x=\n".into() },
                LockfileText {
                    path: "web/package-lock.json".into(),
                    text: r#"{"packages":{"":{"dependencies":{"lodash":"^4"}},"node_modules/lodash":{"version":"4.17.21","license":"MIT"}}}"#.into(),
                },
            ],
        };
        let deps: Vec<String> = graph_of(&files)
            .iter()
            .map(|dep| format!("{} {} {}", dep.manifest, dep.package.name, dep.relationship.as_str()))
            .collect();
        assert_eq!(deps, ["go.mod golang.org/x/net transitive", "web/package-lock.json lodash direct"]);
    }

    #[test]
    fn the_policy_comes_from_the_settings() {
        assert_eq!(policy_of("high", &[" GPL-3.0-only ".into(), "".into()]).fail_on, Some(Severity::High));
        assert_eq!(policy_of("high", &[" GPL-3.0-only ".into(), "".into()]).deny_licenses, ["GPL-3.0-only"]);
        assert_eq!(policy_of("none", &[]).fail_on, None);
        assert_eq!(policy_of("moderate", &[]).fail_on, Some(Severity::Medium));
    }

    #[test]
    fn only_lockfile_changes_need_a_review() {
        assert!(!touches_lockfiles(&["src/app.ts".into(), "README.md".into()]));
        assert!(touches_lockfiles(&["src/app.ts".into(), "web/package-lock.json".into()]));
    }

    #[test]
    fn the_review_view_marks_what_fails() {
        let dep = |version: &str| Dependency {
            package: Package { ecosystem: Ecosystem::Npm, name: "lodash".into(), version: version.into() },
            manifest: "package-lock.json".into(),
            relationship: Relationship::Direct,
            development: false,
            license: Some("MIT".into()),
        };
        let changes = review::diff(&[dep("4.17.21")], &[dep("4.17.20")]);
        let findings = BTreeMap::from([(
            "pkg:npm/lodash@4.17.20".to_owned(),
            vec![Finding {
                advisory: "GHSA-35jh-r3h4-6jhm".into(),
                osv_id: "GHSA-35jh-r3h4-6jhm".into(),
                summary: "Command Injection in lodash".into(),
                severity: Severity::High,
                fixed: Some("4.17.21".into()),
            }],
        )]);
        let policy = policy_of("high", &[]);
        let verdict = review::judge(&changes, &findings, &policy);
        let view = review_view("abc", "def", &verdict, &policy);
        assert!(!view.passed);
        assert_eq!(view.changes.len(), 2);
        let added = view.changes.iter().find(|change| change.change_type == "added").unwrap();
        assert!(added.failing && added.vulnerabilities[0].url.ends_with("GHSA-35jh-r3h4-6jhm"));
        assert_eq!(view.fail_on, "high");
    }
}
