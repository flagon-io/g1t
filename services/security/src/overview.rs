//! Settings, and the workspace's security overview: open alerts by type
//! and severity across its repositories, how they moved, which repository
//! has which feature on, and those most in need.

use std::collections::BTreeMap;

use g1t_contracts::access::{self, Capability};
use g1t_contracts::security::SeverityCounts;
use g1t_contracts::security_suite::{
    AlertType, RepoCoverage, SecuritySettingsArgs, SecuritySettingsView, SetSecuritySettingsArgs, SetWorkspaceSecuritySettingsArgs,
    TrendPoint, TypeTotals, WorkspaceAlert, WorkspaceAlertsArgs, WorkspaceOverview, WorkspaceOverviewArgs,
    WorkspaceSecuritySettingsArgs, WorkspaceSecurityView,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Repositories snapshotted per sweep.
const SNAPSHOTS_PER_SWEEP: u32 = 25;
const GATES: [&str; 6] = ["none", "errors", "critical", "high", "medium", "any"];
const SEVERITY_NAMES: [&str; 5] = ["critical", "high", "medium", "low", "none"];
/// Licenses a repository may deny, at most.
const MAX_DENIED: usize = 50;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

fn add(total: &mut SeverityCounts, counts: &SeverityCounts) {
    total.critical += counts.critical;
    total.high += counts.high;
    total.medium += counts.medium;
    total.low += counts.low;
    total.unknown += counts.unknown;
}

fn sum(counts: &SeverityCounts) -> u32 {
    counts.critical + counts.high + counts.medium + counts.low + counts.unknown
}

/// The days of a trend, oldest first, ending today: `YYYY-MM-DD`.
pub fn days(today_ms: u64, count: u32) -> Vec<String> {
    (0..count).rev().map(|ago| rfc3339(today_ms.saturating_sub(u64::from(ago) * DAY_MS))[..10].to_owned()).collect()
}

/// Repositories most in need first: open critical, then high, then the rest.
pub fn rank(repos: &mut [RepoCoverage]) {
    let key = |repo: &RepoCoverage| {
        let mut total = SeverityCounts::default();
        add(&mut total, &repo.secrets);
        add(&mut total, &repo.code);
        add(&mut total, &repo.vulnerabilities);
        (std::cmp::Reverse(total.critical), std::cmp::Reverse(total.high), std::cmp::Reverse(sum(&total)))
    };
    repos.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.name.cmp(&b.name)));
}

/// A trend from daily snapshots: each day's open alerts by type, carrying
/// a repository's last known counts over days it was not snapshotted.
pub fn trend(days: &[String], rows: &[crate::suite_store::SnapshotRow]) -> Vec<TrendPoint> {
    let mut by_day: BTreeMap<&str, TrendPoint> = BTreeMap::new();
    for row in rows {
        let point = by_day.entry(row.day.as_str()).or_insert_with(|| TrendPoint { day: row.day.clone(), ..TrendPoint::default() });
        let n = (row.critical + row.high + row.medium + row.low + row.unknown).max(0) as u32;
        match row.alert_type.as_str() {
            "secret_scanning" => point.secret_scanning += n,
            "code_scanning" => point.code_scanning += n,
            _ => point.vulnerability += n,
        }
    }
    days.iter()
        .map(|day| by_day.get(day.as_str()).cloned().unwrap_or_else(|| TrendPoint { day: day.clone(), ..TrendPoint::default() }))
        .collect()
}

impl Security {
    pub(crate) async fn security_settings(&self, a: SecuritySettingsArgs) -> Result<Outcome<SecuritySettingsView>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (settings, private) = self.store.repo_settings(&repo.repo_id).await?;
        Ok(Outcome::Ok(SecuritySettingsView {
            settings,
            workspace: self.store.workspace_settings(&repo.namespace).await?,
            private,
            entitled: !private || self.activated(&repo.namespace).await,
            upkeep: repo.upkeep != 0,
        }))
    }

    pub(crate) async fn set_security_settings(&self, a: SetSecuritySettingsArgs) -> Result<Outcome<SecuritySettingsView>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), Capability::ManageSettings).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let mut settings = a.settings;
        if !GATES.contains(&settings.code_scanning_gate.as_str()) {
            return Ok(fail(FailureCode::Invalid, "code_scanning_gate is none, errors, critical, high, medium or any."));
        }
        if !SEVERITY_NAMES.contains(&settings.review_fail_on.as_str()) {
            return Ok(fail(FailureCode::Invalid, "review_fail_on is critical, high, medium, low or none."));
        }
        settings.review_deny_licenses = settings
            .review_deny_licenses
            .iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '+')))
            .take(MAX_DENIED)
            .collect();
        self.store.set_repo_settings(&repo.repo_id, &settings).await?;
        self.audit(
            &a.actor,
            "security_settings",
            Some(&repo),
            &repo.namespace,
            None,
            &format!(
                "Security settings: code scanning fails at {}, dependency review {} (fails at {})",
                settings.code_scanning_gate,
                if settings.dependency_review { "on" } else { "off" },
                settings.review_fail_on
            ),
        )
        .await;
        self.security_settings(SecuritySettingsArgs { viewer: Some(a.actor), repo: a.repo }).await
    }

    pub(crate) async fn workspace_security_settings(&self, a: WorkspaceSecuritySettingsArgs) -> Result<Outcome<WorkspaceSecurityView>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|user| user.is_member(&workspace)) {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        }
        Ok(Outcome::Ok(WorkspaceSecurityView {
            settings: self.store.workspace_settings(&workspace).await?,
            activated: self.activated(&workspace).await,
        }))
    }

    pub(crate) async fn set_workspace_security_settings(&self, a: SetWorkspaceSecuritySettingsArgs) -> Result<Outcome<WorkspaceSecurityView>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(fail(FailureCode::Forbidden, "Only an owner can change the workspace's security settings."));
        }
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        self.store.set_workspace_settings(&workspace, &a.settings, &a.actor.username).await?;
        self.audit(
            &a.actor,
            "security_settings",
            None,
            &workspace,
            None,
            &format!(
                "Workspace security settings: delegated bypass {}, validity checks {}",
                if a.settings.delegated_bypass { "on" } else { "off" },
                if a.settings.validity_checks { "on" } else { "off" }
            ),
        )
        .await;
        self.workspace_security_settings(WorkspaceSecuritySettingsArgs { viewer: Some(a.actor), workspace }).await
    }

    /// The repositories of a workspace whose findings `viewer` may see,
    /// with whether each is private.
    async fn visible_repos(&self, workspace: &str, viewer: &g1t_contracts::User) -> Result<Vec<(RepoRow, bool)>> {
        let mut out = Vec::new();
        for repo in self.store.in_namespace(workspace).await? {
            let target = access::RepoRef { id: &repo.repo_id, namespace: workspace, private: true };
            if !access::can(Some(viewer), target, crate::SEE_FINDINGS) {
                continue;
            }
            let (_, private) = self.store.repo_settings(&repo.repo_id).await?;
            out.push((repo, private));
        }
        Ok(out)
    }

    pub(crate) async fn security_overview(&self, a: WorkspaceOverviewArgs) -> Result<Outcome<WorkspaceOverview>> {
        let workspace = a.workspace.to_lowercase();
        let Some(viewer) = a.viewer.as_ref().filter(|user| user.is_member(&workspace)) else {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        };
        let activated = self.activated(&workspace).await;
        let settings = self.store.workspace_settings(&workspace).await?;
        let mut repos = Vec::new();
        let mut hidden = 0;
        for (repo, private) in self.visible_repos(&workspace, viewer).await? {
            // Private repositories count with the activation only.
            if private && !activated {
                hidden += 1;
                continue;
            }
            let (repo_settings, _) = self.store.repo_settings(&repo.repo_id).await?;
            repos.push(RepoCoverage {
                custom_patterns: self.store.pattern_count(&workspace, &repo.repo_id).await?,
                validity_checks: settings.validity_checks,
                code_scanning_at: self.store.last_analysis_at(&repo.repo_id).await?,
                dependency_review: repo_settings.dependency_review,
                security_updates: repo.upkeep != 0,
                lockfiles: repo.scan_state().lockfiles.len() as u32,
                secrets: self.store.secret_severity_counts(&repo.repo_id).await?,
                code: self.store.code_counts(&repo.repo_id).await?,
                vulnerabilities: self.store.vulnerability_counts(&repo.repo_id).await?,
                repo_id: repo.repo_id,
                name: repo.name,
                private,
            });
        }
        let ids: Vec<String> = repos.iter().map(|repo| repo.repo_id.clone()).collect();
        let span = a.days.unwrap_or(30).clamp(7, 90);
        let since = rfc3339(now_ms().saturating_sub(u64::from(span) * DAY_MS));
        let mut totals = Vec::new();
        for alert_type in AlertType::ALL {
            let mut open = SeverityCounts::default();
            for repo in &repos {
                add(&mut open, match alert_type {
                    AlertType::SecretScanning => &repo.secrets,
                    AlertType::CodeScanning => &repo.code,
                    AlertType::Vulnerability => &repo.vulnerabilities,
                });
            }
            let (opened, closed) = self.store.opened_and_closed(alert_type.as_str(), &ids, &since).await?;
            totals.push(TypeTotals { alert_type: alert_type.as_str().to_owned(), open, opened, closed });
        }
        let days = days(now_ms(), span);
        let snapshots = self.store.snapshots(&workspace, &days[0], &ids).await?;
        let trend = trend(&days, &snapshots);
        rank(&mut repos);
        Ok(Outcome::Ok(WorkspaceOverview { activated, private_hidden: hidden, totals, trend, repos }))
    }

    pub(crate) async fn workspace_alerts(&self, a: WorkspaceAlertsArgs) -> Result<Outcome<Vec<WorkspaceAlert>>> {
        let workspace = a.workspace.to_lowercase();
        let Some(viewer) = a.viewer.as_ref().filter(|user| user.is_member(&workspace)) else {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        };
        let activated = self.activated(&workspace).await;
        let mut alerts = Vec::new();
        for (repo, private) in self.visible_repos(&workspace, viewer).await? {
            match a.alert_type {
                AlertType::SecretScanning => alerts.extend(self.store.secrets(&repo.repo_id).await?.into_iter().map(|secret| WorkspaceAlert {
                    repo: repo.name.clone(),
                    secret: Some(secret),
                    code: None,
                    vulnerability: None,
                })),
                AlertType::Vulnerability => {
                    alerts.extend(self.store.vulnerabilities(&repo.repo_id).await?.into_iter().map(|vuln| WorkspaceAlert {
                        repo: repo.name.clone(),
                        secret: None,
                        code: None,
                        vulnerability: Some(vuln),
                    }))
                }
                // Code scanning on a private repository is the activation's.
                AlertType::CodeScanning if private && !activated => {}
                AlertType::CodeScanning => alerts.extend(self.store.code_alerts(&repo.repo_id).await?.into_iter().map(|code| WorkspaceAlert {
                    repo: repo.name.clone(),
                    secret: None,
                    code: Some(code),
                    vulnerability: None,
                })),
            }
            if alerts.len() >= 5_000 {
                break;
            }
        }
        Ok(Outcome::Ok(alerts))
    }

    /// The sweep's part: today's open counts for repositories that have
    /// none yet, and validity checks where the workspace turned them on.
    pub(crate) async fn sweep_suite(&self) -> Result<()> {
        let today = rfc3339(now_ms())[..10].to_owned();
        for repo in self.store.unsnapshotted(&today, SNAPSHOTS_PER_SWEEP).await? {
            let secrets = self.store.secret_severity_counts(&repo.repo_id).await?;
            let code = self.store.code_counts(&repo.repo_id).await?;
            let vulnerabilities = self.store.vulnerability_counts(&repo.repo_id).await?;
            for (kind, counts) in [("secret_scanning", &secrets), ("code_scanning", &code), ("vulnerability", &vulnerabilities)] {
                self.store.snapshot(&repo.repo_id, &repo.namespace, &today, kind, counts).await?;
            }
            if let Err(error) = self.sweep_validity(&repo).await {
                worker::console_error!("security: validity checks for {}: {error}", repo.repo_id);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::suite_store::SnapshotRow;

    fn counts(critical: u32, high: u32) -> SeverityCounts {
        SeverityCounts { critical, high, ..SeverityCounts::default() }
    }

    #[test]
    fn the_repositories_most_in_need_come_first() {
        let repo = |name: &str, code: SeverityCounts, vulnerabilities: SeverityCounts| RepoCoverage {
            name: name.into(),
            code,
            vulnerabilities,
            ..RepoCoverage::default()
        };
        let mut repos = vec![repo("a", counts(0, 1), counts(0, 0)), repo("b", counts(1, 0), counts(0, 0)), repo("c", counts(0, 3), counts(0, 1))];
        rank(&mut repos);
        let order: Vec<&str> = repos.iter().map(|repo| repo.name.as_str()).collect();
        assert_eq!(order, ["b", "c", "a"]);
    }

    #[test]
    fn a_trend_has_every_day_and_sums_each_type() {
        let today = 1_791_374_400_000; // 2026-10-07T12:00:00Z
        let span = days(today, 3);
        assert_eq!(span, ["2026-10-05", "2026-10-06", "2026-10-07"]);
        let row = |day: &str, kind: &str, critical| SnapshotRow {
            day: day.into(),
            alert_type: kind.into(),
            critical,
            high: 1,
            medium: 0,
            low: 0,
            unknown: 0,
        };
        let points = trend(&span, &[row("2026-10-06", "code_scanning", 2), row("2026-10-06", "vulnerability", 0), row("2026-10-07", "code_scanning", 1)]);
        assert_eq!(points.len(), 3);
        assert_eq!((points[0].code_scanning, points[1].code_scanning, points[1].vulnerability, points[2].code_scanning), (0, 3, 1, 2));
    }
}
