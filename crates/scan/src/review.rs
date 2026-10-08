//! Dependency review: what a pull request changes in the dependency graph,
//! and whether that is allowed. The packages it adds (or moves to another
//! version) are checked for known vulnerabilities and, when the repository
//! lists licenses it does not allow, for those.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::graph::Dependency;
use crate::osv::Severity;

/// How a package changed between the base and the head.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Removed,
}

/// One package at one version, added or removed in one lockfile. A version
/// change is a removal of the old and an addition of the new.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Change {
    pub kind: ChangeKind,
    pub dependency: Dependency,
}

/// The packages `head` has that `base` does not, and the other way round,
/// per lockfile, sorted by lockfile, name and version.
pub fn diff(base: &[Dependency], head: &[Dependency]) -> Vec<Change> {
    let key = |dep: &Dependency| (dep.manifest.clone(), dep.package.ecosystem, dep.package.name.clone(), dep.package.version.clone());
    let before: BTreeMap<_, &Dependency> = base.iter().map(|dep| (key(dep), dep)).collect();
    let after: BTreeMap<_, &Dependency> = head.iter().map(|dep| (key(dep), dep)).collect();
    let mut changes: Vec<Change> = after
        .iter()
        .filter(|(key, _)| !before.contains_key(*key))
        .map(|(_, dep)| Change { kind: ChangeKind::Added, dependency: (*dep).clone() })
        .chain(
            before
                .iter()
                .filter(|(key, _)| !after.contains_key(*key))
                .map(|(_, dep)| Change { kind: ChangeKind::Removed, dependency: (*dep).clone() }),
        )
        .collect();
    changes.sort_by(|a, b| {
        (&a.dependency.manifest, &a.dependency.package.name, &a.dependency.package.version, a.kind).cmp(&(
            &b.dependency.manifest,
            &b.dependency.package.name,
            &b.dependency.package.version,
            b.kind,
        ))
    });
    changes
}

/// A known vulnerability in an added package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    /// The id people know it by.
    pub advisory: String,
    pub osv_id: String,
    pub summary: String,
    pub severity: Severity,
    pub fixed: Option<String>,
}

/// What the repository asks of a review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// The lowest severity that fails the check; `None` never fails on
    /// vulnerabilities.
    pub fail_on: Option<Severity>,
    /// SPDX license ids that fail the check when an added package has one.
    pub deny_licenses: Vec<String>,
}

/// How bad a severity is, higher worse.
pub fn rank(severity: Severity) -> u8 {
    match severity {
        Severity::Critical => 4,
        Severity::High => 3,
        Severity::Medium => 2,
        Severity::Low => 1,
        Severity::Unknown => 0,
    }
}

/// Whether `license` (an SPDX expression) names any denied id. `MIT OR
/// GPL-3.0` names GPL-3.0; denying applies when any choice is denied only
/// if no other choice is allowed, so an `OR` with an allowed side passes.
pub fn denied_license(license: &str, deny: &[String]) -> bool {
    if deny.is_empty() {
        return false;
    }
    let denied = |id: &str| {
        let id = id.trim().trim_matches(['(', ')']);
        deny.iter().any(|deny| deny.eq_ignore_ascii_case(id))
    };
    // Any alternative entirely free of denied ids makes it acceptable.
    !license.split(" OR ").any(|alternative| !alternative.split(" AND ").any(&denied))
}

/// The verdict on one added package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reviewed {
    pub dependency: Dependency,
    pub findings: Vec<Finding>,
    /// Its findings at or above the policy's severity.
    pub failing: Vec<Finding>,
    pub denied_license: bool,
}

/// The whole review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub added: Vec<Reviewed>,
    pub removed: Vec<Dependency>,
    pub passed: bool,
}

/// Judges `changes` with the vulnerabilities found for each added package
/// (`findings`, by purl) under `policy`.
pub fn judge(changes: &[Change], findings: &BTreeMap<String, Vec<Finding>>, policy: &Policy) -> Verdict {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for change in changes {
        match change.kind {
            ChangeKind::Removed => removed.push(change.dependency.clone()),
            ChangeKind::Added => {
                let found = findings.get(&change.dependency.purl()).cloned().unwrap_or_default();
                let failing: Vec<Finding> = match policy.fail_on {
                    Some(threshold) => found
                        .iter()
                        .filter(|finding| finding.severity != Severity::Unknown && rank(finding.severity) >= rank(threshold))
                        .cloned()
                        .collect(),
                    None => Vec::new(),
                };
                let denied = change
                    .dependency
                    .license
                    .as_deref()
                    .is_some_and(|license| denied_license(license, &policy.deny_licenses));
                added.push(Reviewed { dependency: change.dependency.clone(), findings: found, failing, denied_license: denied });
            }
        }
    }
    let passed = added.iter().all(|reviewed| reviewed.failing.is_empty() && !reviewed.denied_license);
    Verdict { added, removed, passed }
}

impl Verdict {
    /// One line for the check's description.
    pub fn headline(&self) -> String {
        let vulnerable = self.added.iter().filter(|reviewed| !reviewed.failing.is_empty()).count();
        let licensed = self.added.iter().filter(|reviewed| reviewed.denied_license).count();
        let changed = self.added.len() + self.removed.len();
        if changed == 0 {
            return "No dependency changes".to_owned();
        }
        let mut problems = Vec::new();
        if vulnerable > 0 {
            problems.push(format!("{vulnerable} vulnerable {}", if vulnerable == 1 { "package" } else { "packages" }));
        }
        if licensed > 0 {
            problems.push(format!("{licensed} with a license not allowed"));
        }
        if problems.is_empty() {
            let known = self.added.iter().filter(|reviewed| !reviewed.findings.is_empty()).count();
            return if known > 0 {
                format!("{changed} dependency changes; {known} below the severity that fails")
            } else {
                format!("{changed} dependency changes, none vulnerable")
            };
        }
        format!("Adds {}", problems.join(" and "))
    }

    /// The pull request comment: what changed, per lockfile, and why the
    /// check failed if it did. Markdown.
    pub fn summary(&self, policy: &Policy) -> String {
        let mut text = String::from("### Dependency review\n\n");
        if self.added.is_empty() && self.removed.is_empty() {
            text.push_str("This pull request changes no dependencies.\n");
            return text;
        }
        text.push_str(if self.passed { "**Passed.** " } else { "**Failed.** " });
        text.push_str(&self.headline());
        text.push_str(".\n\n");
        let manifests: BTreeSet<&str> = self
            .added
            .iter()
            .map(|reviewed| reviewed.dependency.manifest.as_str())
            .chain(self.removed.iter().map(|dep| dep.manifest.as_str()))
            .collect();
        for manifest in manifests {
            text.push_str(&format!("**`{manifest}`**\n\n| Change | Package | Version | Relationship | License | Vulnerabilities |\n| --- | --- | --- | --- | --- | --- |\n"));
            for reviewed in self.added.iter().filter(|reviewed| reviewed.dependency.manifest == manifest) {
                let dep = &reviewed.dependency;
                let vulns = if reviewed.findings.is_empty() {
                    "none known".to_owned()
                } else {
                    reviewed
                        .findings
                        .iter()
                        .map(|finding| {
                            let fails = reviewed.failing.contains(finding);
                            format!(
                                "{}[{}]({}) {}{}",
                                if fails { "**" } else { "" },
                                finding.advisory,
                                crate::osv::page_url(&finding.osv_id),
                                finding.severity.as_str(),
                                if fails { "**" } else { "" }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let license = match (&dep.license, reviewed.denied_license) {
                    (Some(license), true) => format!("**{license}** (not allowed)"),
                    (Some(license), false) => license.clone(),
                    (None, _) => "unknown".to_owned(),
                };
                text.push_str(&format!(
                    "| Added | `{}` | {} | {}{} | {} | {} |\n",
                    dep.package.name,
                    dep.package.version,
                    dep.relationship.as_str(),
                    if dep.development { ", development" } else { "" },
                    license,
                    vulns
                ));
            }
            for dep in self.removed.iter().filter(|dep| dep.manifest == manifest) {
                text.push_str(&format!(
                    "| Removed | `{}` | {} | {} | {} | |\n",
                    dep.package.name,
                    dep.package.version,
                    dep.relationship.as_str(),
                    dep.license.as_deref().unwrap_or("unknown")
                ));
            }
            text.push('\n');
        }
        let threshold = match policy.fail_on {
            Some(severity) => format!("vulnerabilities of {} severity or higher", severity.as_str()),
            None => "no vulnerability severity".to_owned(),
        };
        text.push_str(&format!("This check fails on {threshold}"));
        if !policy.deny_licenses.is_empty() {
            text.push_str(&format!(" and on these licenses: {}", policy.deny_licenses.join(", ")));
        }
        text.push_str(". Change it in the repository's Security settings.\n");
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Relationship;
    use crate::lockfiles::{Ecosystem, Package};

    fn dep(name: &str, version: &str, license: Option<&str>) -> Dependency {
        Dependency {
            package: Package { ecosystem: Ecosystem::Npm, name: name.into(), version: version.into() },
            manifest: "package-lock.json".into(),
            relationship: Relationship::Direct,
            development: false,
            license: license.map(str::to_owned),
        }
    }

    fn finding(severity: Severity) -> Finding {
        Finding {
            advisory: "GHSA-35jh-r3h4-6jhm".into(),
            osv_id: "GHSA-35jh-r3h4-6jhm".into(),
            summary: "Command Injection in lodash".into(),
            severity,
            fixed: Some("4.17.21".into()),
        }
    }

    #[test]
    fn a_version_change_is_a_removal_and_an_addition() {
        let base = [dep("lodash", "4.17.21", None), dep("left-pad", "1.3.0", None), dep("ms", "2.1.2", None)];
        let head = [dep("lodash", "4.17.20", None), dep("ms", "2.1.2", None), dep("chalk", "5.0.0", None)];
        let changes: Vec<String> = diff(&base, &head)
            .iter()
            .map(|change| format!("{:?} {}@{}", change.kind, change.dependency.package.name, change.dependency.package.version))
            .collect();
        assert_eq!(changes, ["Added chalk@5.0.0", "Removed left-pad@1.3.0", "Added lodash@4.17.20", "Removed lodash@4.17.21"]);
        assert!(diff(&head, &head).is_empty());
    }

    #[test]
    fn the_review_fails_at_the_configured_severity() {
        let changes = diff(&[dep("lodash", "4.17.21", None)], &[dep("lodash", "4.17.20", None)]);
        let findings = BTreeMap::from([("pkg:npm/lodash@4.17.20".to_owned(), vec![finding(Severity::High)])]);
        let strict = Policy { fail_on: Some(Severity::Medium), deny_licenses: Vec::new() };
        let verdict = judge(&changes, &findings, &strict);
        assert!(!verdict.passed);
        assert_eq!(verdict.headline(), "Adds 1 vulnerable package");
        let summary = verdict.summary(&strict);
        assert!(summary.contains("**Failed.**") && summary.contains("**[GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm) high**"));
        assert!(summary.contains("| Removed | `lodash` | 4.17.21 |"));
        // Critical only: a high finding is shown but passes.
        let lenient = Policy { fail_on: Some(Severity::Critical), deny_licenses: Vec::new() };
        let verdict = judge(&changes, &findings, &lenient);
        assert!(verdict.passed);
        assert_eq!(verdict.headline(), "2 dependency changes; 1 below the severity that fails");
        // Off: never fails on vulnerabilities.
        assert!(judge(&changes, &findings, &Policy { fail_on: None, deny_licenses: Vec::new() }).passed);
    }

    #[test]
    fn denied_licenses_fail_unless_an_alternative_is_allowed() {
        let deny = vec!["GPL-3.0-only".to_owned(), "AGPL-3.0-only".to_owned()];
        assert!(denied_license("GPL-3.0-only", &deny));
        assert!(denied_license("MIT AND GPL-3.0-only", &deny));
        assert!(!denied_license("MIT OR GPL-3.0-only", &deny));
        assert!(!denied_license("(MIT)", &deny));
        assert!(!denied_license("GPL-3.0-only", &[]));
        let changes = diff(&[], &[dep("copyleft", "1.0.0", Some("AGPL-3.0-only"))]);
        let policy = Policy { fail_on: Some(Severity::High), deny_licenses: deny };
        let verdict = judge(&changes, &BTreeMap::new(), &policy);
        assert!(!verdict.passed);
        assert_eq!(verdict.headline(), "Adds 1 with a license not allowed");
        assert!(verdict.summary(&policy).contains("**AGPL-3.0-only** (not allowed)"));
    }

    #[test]
    fn nothing_changed_says_so() {
        let verdict = judge(&[], &BTreeMap::new(), &Policy { fail_on: Some(Severity::High), deny_licenses: Vec::new() });
        assert!(verdict.passed);
        assert_eq!(verdict.headline(), "No dependency changes");
    }
}
