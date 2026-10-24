//! The security digest: security alerts that are not urgent (medium and
//! low) wait here for each person's next digest, once a day or once a week
//! as they chose (`InboxSettings::security_digest`), and go out as one
//! inbox item and one email per workspace: "Security digest for acme: 4
//! new medium vulnerabilities in 2 repositories, 1 new low secret in 1
//! repository". Critical and high alerts, refused pushes and vulnerability
//! reports never wait here (inbox.rs decides, `security_delivery`).
//!
//! The cron (wrangler.jsonc, `DIGEST_CRON`) runs once a day in the morning,
//! UTC; daily digests go out on every run, weekly ones on Monday's. Rows
//! are deleted as their digest goes out, so a retried run sends nothing
//! twice; a person whose cadence became "at once" or "off" after rows were
//! queued gets what waited once, in a digest, rather than losing it.

use std::collections::BTreeMap;

use g1t_contracts::inbox::{DigestCadence, Reason, Severity};
use g1t_contracts::new_id;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::SeverityCounts;
use g1t_contracts::security_suite::{AlertType, SecuritySummary};
use g1t_contracts::time::rfc3339;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Fetcher, Result};

use crate::inbox::{self, Notice};
use crate::subscriptions;

/// The cron that sends digests: 08:00 UTC daily.
pub const DIGEST_CRON: &str = "0 8 * * *";
/// Rows read per run, at most.
const BATCH: u32 = 5000;
/// What the digest's inbox item records as its event type.
const EVENT: &str = "security.digest";

/// One scan summary waiting for a person's digest.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Queued {
    pub id: String,
    pub username: String,
    pub workspace: String,
    pub repo_id: String,
    pub repo: String,
    pub alert_type: String,
    pub opened: f64,
    /// JSON `SeverityCounts`.
    pub counts: String,
    pub worst: Option<String>,
    pub title: String,
    pub link: String,
}

/// The statement that queues a summary for one person's digest.
pub fn queue(
    db: &D1Database,
    username: &str,
    path: &RepoPath,
    summary: &SecuritySummary,
    event_id: &str,
    now_ms: u64,
) -> Result<D1PreparedStatement> {
    db.prepare(
        "INSERT OR IGNORE INTO inbox_security_digest
           (id, username, workspace, repo_id, repo, alert_type, event_id, opened, counts, worst, title, link, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        new_id("dig", now_ms).into(),
        username.to_lowercase().into(),
        path.namespace.to_lowercase().into(),
        summary.repo_id.as_str().into(),
        format!("{}/{}", path.namespace, path.name).to_lowercase().into(),
        summary.alert_type.as_str().into(),
        event_id.into(),
        summary.opened_count.into(),
        serde_json::to_string(&summary.new_by_severity)?.into(),
        summary.worst.as_deref().map_or(JsValue::NULL, JsValue::from),
        summary.latest.as_deref().unwrap_or_default().into(),
        summary.link.as_str().into(),
        rfc3339(now_ms).into(),
    ])
}

/// The day of the week at `now_ms`: 0 is Sunday. 1970-01-01 was a Thursday.
pub fn weekday(now_ms: u64) -> u8 {
    ((now_ms / 86_400_000 + 4) % 7) as u8
}

/// Whether a person's digest goes out on this run: daily ones every day,
/// weekly ones on Monday; what waited for someone who since chose "at
/// once" or "off" goes out too, once, rather than being lost.
pub fn due(cadence: DigestCadence, weekday: u8) -> bool {
    match cadence {
        DigestCadence::Daily | DigestCadence::AtOnce | DigestCadence::Off => true,
        DigestCadence::Weekly => weekday == 1,
    }
}

/// "vulnerability" or "vulnerabilities".
fn what(alert_type: &str, n: u32) -> &'static str {
    match (AlertType::parse(alert_type), n) {
        (Some(AlertType::SecretScanning), 1) => "secret",
        (Some(AlertType::SecretScanning), _) => "secrets",
        (Some(AlertType::CodeScanning), 1) => "code scanning alert",
        (Some(AlertType::CodeScanning), _) => "code scanning alerts",
        (_, 1) => "vulnerability",
        _ => "vulnerabilities",
    }
}

/// "in 2 repositories".
fn in_repos(n: usize) -> String {
    if n == 1 { "in 1 repository".to_owned() } else { format!("in {n} repositories") }
}

/// The digest's title and body for one workspace's rows: the title counts
/// what is new per severity and alert type, worst first; the body names up
/// to five of the alerts, newest first, each with its repository.
pub fn digest_text(workspace: &str, rows: &[Queued]) -> (String, String) {
    // (severity rank, alert type) -> (count, repositories)
    let mut groups: BTreeMap<(u8, &str), (u32, std::collections::BTreeSet<&str>)> = BTreeMap::new();
    for row in rows {
        let counts: SeverityCounts = serde_json::from_str(&row.counts).unwrap_or_default();
        for (rank, severity, n) in [
            (0u8, "critical", counts.critical),
            (1, "high", counts.high),
            (2, "medium", counts.medium),
            (3, "low", counts.low),
            (4, "", counts.unknown),
        ] {
            if n == 0 {
                continue;
            }
            let _ = severity;
            let group = groups.entry((rank, row.alert_type.as_str())).or_default();
            group.0 += n;
            group.1.insert(row.repo.as_str());
        }
    }
    let parts: Vec<String> = groups
        .iter()
        .map(|((rank, alert_type), (n, repos))| {
            let severity = match rank {
                0 => "critical ",
                1 => "high ",
                2 => "medium ",
                3 => "low ",
                _ => "",
            };
            format!("{n} new {severity}{} {}", what(alert_type, *n), in_repos(repos.len()))
        })
        .collect();
    let total: u32 = rows.iter().map(|row| row.opened as u32).sum();
    let title = if parts.is_empty() {
        format!("Security digest for {workspace}: {total} new security alerts")
    } else {
        format!("Security digest for {workspace}: {}", parts.join(", "))
    };
    let mut named: Vec<String> =
        rows.iter().rev().filter(|row| !row.title.is_empty()).take(5).map(|row| format!("{}: {}", row.repo, row.title)).collect();
    if rows.len() > named.len() && !named.is_empty() {
        named.push(format!("and {} more", rows.iter().filter(|row| !row.title.is_empty()).count().saturating_sub(named.len())));
    }
    (title, named.join(" · "))
}

/// Sends every digest that is due, and returns how many went out.
pub async fn send_due(db: &D1Database, identity: &Fetcher, notify: Option<&Fetcher>, now_ms: u64) -> Result<u32> {
    let rows = db
        .prepare(
            "SELECT id, username, workspace, repo_id, repo, alert_type, opened, counts, worst, title, link
             FROM inbox_security_digest ORDER BY username, workspace, created_at LIMIT ?",
        )
        .bind(&[BATCH.into()])?
        .all()
        .await?
        .results::<Queued>()?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut by_person: BTreeMap<String, Vec<Queued>> = BTreeMap::new();
    for row in rows {
        by_person.entry(row.username.clone()).or_default().push(row);
    }
    let people: Vec<String> = by_person.keys().cloned().collect();
    let settings = subscriptions::settings_of(db, &people).await?;
    let today = weekday(now_ms);
    let now = rfc3339(now_ms);
    let mut sent = 0;
    for (username, rows) in by_person {
        let setting = settings.get(&username).cloned().unwrap_or_default();
        if !due(setting.security_digest, today) {
            continue;
        }
        let mut by_workspace: BTreeMap<String, Vec<Queued>> = BTreeMap::new();
        for row in rows {
            by_workspace.entry(row.workspace.clone()).or_default().push(row);
        }
        for (workspace, rows) in by_workspace {
            let (title, body) = digest_text(&workspace, &rows);
            let notice = Notice { username: username.clone(), reason: Reason::SecurityAlert, severity: Severity::Info, title, body };
            let thread = format!("workspace:{workspace}/security/digest");
            let link = format!("/{workspace}/-/security");
            let event_id = new_id("dig", now_ms);
            let mut statements = vec![
                db.prepare(inbox::BUMP).bind(&[
                    new_id("ntf", now_ms).into(),
                    username.as_str().into(),
                    thread.as_str().into(),
                    event_id.as_str().into(),
                    EVENT.into(),
                    notice.reason.as_str().into(),
                    notice.severity.as_str().into(),
                    notice.title.as_str().into(),
                    notice.body.as_str().into(),
                    workspace.as_str().into(),
                    JsValue::NULL,
                    JsValue::NULL,
                    JsValue::NULL,
                    JsValue::NULL,
                    JsValue::NULL,
                    link.as_str().into(),
                    JsValue::NULL,
                    now.as_str().into(),
                    new_id("ntf", now_ms).into(),
                ])?,
                db.prepare(
                    "INSERT OR IGNORE INTO inbox_activity (id, item_id, username, event_id, event, reason, severity, title, body, actor, created_at)
                     SELECT ?1, id, ?2, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10 FROM inbox_items WHERE username = ?2 AND thread = ?3",
                )
                .bind(&[
                    new_id("ntf", now_ms).into(),
                    username.as_str().into(),
                    thread.as_str().into(),
                    event_id.as_str().into(),
                    EVENT.into(),
                    notice.reason.as_str().into(),
                    notice.severity.as_str().into(),
                    notice.title.as_str().into(),
                    notice.body.as_str().into(),
                    now.as_str().into(),
                ])?,
            ];
            let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
            statements.push(
                db.prepare("DELETE FROM inbox_security_digest WHERE id IN (SELECT value FROM json_each(?))")
                    .bind(&[serde_json::to_string(&ids)?.into()])?,
            );
            db.batch(statements).await?;
            sent += 1;
            if let Some(notify) = notify {
                inbox::tell_live(
                    notify,
                    vec![(username.clone(), inbox::live_notification(&event_id, &notice, &link, &now, Some(&thread)))],
                )
                .await;
                inbox::tell_inbox_count(db, notify, &username).await;
            }
            // Emailed as a security alert, to someone who can still read the
            // first repository named: identity checks that, as for any item.
            if setting.email.contains(&Reason::SecurityAlert)
                && let Some(first) = rows.first()
            {
                let sent_mail: Result<bool> = g1t_kit::call(
                    identity,
                    "notify_by_email",
                    &g1t_contracts::inbox::NotifyByEmailArgs {
                        username: username.clone(),
                        repo_id: Some(first.repo_id.clone()),
                        workspace: None,
                        subject: notice.title.clone(),
                        intro: notice.body.clone(),
                        quote: None,
                        path: link.clone(),
                        reason: Reason::SecurityAlert,
                    },
                )
                .await;
                if let Err(error) = sent_mail {
                    worker::console_error!("security digest: email to {username} not sent: {error}");
                }
            }
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(repo: &str, alert_type: &str, counts: &str, title: &str) -> Queued {
        Queued {
            id: "dig_1".into(),
            username: "ana".into(),
            workspace: "acme".into(),
            repo_id: "rep_1".into(),
            repo: repo.into(),
            alert_type: alert_type.into(),
            opened: 1.0,
            counts: counts.into(),
            worst: None,
            title: title.into(),
            link: "/acme/rocket/security/vulnerabilities".into(),
        }
    }

    #[test]
    fn the_digest_counts_what_is_new_worst_first_across_repositories() {
        let rows = vec![
            row(
                "acme/rocket",
                "vulnerability",
                r#"{"critical":0,"high":0,"medium":3,"low":0,"unknown":0}"#,
                "lodash 4.17.20 in package-lock.json: GHSA-1",
            ),
            row(
                "acme/probe",
                "vulnerability",
                r#"{"critical":0,"high":0,"medium":1,"low":0,"unknown":0}"#,
                "ms 2.0.0 in package-lock.json: GHSA-2",
            ),
            row(
                "acme/rocket",
                "secret_scanning",
                r#"{"critical":0,"high":0,"medium":0,"low":1,"unknown":0}"#,
                "An example key in README.md",
            ),
        ];
        let (title, body) = digest_text("acme", &rows);
        assert_eq!(title, "Security digest for acme: 4 new medium vulnerabilities in 2 repositories, 1 new low secret in 1 repository");
        assert!(body.starts_with("acme/rocket: An example key in README.md · acme/probe: ms 2.0.0"));
        assert!(!body.contains("and "));
    }

    #[test]
    fn weekly_digests_go_out_on_mondays_and_nothing_queued_is_lost() {
        // 2026-10-12 is a Monday; 2026-10-11 a Sunday.
        let monday = 1_791_763_200_000;
        assert_eq!(weekday(monday), 1);
        assert_eq!(weekday(monday - 86_400_000), 0);
        assert!(due(DigestCadence::Weekly, 1) && !due(DigestCadence::Weekly, 0));
        assert!(due(DigestCadence::Daily, 0) && due(DigestCadence::Off, 3) && due(DigestCadence::AtOnce, 5));
    }

    #[test]
    fn a_digest_of_many_names_five_and_counts_the_rest() {
        let rows: Vec<Queued> = (0..8)
            .map(|n| {
                row(
                    &format!("acme/r{n}"),
                    "code_scanning",
                    r#"{"critical":0,"high":0,"medium":1,"low":0,"unknown":0}"#,
                    &format!("Rule {n}"),
                )
            })
            .collect();
        let (title, body) = digest_text("acme", &rows);
        assert_eq!(title, "Security digest for acme: 8 new medium code scanning alerts in 8 repositories");
        assert!(body.ends_with("and 3 more"));
    }
}
