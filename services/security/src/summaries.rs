//! One event per scan per alert type, for the inbox: what the scan opened,
//! what it fixed, and what is left open, with the worst severity among the
//! new alerts and the newest one's title. The inbox keeps one thread per
//! repository and type from these (`<repo>/security/vulnerabilities`), so a
//! scan that finds forty vulnerabilities is one item and the next scan
//! brings the same item up to date; the per-alert `.created` and `.fixed`
//! events stay for webhooks (`g1t_contracts::security_suite::SecuritySummary`).

use g1t_contracts::security::SeverityCounts;
use g1t_contracts::security_suite::{AlertType, MAX_SUMMARY_IDS, SecuritySummary};
use worker::Result;

use crate::Security;
use crate::store::RepoRow;
use crate::suite::link;

/// What one scan changed, as the modules report it.
#[derive(Debug, Default)]
pub struct Changed<'a> {
    /// `push`, `history`, `dependencies`, `analysis` or `change`.
    pub scan: &'a str,
    /// Every alert it opened, newest first.
    pub opened: Vec<String>,
    /// Every alert it closed as fixed.
    pub fixed: Vec<String>,
    pub dismissed: u32,
    /// Who pushed, when push protection refused the push.
    pub pusher: Option<&'a str>,
    /// How many secrets stopped that push.
    pub blocked: u32,
}

/// Lower is worse.
fn rank(severity: &str) -> u8 {
    match severity {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

/// The worst of some severities, or none.
pub fn worst<'a>(severities: impl Iterator<Item = &'a str>) -> Option<String> {
    severities.min_by_key(|severity| rank(severity)).map(str::to_owned)
}

/// Severities counted.
pub fn count<'a>(severities: impl Iterator<Item = &'a str>) -> SeverityCounts {
    let mut counts = SeverityCounts::default();
    for severity in severities {
        match severity {
            "critical" => counts.critical += 1,
            "high" => counts.high += 1,
            "medium" => counts.medium += 1,
            "low" => counts.low += 1,
            _ => counts.unknown += 1,
        }
    }
    counts
}

/// The summary of a scan, from what it changed, the new alerts (severity
/// and title, newest first) and what is open after it. Pure.
pub fn shape(repo: &RepoRow, alert_type: AlertType, changed: &Changed<'_>, news: &[(String, String)], open: SeverityCounts) -> SecuritySummary {
    SecuritySummary {
        repo_id: repo.repo_id.clone(),
        alert_type: alert_type.as_str().to_owned(),
        scan: changed.scan.to_owned(),
        opened: changed.opened.iter().take(MAX_SUMMARY_IDS).cloned().collect(),
        opened_count: changed.opened.len() as u32,
        fixed: changed.fixed.iter().take(MAX_SUMMARY_IDS).cloned().collect(),
        fixed_count: changed.fixed.len() as u32,
        dismissed_count: changed.dismissed,
        new_by_severity: count(news.iter().map(|(severity, _)| severity.as_str())),
        open,
        worst: worst(news.iter().map(|(severity, _)| severity.as_str())),
        latest: news.first().map(|(_, title)| title.clone()),
        link: link(repo, alert_type.page()),
        pusher: changed.pusher.map(str::to_owned),
        blocked: changed.blocked,
        notify: Vec::new(),
    }
}

impl Security {
    /// Publishes what a scan changed, once, unless it changed nothing.
    pub(crate) async fn summarize(&self, repo: &RepoRow, alert_type: AlertType, changed: Changed<'_>, actor_id: Option<String>) -> Result<()> {
        if changed.opened.is_empty() && changed.fixed.is_empty() && changed.dismissed == 0 && changed.scan != "change" {
            return Ok(());
        }
        let mut news = Vec::with_capacity(changed.opened.len().min(MAX_SUMMARY_IDS));
        for id in changed.opened.iter().take(MAX_SUMMARY_IDS) {
            let found = match alert_type {
                AlertType::SecretScanning => self.store.secret(&repo.repo_id, id).await?.map(|secret| {
                    let event = crate::secret_alerts::secret_event(repo, &secret);
                    (event.severity, event.title)
                }),
                AlertType::CodeScanning => self.store.code_alert_by_id(&repo.repo_id, id).await?.map(|alert| {
                    let event = crate::code_scanning::code_event(repo, &alert);
                    (event.severity, event.title)
                }),
                AlertType::Vulnerability => self.store.vulnerability(&repo.repo_id, id).await?.map(|vuln| {
                    let event = crate::deps::vulnerability_event(repo, &vuln);
                    (event.severity, event.title)
                }),
            };
            if let Some(news_item) = found {
                news.push(news_item);
            }
        }
        // The worst new alert is the headline, whatever order the scan found them in.
        news.sort_by_key(|(severity, _)| rank(severity));
        let open = self.open_counts(repo, alert_type).await?;
        let summary = shape(repo, alert_type, &changed, &news, open);
        self.publish_summary(alert_type.summary_event(), repo, &summary, actor_id).await;
        Ok(())
    }

    /// What is open of one type, by severity. A secret in the history that
    /// looks real, or stopped at a push and not yet decided, is critical; a
    /// likely test value is low.
    pub(crate) async fn open_counts(&self, repo: &RepoRow, alert_type: AlertType) -> Result<SeverityCounts> {
        Ok(match alert_type {
            AlertType::SecretScanning => {
                let secrets = self.store.secret_counts(&repo.repo_id).await?;
                SeverityCounts { critical: secrets.open + secrets.blocked, low: secrets.test_values, ..SeverityCounts::default() }
            }
            AlertType::CodeScanning => self.store.code_counts(&repo.repo_id).await?,
            AlertType::Vulnerability => {
                let rows = self.store.open_vulnerabilities(&repo.repo_id).await?;
                count(rows.iter().map(|row| row.severity.as_str()))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> RepoRow {
        RepoRow {
            repo_id: "rep_1".into(),
            namespace: "acme".into(),
            name: "rocket".into(),
            upkeep: 1,
            history: "done".into(),
            history_cursor: None,
            history_commits: 0,
            history_finished_at: None,
            deps_scanned_at: None,
            deps_error: None,
            lockfiles: "[]".into(),
            version_updates: None,
        }
    }

    #[test]
    fn a_scan_is_one_summary_with_counts_the_worst_and_the_newest() {
        let changed = Changed { scan: "dependencies", opened: vec!["vul_3".into(), "vul_2".into(), "vul_1".into()], fixed: vec!["vul_0".into()], ..Changed::default() };
        let news = vec![
            ("high".to_owned(), "lodash 4.17.20 in package-lock.json: GHSA-1".to_owned()),
            ("critical".to_owned(), "minimist 1.2.5 in package-lock.json: GHSA-2".to_owned()),
            ("low".to_owned(), "ms 2.0.0 in package-lock.json: GHSA-3".to_owned()),
        ];
        let open = SeverityCounts { critical: 1, high: 2, ..SeverityCounts::default() };
        let summary = shape(&repo(), AlertType::Vulnerability, &changed, &news, open);
        assert_eq!(summary.opened_count, 3);
        assert_eq!(summary.fixed, vec!["vul_0"]);
        assert_eq!(summary.worst.as_deref(), Some("critical"));
        assert_eq!(summary.latest.as_deref(), Some("lodash 4.17.20 in package-lock.json: GHSA-1"));
        assert_eq!((summary.new_by_severity.critical, summary.new_by_severity.high, summary.new_by_severity.low), (1, 1, 1));
        assert_eq!(summary.link, "/acme/rocket/security/vulnerabilities");
        assert_eq!(summary.open_total(), 3);
        assert!(summary.urgent());
    }

    #[test]
    fn the_id_lists_are_capped_but_the_counts_are_not() {
        let opened: Vec<String> = (0..500).map(|n| format!("cod_{n}")).collect();
        let changed = Changed { scan: "analysis", opened, ..Changed::default() };
        let summary = shape(&repo(), AlertType::CodeScanning, &changed, &[], SeverityCounts::default());
        assert_eq!(summary.opened.len(), MAX_SUMMARY_IDS);
        assert_eq!(summary.opened_count, 500);
        assert!(summary.worst.is_none() && summary.latest.is_none());
        assert!(!summary.urgent());
    }

    #[test]
    fn a_refused_push_is_urgent_whatever_was_found() {
        let changed = Changed { scan: "push", opened: vec!["sec_1".into()], pusher: Some("bo"), blocked: 1, ..Changed::default() };
        let summary = shape(&repo(), AlertType::SecretScanning, &changed, &[("low".into(), "An example key in README.md".into())], SeverityCounts::default());
        assert_eq!(summary.pusher.as_deref(), Some("bo"));
        assert!(summary.urgent());
        assert_eq!(worst(["low", "medium", "high"].into_iter()).as_deref(), Some("high"));
        assert_eq!(worst(std::iter::empty()), None);
    }
}
