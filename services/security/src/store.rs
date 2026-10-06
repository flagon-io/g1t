//! The security service's tables in D1.

use std::collections::HashMap;

use g1t_contracts::security::{
    AlertActivity, DismissReason, NewSecret, ScanState, SecretCounts, SecretFinding, SecretStatus, SecurityUpdate,
    SeverityCounts, UpdateState, VersionUpdatesState, VulnStatus, Vulnerability,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::new_id;
use g1t_kit::now_ms;
use g1t_scan::secrets::SecretKind;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Result};

pub fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

pub fn now() -> String {
    rfc3339(now_ms())
}

/// A repository purged (`repo.purged`): every row kept for it, `?1` its
/// id. Advisories are shared by every repository, so they stay.
pub const PURGED: &[&str] = &[
    "DELETE FROM secrets WHERE repo_id = ?1",
    "DELETE FROM vulnerabilities WHERE repo_id = ?1",
    "DELETE FROM upgrades WHERE repo_id = ?1",
    "DELETE FROM updates WHERE repo_id = ?1",
    "DELETE FROM alert_activity WHERE repo_id = ?1",
    "DELETE FROM push_scans WHERE repo_id = ?1",
    "DELETE FROM repos WHERE repo_id = ?1",
];

#[derive(Clone, Deserialize)]
pub struct RepoRow {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub upkeep: i64,
    pub history: String,
    pub history_cursor: Option<String>,
    pub history_commits: i64,
    pub history_finished_at: Option<String>,
    pub deps_scanned_at: Option<String>,
    pub deps_error: Option<String>,
    pub lockfiles: String,
    #[serde(default)]
    pub version_updates: Option<String>,
}

impl RepoRow {
    pub fn scan_state(&self) -> ScanState {
        ScanState {
            history: self.history.clone(),
            commits_scanned: self.history_commits.max(0) as u32,
            history_finished_at: self.history_finished_at.clone(),
            dependencies_scanned_at: self.deps_scanned_at.clone(),
            dependencies_error: self.deps_error.clone(),
            lockfiles: serde_json::from_str(&self.lockfiles).unwrap_or_default(),
        }
    }

    /// What `.g1t/dependencies.yml` said when it was last read.
    pub fn version_updates(&self) -> VersionUpdatesState {
        self.version_updates
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default()
    }
}

#[derive(Deserialize)]
struct SecretRow {
    id: String,
    repo_id: String,
    kind: String,
    path: String,
    line: i64,
    commit_hash: String,
    preview: String,
    status: String,
    source: String,
    found_by: Option<String>,
    found_at: String,
    decided_by: Option<String>,
    reason: Option<String>,
    decided_at: Option<String>,
    dismiss_reason: Option<String>,
    test_value: Option<String>,
}

impl From<SecretRow> for SecretFinding {
    fn from(row: SecretRow) -> Self {
        let status = SecretStatus::parse(&row.status).unwrap_or(SecretStatus::Open);
        SecretFinding {
            label: SecretKind::parse(&row.kind).map_or("a secret", |kind| kind.label()).to_owned(),
            id: row.id,
            repo_id: row.repo_id,
            kind: row.kind,
            path: row.path,
            line: row.line.max(0) as u32,
            commit: row.commit_hash,
            preview: row.preview,
            status,
            source: row.source,
            found_by: row.found_by,
            found_at: row.found_at,
            decided_by: row.decided_by,
            reason: row.reason,
            decided_at: row.decided_at,
            dismissed_reason: row.dismiss_reason.as_deref().and_then(DismissReason::parse),
            test_value: row.test_value,
            state: status.state(),
        }
    }
}

#[derive(Deserialize)]
pub struct VulnRow {
    pub id: String,
    pub repo_id: String,
    pub ecosystem: String,
    pub package: String,
    pub version: String,
    pub manifest: String,
    pub osv_id: String,
    pub advisory: String,
    pub summary: String,
    pub severity: String,
    pub fixed_version: Option<String>,
    pub status: String,
    pub found_at: String,
    pub fixed_at: Option<String>,
    pub number: Option<i64>,
    #[serde(default)]
    pub dismiss_reason: Option<String>,
    #[serde(default)]
    pub dismiss_comment: Option<String>,
    #[serde(default)]
    pub dismissed_by: Option<String>,
    #[serde(default)]
    pub dismissed_at: Option<String>,
}

impl From<VulnRow> for Vulnerability {
    fn from(row: VulnRow) -> Self {
        let status = VulnStatus::parse(&row.status).unwrap_or(VulnStatus::Open);
        let dismissed = status == VulnStatus::Dismissed;
        Vulnerability {
            id: row.id,
            repo_id: row.repo_id,
            ecosystem: row.ecosystem,
            package: row.package,
            version: row.version,
            manifest: row.manifest,
            advisory: row.advisory,
            osv_id: row.osv_id,
            summary: row.summary,
            severity: row.severity,
            fixed_version: row.fixed_version,
            status,
            issue: row.number.map(|number| number as u32),
            found_at: row.found_at,
            fixed_at: row.fixed_at,
            state: status.state(),
            dismissed_by: row.dismissed_by.filter(|_| dismissed),
            dismissed_reason: row.dismiss_reason.as_deref().and_then(DismissReason::parse).filter(|_| dismissed),
            dismissed_comment: row.dismiss_comment.filter(|_| dismissed),
            dismissed_at: row.dismissed_at.filter(|_| dismissed),
            update: None,
        }
    }
}

/// A security update, as stored.
#[derive(Clone, Deserialize)]
pub struct UpdateRow {
    pub repo_id: String,
    pub ecosystem: String,
    pub package: String,
    pub target: String,
    pub state: String,
    pub branch: Option<String>,
    pub pull: Option<i64>,
    pub issue: Option<i64>,
    pub error: Option<String>,
    pub updated_at: String,
}

impl UpdateRow {
    pub fn state(&self) -> UpdateState {
        UpdateState::parse(&self.state).unwrap_or(UpdateState::Failed)
    }

    pub fn pull(&self) -> Option<u32> {
        self.pull.map(|n| n.max(0) as u32)
    }

    pub fn issue(&self) -> Option<u32> {
        self.issue.map(|n| n.max(0) as u32)
    }

    pub fn to_contract(&self) -> SecurityUpdate {
        SecurityUpdate {
            state: self.state(),
            target: self.target.clone(),
            branch: self.branch.clone(),
            pull: self.pull(),
            issue: self.issue(),
            error: self.error.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Deserialize)]
struct ActivityRow {
    id: String,
    alert_id: String,
    action: String,
    actor: Option<String>,
    reason: Option<String>,
    comment: Option<String>,
    number: Option<i64>,
    at: String,
}

impl From<ActivityRow> for AlertActivity {
    fn from(row: ActivityRow) -> Self {
        AlertActivity {
            id: row.id,
            alert_id: row.alert_id,
            action: row.action,
            actor: row.actor,
            reason: row.reason.as_deref().and_then(DismissReason::parse),
            comment: row.comment,
            number: row.number.map(|n| n.max(0) as u32),
            at: row.at,
        }
    }
}

/// A push too large to scan before it was stored, scanned after it landed.
#[derive(Clone, Deserialize)]
pub struct PushScanRow {
    pub id: String,
    pub repo_id: String,
    pub git_ref: String,
    pub head: String,
    pub base: Option<String>,
    pub cursor: Option<String>,
    pub pusher: Option<String>,
    pub pages: i64,
}

/// One action on an alert, to record.
pub struct Activity<'a> {
    pub alert_id: &'a str,
    pub action: &'a str,
    pub actor: Option<&'a str>,
    pub reason: Option<DismissReason>,
    pub comment: Option<&'a str>,
    pub number: Option<u32>,
}

#[derive(Deserialize)]
pub struct UpgradeRow {
    pub number: i64,
}

#[derive(Deserialize)]
struct CountRow {
    severity: String,
    n: i64,
}

#[derive(Deserialize)]
struct SecretCountRow {
    status: String,
    test: i64,
    n: i64,
}

#[derive(Deserialize)]
struct NumberRow {
    n: i64,
}

#[derive(Deserialize)]
struct FingerprintRow {
    fingerprint: String,
    id: String,
    status: String,
}

#[derive(Deserialize)]
struct BodyRow {
    body: String,
    fetched_at: String,
}

pub struct Store {
    pub db: D1Database,
}

const VULN_COLUMNS: &str = "v.id, v.repo_id, v.ecosystem, v.package, v.version, v.manifest, v.osv_id, v.advisory,
    v.summary, v.severity, v.fixed_version, v.status, v.found_at, v.fixed_at, v.dismiss_reason, v.dismiss_comment,
    v.dismissed_by, v.dismissed_at, COALESCE(n.issue, u.number) AS number";

/// The issue an upgrade has: the security update's, when it went to
/// g1t, or one opened before security updates.
const VULN_JOINS: &str = "LEFT JOIN upgrades u ON u.repo_id = v.repo_id AND u.ecosystem = v.ecosystem AND u.package = v.package
    LEFT JOIN updates n ON n.repo_id = v.repo_id AND n.ecosystem = v.ecosystem AND n.package = v.package";

impl Store {
    pub async fn repo(&self, repo_id: &str) -> Result<Option<RepoRow>> {
        self.db
            .prepare("SELECT * FROM repos WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<RepoRow>(None)
            .await
    }

    /// Records a repository the first time it is seen, and keeps its
    /// address current. Returns its row.
    pub async fn register(&self, repo_id: &str, namespace: &str, name: &str) -> Result<RepoRow> {
        self.db
            .prepare(
                "INSERT INTO repos (repo_id, namespace, name, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (repo_id) DO UPDATE SET namespace = ?2, name = ?3",
            )
            .bind(&[repo_id.into(), namespace.into(), name.into(), now().into()])?
            .run()
            .await?;
        self.repo(repo_id)
            .await?
            .ok_or_else(|| worker::Error::RustError("the repository was not recorded".into()))
    }

    /// A repository's path changed: transferred or renamed.
    pub async fn moved(&self, repo_id: &str, namespace: &str, name: &str) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET namespace = ?, name = ? WHERE repo_id = ?")
            .bind(&[namespace.into(), name.into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn rename_namespace(&self, stale: &[String], current: &str) -> Result<()> {
        for slug in stale {
            self.db
                .prepare("UPDATE repos SET namespace = ? WHERE namespace = ?")
                .bind(&[current.into(), slug.as_str().into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    pub async fn in_namespace(&self, namespace: &str) -> Result<Vec<RepoRow>> {
        self.db
            .prepare("SELECT * FROM repos WHERE namespace = ? ORDER BY name")
            .bind(&[namespace.into()])?
            .all()
            .await?
            .results::<RepoRow>()
    }

    /// A repository purged: everything found in it goes. `?1` its id.
    pub async fn purge(&self, repo_id: &str) -> Result<()> {
        let mut batch = Vec::with_capacity(PURGED.len());
        for sql in PURGED {
            batch.push(self.db.prepare(*sql).bind(&[repo_id.into()])?);
        }
        self.db.batch(batch).await?;
        Ok(())
    }

    /// Records that a repository's daily dependency read was skipped, and
    /// why, so the sweep moves on to others until the next day.
    pub async fn skip_dependencies(&self, repo_id: &str, why: &str) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET deps_scanned_at = ?, deps_error = ? WHERE repo_id = ?")
            .bind(&[now().into(), why.into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Repositories whose history still has to be scanned, oldest first.
    pub async fn unfinished_histories(&self, limit: u32) -> Result<Vec<RepoRow>> {
        self.db
            .prepare("SELECT * FROM repos WHERE history IN ('pending', 'running', 'stopped') ORDER BY created_at LIMIT ?")
            .bind(&[limit.into()])?
            .all()
            .await?
            .results::<RepoRow>()
    }

    /// Repositories whose dependencies were last read before `before`.
    pub async fn stale_dependencies(&self, before: &str, limit: u32) -> Result<Vec<RepoRow>> {
        self.db
            .prepare(
                "SELECT * FROM repos WHERE deps_scanned_at IS NULL OR deps_scanned_at < ?
                 ORDER BY deps_scanned_at LIMIT ?",
            )
            .bind(&[before.into(), limit.into()])?
            .all()
            .await?
            .results::<RepoRow>()
    }

    pub async fn set_history(&self, repo_id: &str, state: &str, cursor: Option<&str>, commits: u32) -> Result<()> {
        let finished = (state == "done").then(now);
        self.db
            .prepare(
                "UPDATE repos SET history = ?, history_cursor = ?, history_commits = history_commits + ?,
                   history_finished_at = COALESCE(?, history_finished_at)
                 WHERE repo_id = ?",
            )
            .bind(&[state.into(), optional(cursor), commits.into(), optional(finished.as_deref()), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn restart_history(&self, repo_id: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE repos SET history = 'pending', history_cursor = NULL, history_commits = 0,
                   history_finished_at = NULL WHERE repo_id = ?",
            )
            .bind(&[repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_dependencies_scanned(
        &self,
        repo_id: &str,
        commit: Option<&str>,
        lockfiles: &[String],
        error: Option<&str>,
    ) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET deps_scanned_at = ?, deps_commit = ?, lockfiles = ?, deps_error = ? WHERE repo_id = ?")
            .bind(&[now().into(), optional(commit), serde_json::to_string(lockfiles)?.into(), optional(error), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_version_updates(&self, repo_id: &str, state: &VersionUpdatesState) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET version_updates = ? WHERE repo_id = ?")
            .bind(&[serde_json::to_string(state)?.into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_upkeep(&self, repo_id: &str, enabled: bool, by: &str) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET upkeep = ?, upkeep_by = ?, upkeep_at = ? WHERE repo_id = ?")
            .bind(&[i32::from(enabled).into(), by.into(), now().into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    // --- Secrets ------------------------------------------------------------

    pub async fn secrets(&self, repo_id: &str) -> Result<Vec<SecretFinding>> {
        let rows = self
            .db
            .prepare(
                "SELECT * FROM secrets WHERE repo_id = ?
                 ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'blocked' THEN 1 WHEN 'allowed' THEN 2 ELSE 3 END,
                   test_value IS NOT NULL, found_at DESC LIMIT 500",
            )
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<SecretRow>()?;
        Ok(rows.into_iter().map(SecretFinding::from).collect())
    }

    pub async fn secret(&self, repo_id: &str, id: &str) -> Result<Option<SecretFinding>> {
        Ok(self
            .db
            .prepare("SELECT * FROM secrets WHERE repo_id = ? AND id = ?")
            .bind(&[repo_id.into(), id.into()])?
            .first::<SecretRow>(None)
            .await?
            .map(SecretFinding::from))
    }

    /// The findings already known for these fingerprints: fingerprint, id
    /// and status.
    pub async fn known(&self, repo_id: &str, fingerprints: &[String]) -> Result<Vec<(String, String, String)>> {
        let mut known = Vec::new();
        for chunk in fingerprints.chunks(90) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut binds: Vec<JsValue> = vec![repo_id.into()];
            binds.extend(chunk.iter().map(|fingerprint| JsValue::from(fingerprint.as_str())));
            let rows = self
                .db
                .prepare(format!("SELECT fingerprint, id, status FROM secrets WHERE repo_id = ? AND fingerprint IN ({marks})"))
                .bind(&binds)?
                .all()
                .await?
                .results::<FingerprintRow>()?;
            known.extend(rows.into_iter().map(|row| (row.fingerprint, row.id, row.status)));
        }
        Ok(known)
    }

    /// Records secrets not seen before in this repository, with `status`.
    /// A secret already known keeps its record and its decision.
    pub async fn add_secrets(
        &self,
        repo_id: &str,
        secrets: &[NewSecret],
        status: SecretStatus,
        source: &str,
        found_by: Option<&str>,
    ) -> Result<()> {
        if secrets.is_empty() {
            return Ok(());
        }
        let now_ms = now_ms();
        let found_at = rfc3339(now_ms);
        let statements = secrets
            .iter()
            .map(|secret| {
                self.db
                    .prepare(
                        "INSERT INTO secrets (id, repo_id, fingerprint, kind, path, line, commit_hash, preview,
                           status, source, found_by, found_at, test_value)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (repo_id, fingerprint) DO UPDATE SET test_value = excluded.test_value",
                    )
                    .bind(&[
                        new_id("sec", now_ms).into(),
                        repo_id.into(),
                        secret.fingerprint.as_str().into(),
                        secret.kind.as_str().into(),
                        secret.path.as_str().into(),
                        secret.line.into(),
                        secret.commit.as_str().into(),
                        secret.preview.as_str().into(),
                        status.as_str().into(),
                        source.into(),
                        optional(found_by),
                        found_at.as_str().into(),
                        optional(secret.test_value.as_deref()),
                    ])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(())
    }

    /// A secret found in history that was only ever blocked has landed
    /// after all (it was allowed, then pushed): it is open now unless
    /// someone allowed it.
    pub async fn landed(&self, repo_id: &str, fingerprints: &[String]) -> Result<()> {
        for chunk in fingerprints.chunks(90) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut binds: Vec<JsValue> = vec![repo_id.into()];
            binds.extend(chunk.iter().map(|fingerprint| JsValue::from(fingerprint.as_str())));
            self.db
                .prepare(format!(
                    "UPDATE secrets SET status = 'open', source = 'history'
                     WHERE repo_id = ? AND status = 'blocked' AND fingerprint IN ({marks})"
                ))
                .bind(&binds)?
                .run()
                .await?;
        }
        Ok(())
    }

    /// Dismisses a secret: allowed, or resolved when it was revoked.
    pub async fn dismiss_secret(&self, repo_id: &str, id: &str, reason: DismissReason, by: &str, comment: Option<&str>) -> Result<()> {
        self.db
            .prepare(
                "UPDATE secrets SET status = ?, decided_by = ?, reason = ?, decided_at = ?, dismiss_reason = ?
                 WHERE repo_id = ? AND id = ?",
            )
            .bind(&[
                reason.secret_status().as_str().into(),
                by.into(),
                optional(comment),
                now().into(),
                reason.as_str().into(),
                repo_id.into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Opens a secret again, as `status` (open, or blocked for one that
    /// never landed).
    pub async fn reopen_secret(&self, repo_id: &str, id: &str, status: SecretStatus) -> Result<()> {
        self.db
            .prepare(
                "UPDATE secrets SET status = ?, decided_by = NULL, reason = NULL, decided_at = NULL, dismiss_reason = NULL
                 WHERE repo_id = ? AND id = ?",
            )
            .bind(&[status.as_str().into(), repo_id.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    // --- Vulnerabilities ----------------------------------------------------

    pub async fn vulnerabilities(&self, repo_id: &str) -> Result<Vec<Vulnerability>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT {VULN_COLUMNS} FROM vulnerabilities v
                 {VULN_JOINS}
                 WHERE v.repo_id = ?
                 ORDER BY CASE v.status WHEN 'open' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
                   CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                   v.package LIMIT 1000"
            ))
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<VulnRow>()?;
        let updates: HashMap<(String, String), UpdateRow> = self
            .updates(repo_id)
            .await?
            .into_iter()
            .map(|row| ((row.ecosystem.clone(), row.package.clone()), row))
            .collect();
        Ok(rows
            .into_iter()
            .map(|row| {
                let update = updates.get(&(row.ecosystem.clone(), row.package.clone())).map(UpdateRow::to_contract);
                Vulnerability { update, ..Vulnerability::from(row) }
            })
            .collect())
    }

    pub async fn vulnerability(&self, repo_id: &str, id: &str) -> Result<Option<Vulnerability>> {
        let row = self
            .db
            .prepare(format!("SELECT {VULN_COLUMNS} FROM vulnerabilities v {VULN_JOINS} WHERE v.repo_id = ? AND v.id = ?"))
            .bind(&[repo_id.into(), id.into()])?
            .first::<VulnRow>(None)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let update = self.update(repo_id, &row.ecosystem, &row.package).await?.map(|row| row.to_contract());
        Ok(Some(Vulnerability { update, ..Vulnerability::from(row) }))
    }

    pub async fn dismiss_vulnerability(
        &self,
        repo_id: &str,
        id: &str,
        reason: DismissReason,
        by: &str,
        comment: Option<&str>,
    ) -> Result<()> {
        self.db
            .prepare(
                "UPDATE vulnerabilities SET status = CASE status WHEN 'fixed' THEN 'fixed' ELSE 'dismissed' END,
                   dismiss_reason = ?, dismiss_comment = ?, dismissed_by = ?, dismissed_at = ?
                 WHERE repo_id = ? AND id = ?",
            )
            .bind(&[reason.as_str().into(), optional(comment), by.into(), now().into(), repo_id.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn reopen_vulnerability(&self, repo_id: &str, id: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE vulnerabilities SET status = CASE status WHEN 'dismissed' THEN 'open' ELSE status END,
                   dismiss_reason = NULL, dismiss_comment = NULL, dismissed_by = NULL, dismissed_at = NULL
                 WHERE repo_id = ? AND id = ?",
            )
            .bind(&[repo_id.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// The ids of a package's open vulnerabilities.
    pub async fn open_ids(&self, repo_id: &str, ecosystem: &str, package: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct IdRow {
            id: String,
        }
        Ok(self
            .db
            .prepare("SELECT id FROM vulnerabilities WHERE repo_id = ? AND ecosystem = ? AND package = ? AND status = 'open'")
            .bind(&[repo_id.into(), ecosystem.into(), package.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    pub async fn open_vulnerabilities(&self, repo_id: &str) -> Result<Vec<VulnRow>> {
        self.db
            .prepare(format!(
                "SELECT {VULN_COLUMNS} FROM vulnerabilities v
                 {VULN_JOINS}
                 WHERE v.repo_id = ? AND v.status = 'open'"
            ))
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<VulnRow>()
    }

    /// Replaces what is known about a repository's dependencies with what a
    /// scan found: new findings open, findings no longer true fixed, and
    /// findings that came back open again, or dismissed again when someone
    /// had dismissed them.
    pub async fn replace_vulnerabilities(&self, repo_id: &str, found: &[Vulnerability]) -> Result<()> {
        let now_ms = now_ms();
        let now = rfc3339(now_ms);
        let mut statements = vec![self
            .db
            .prepare(
                "UPDATE vulnerabilities SET status = 'fixed', fixed_at = ? WHERE repo_id = ? AND status IN ('open', 'dismissed')",
            )
            .bind(&[now.as_str().into(), repo_id.into()])?];
        for vuln in found {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO vulnerabilities (id, repo_id, ecosystem, package, version, manifest, osv_id, advisory,
                           summary, severity, fixed_version, status, found_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
                         ON CONFLICT (repo_id, ecosystem, package, version, manifest, osv_id) DO UPDATE SET
                           status = CASE WHEN vulnerabilities.dismiss_reason IS NULL THEN 'open' ELSE 'dismissed' END,
                           fixed_at = NULL, advisory = excluded.advisory, summary = excluded.summary,
                           severity = excluded.severity, fixed_version = excluded.fixed_version",
                    )
                    .bind(&[
                        new_id("vul", now_ms).into(),
                        repo_id.into(),
                        vuln.ecosystem.as_str().into(),
                        vuln.package.as_str().into(),
                        vuln.version.as_str().into(),
                        vuln.manifest.as_str().into(),
                        vuln.osv_id.as_str().into(),
                        vuln.advisory.as_str().into(),
                        vuln.summary.as_str().into(),
                        vuln.severity.as_str().into(),
                        optional(vuln.fixed_version.as_deref()),
                        now.as_str().into(),
                    ])?,
            );
        }
        // D1 runs a batch as one transaction, so readers never see the
        // moment between marking everything fixed and opening it again.
        self.db.batch(statements).await?;
        Ok(())
    }

    pub async fn counts(&self, repo_id: &str) -> Result<(SeverityCounts, u32, u32)> {
        let rows = self
            .db
            .prepare("SELECT severity, count(*) AS n FROM vulnerabilities WHERE repo_id = ? AND status = 'open' GROUP BY severity")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<CountRow>()?;
        let mut counts = SeverityCounts::default();
        let mut vulns = 0;
        for row in rows {
            let n = row.n.max(0) as u32;
            vulns += n;
            match row.severity.as_str() {
                "critical" => counts.critical += n,
                "high" => counts.high += n,
                "medium" => counts.medium += n,
                "low" => counts.low += n,
                _ => counts.unknown += n,
            }
        }
        let secrets = self.secret_counts(repo_id).await?;
        // A secret in the history that looks real is the worst thing a
        // repository can hold. One stopped at a push never landed, and a
        // likely test value is no danger: neither is counted.
        counts.critical += secrets.open;
        Ok((counts, secrets.open + secrets.blocked, vulns))
    }

    pub async fn secret_counts(&self, repo_id: &str) -> Result<SecretCounts> {
        let rows = self
            .db
            .prepare(
                "SELECT status, (test_value IS NOT NULL) AS test, count(*) AS n FROM secrets WHERE repo_id = ?
                 GROUP BY status, test",
            )
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<SecretCountRow>()?;
        Ok(secret_counts(rows.iter().map(|row| (row.status.as_str(), row.test != 0, row.n.max(0) as u32))))
    }

    // --- Activity -----------------------------------------------------------

    pub async fn record(&self, repo_id: &str, activity: &[Activity<'_>]) -> Result<()> {
        if activity.is_empty() {
            return Ok(());
        }
        let now_ms = now_ms();
        let at = rfc3339(now_ms);
        let statements = activity
            .iter()
            .map(|item| {
                self.db
                    .prepare(
                        "INSERT INTO alert_activity (id, repo_id, alert_id, action, actor, reason, comment, number, at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        new_id("act", now_ms).into(),
                        repo_id.into(),
                        item.alert_id.into(),
                        item.action.into(),
                        optional(item.actor),
                        optional(item.reason.map(DismissReason::as_str)),
                        optional(item.comment),
                        item.number.map_or(JsValue::NULL, JsValue::from),
                        at.as_str().into(),
                    ])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(())
    }

    /// What happened to a repository's alerts, newest first.
    pub async fn activity(&self, repo_id: &str, limit: u32) -> Result<Vec<AlertActivity>> {
        Ok(self
            .db
            .prepare("SELECT * FROM alert_activity WHERE repo_id = ? ORDER BY at DESC, id DESC LIMIT ?")
            .bind(&[repo_id.into(), limit.into()])?
            .all()
            .await?
            .results::<ActivityRow>()?
            .into_iter()
            .map(AlertActivity::from)
            .collect())
    }

    // --- Security updates ---------------------------------------------------

    pub async fn updates(&self, repo_id: &str) -> Result<Vec<UpdateRow>> {
        self.db
            .prepare("SELECT * FROM updates WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<UpdateRow>()
    }

    pub async fn update(&self, repo_id: &str, ecosystem: &str, package: &str) -> Result<Option<UpdateRow>> {
        self.db
            .prepare("SELECT * FROM updates WHERE repo_id = ? AND ecosystem = ? AND package = ?")
            .bind(&[repo_id.into(), ecosystem.into(), package.into()])?
            .first::<UpdateRow>(None)
            .await
    }

    pub async fn update_by_branch(&self, repo_id: &str, branch: &str) -> Result<Option<UpdateRow>> {
        self.db
            .prepare("SELECT * FROM updates WHERE repo_id = ? AND branch = ?")
            .bind(&[repo_id.into(), branch.into()])?
            .first::<UpdateRow>(None)
            .await
    }

    pub async fn update_by_pull(&self, repo_id: &str, pull: u32) -> Result<Option<UpdateRow>> {
        self.db
            .prepare("SELECT * FROM updates WHERE repo_id = ? AND pull = ?")
            .bind(&[repo_id.into(), pull.into()])?
            .first::<UpdateRow>(None)
            .await
    }

    /// Updates asked of a sandbox before `before` that never pushed.
    pub async fn stalled_updates(&self, before: &str, limit: u32) -> Result<Vec<UpdateRow>> {
        self.db
            .prepare("SELECT * FROM updates WHERE state = 'requested' AND updated_at < ? ORDER BY updated_at LIMIT ?")
            .bind(&[before.into(), limit.into()])?
            .all()
            .await?
            .results::<UpdateRow>()
    }

    /// Asks for a security update: a sandbox is making the change on
    /// `branch`. An open pull request for an older version is kept until
    /// the new one opens, which supersedes it.
    pub async fn request_update(&self, repo_id: &str, ecosystem: &str, package: &str, target: &str, branch: &str) -> Result<()> {
        let now = now();
        self.db
            .prepare(
                "INSERT INTO updates (repo_id, ecosystem, package, target, state, branch, requested_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?6, ?6)
                 ON CONFLICT (repo_id, ecosystem, package) DO UPDATE SET
                   target = ?4, state = 'requested', branch = ?5, error = NULL, issue = NULL,
                   pull = CASE WHEN updates.state = 'open' THEN updates.pull ELSE NULL END,
                   requested_at = ?6, updated_at = ?6",
            )
            .bind(&[repo_id.into(), ecosystem.into(), package.into(), target.into(), branch.into(), now.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_update(
        &self,
        row: &UpdateRow,
        state: UpdateState,
        pull: Option<u32>,
        issue: Option<u32>,
        error: Option<&str>,
    ) -> Result<()> {
        self.db
            .prepare(
                "UPDATE updates SET state = ?, pull = ?, issue = ?, error = ?, updated_at = ?
                 WHERE repo_id = ? AND ecosystem = ? AND package = ?",
            )
            .bind(&[
                state.as_str().into(),
                pull.map_or(JsValue::NULL, JsValue::from),
                issue.map_or(JsValue::NULL, JsValue::from),
                optional(error),
                now().into(),
                row.repo_id.as_str().into(),
                row.ecosystem.as_str().into(),
                row.package.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    // --- Pushes scanned after they landed -----------------------------------

    pub async fn add_push_scan(&self, repo_id: &str, git_ref: &str, head: &str, base: Option<&str>, pusher: Option<&str>) -> Result<String> {
        let id = new_id("psc", now_ms());
        self.db
            .prepare(
                "INSERT INTO push_scans (id, repo_id, git_ref, head, base, pusher, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[id.as_str().into(), repo_id.into(), git_ref.into(), head.into(), optional(base), optional(pusher), now().into()])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn push_scan(&self, id: &str) -> Result<Option<PushScanRow>> {
        self.db
            .prepare("SELECT * FROM push_scans WHERE id = ?")
            .bind(&[id.into()])?
            .first::<PushScanRow>(None)
            .await
    }

    pub async fn pending_push_scans(&self, limit: u32) -> Result<Vec<PushScanRow>> {
        self.db
            .prepare("SELECT * FROM push_scans WHERE state = 'pending' ORDER BY created_at LIMIT ?")
            .bind(&[limit.into()])?
            .all()
            .await?
            .results::<PushScanRow>()
    }

    /// Where a push's scan stands after a page: its next page, or done.
    pub async fn advance_push_scan(&self, id: &str, next: Option<&str>, commits: u32, found: u32) -> Result<()> {
        let done = next.is_none();
        self.db
            .prepare(
                "UPDATE push_scans SET cursor = ?, state = ?, commits = commits + ?, pages = pages + 1, found = found + ?,
                   finished_at = CASE WHEN ? THEN ? ELSE finished_at END
                 WHERE id = ?",
            )
            .bind(&[
                optional(next),
                if done { "done" } else { "pending" }.into(),
                commits.into(),
                found.into(),
                done.into(),
                now().into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    // --- Upgrades -----------------------------------------------------------

    /// The issue opened for a package before security updates, if any.
    pub async fn upgrade(&self, repo_id: &str, ecosystem: &str, package: &str) -> Result<Option<UpgradeRow>> {
        self.db
            .prepare("SELECT number FROM upgrades WHERE repo_id = ? AND ecosystem = ? AND package = ?")
            .bind(&[repo_id.into(), ecosystem.into(), package.into()])?
            .first::<UpgradeRow>(None)
            .await
    }

    // --- Advisories and usage -----------------------------------------------

    /// OSV's record of a vulnerability, if one was fetched after `after`.
    pub async fn advisory(&self, osv_id: &str, after: &str) -> Result<Option<serde_json::Value>> {
        let row = self
            .db
            .prepare("SELECT body, fetched_at FROM advisories WHERE osv_id = ?")
            .bind(&[osv_id.into()])?
            .first::<BodyRow>(None)
            .await?;
        Ok(row
            .filter(|row| row.fetched_at.as_str() >= after)
            .and_then(|row| serde_json::from_str(&row.body).ok()))
    }

    pub async fn keep_advisory(&self, osv_id: &str, body: &serde_json::Value) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO advisories (osv_id, body, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (osv_id) DO UPDATE SET body = ?2, fetched_at = ?3",
            )
            .bind(&[osv_id.into(), body.to_string().into(), now().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Adds to a workspace's scanning this month; returns what the month
    /// has cost so far, in millionths of a dollar.
    pub async fn meter(&self, workspace: &str, reads: u32, commits: u32, osv_queries: u32, cost_micros: i64) -> Result<i64> {
        let month = now()[..7].to_owned();
        self.db
            .prepare(
                "INSERT INTO usage (workspace, month, reads, commits, osv_queries, cost_micros) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (workspace, month) DO UPDATE SET
                   reads = reads + ?3, commits = commits + ?4, osv_queries = osv_queries + ?5,
                   cost_micros = cost_micros + ?6",
            )
            .bind(&[
                workspace.into(),
                month.as_str().into(),
                reads.into(),
                commits.into(),
                osv_queries.into(),
                JsValue::from(cost_micros as f64),
            ])?
            .run()
            .await?;
        Ok(self
            .db
            .prepare("SELECT cost_micros AS n FROM usage WHERE workspace = ? AND month = ?")
            .bind(&[workspace.into(), month.into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n))
    }
}

/// Secret alerts counted by where they stand, from (status, looks like a
/// test value, how many).
pub fn secret_counts<'a>(rows: impl Iterator<Item = (&'a str, bool, u32)>) -> SecretCounts {
    let mut counts = SecretCounts::default();
    for (status, test, n) in rows {
        match (SecretStatus::parse(status), test) {
            (Some(SecretStatus::Open | SecretStatus::Blocked), true) => counts.test_values += n,
            (Some(SecretStatus::Open), false) => counts.open += n,
            (Some(SecretStatus::Blocked), false) => counts.blocked += n,
            (Some(SecretStatus::Allowed), _) => counts.dismissed += n,
            (Some(SecretStatus::Resolved), _) => counts.fixed += n,
            (None, _) => {}
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_secrets_in_history_are_open() {
        let counts = secret_counts(
            [("open", false, 2), ("open", true, 3), ("blocked", false, 1), ("blocked", true, 4), ("allowed", true, 5), ("resolved", false, 6)]
                .into_iter(),
        );
        assert_eq!((counts.open, counts.blocked, counts.test_values, counts.dismissed, counts.fixed), (2, 1, 7, 5, 6));
    }
}
