//! The security service's tables in D1.

use g1t_contracts::security::{
    NewSecret, ScanState, SecretFinding, SecretStatus, SeverityCounts, VulnStatus, Vulnerability,
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
}

impl From<SecretRow> for SecretFinding {
    fn from(row: SecretRow) -> Self {
        SecretFinding {
            label: SecretKind::parse(&row.kind).map_or("a secret", |kind| kind.label()).to_owned(),
            id: row.id,
            repo_id: row.repo_id,
            kind: row.kind,
            path: row.path,
            line: row.line.max(0) as u32,
            commit: row.commit_hash,
            preview: row.preview,
            status: SecretStatus::parse(&row.status).unwrap_or(SecretStatus::Open),
            source: row.source,
            found_by: row.found_by,
            found_at: row.found_at,
            decided_by: row.decided_by,
            reason: row.reason,
            decided_at: row.decided_at,
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
}

impl From<VulnRow> for Vulnerability {
    fn from(row: VulnRow) -> Self {
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
            status: if row.status == "fixed" { VulnStatus::Fixed } else { VulnStatus::Open },
            issue: row.number.map(|number| number as u32),
            found_at: row.found_at,
            fixed_at: row.fixed_at,
        }
    }
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
    v.summary, v.severity, v.fixed_version, v.status, v.found_at, v.fixed_at, u.number AS number";

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
                   found_at DESC LIMIT 500",
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
                           status, source, found_by, found_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (repo_id, fingerprint) DO NOTHING",
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

    pub async fn decide(&self, repo_id: &str, id: &str, status: SecretStatus, by: &str, reason: Option<&str>) -> Result<()> {
        let reopened = status == SecretStatus::Open;
        self.db
            .prepare("UPDATE secrets SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE repo_id = ? AND id = ?")
            .bind(&[
                status.as_str().into(),
                optional((!reopened).then_some(by)),
                optional(reason.filter(|_| !reopened)),
                optional((!reopened).then(now).as_deref()),
                repo_id.into(),
                id.into(),
            ])?
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
                 LEFT JOIN upgrades u ON u.repo_id = v.repo_id AND u.ecosystem = v.ecosystem AND u.package = v.package
                 WHERE v.repo_id = ?
                 ORDER BY CASE v.status WHEN 'open' THEN 0 ELSE 1 END,
                   CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                   v.package LIMIT 1000"
            ))
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<VulnRow>()?;
        Ok(rows.into_iter().map(Vulnerability::from).collect())
    }

    pub async fn open_vulnerabilities(&self, repo_id: &str) -> Result<Vec<VulnRow>> {
        self.db
            .prepare(format!(
                "SELECT {VULN_COLUMNS} FROM vulnerabilities v
                 LEFT JOIN upgrades u ON u.repo_id = v.repo_id AND u.ecosystem = v.ecosystem AND u.package = v.package
                 WHERE v.repo_id = ? AND v.status = 'open'"
            ))
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<VulnRow>()
    }

    /// Replaces what is known about a repository's dependencies with what a
    /// scan found: new findings open, findings no longer true fixed, and
    /// findings that came back open again.
    pub async fn replace_vulnerabilities(&self, repo_id: &str, found: &[Vulnerability]) -> Result<()> {
        let now_ms = now_ms();
        let now = rfc3339(now_ms);
        let mut statements = vec![self
            .db
            .prepare("UPDATE vulnerabilities SET status = 'fixed', fixed_at = ? WHERE repo_id = ? AND status = 'open'")
            .bind(&[now.as_str().into(), repo_id.into()])?];
        for vuln in found {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO vulnerabilities (id, repo_id, ecosystem, package, version, manifest, osv_id, advisory,
                           summary, severity, fixed_version, status, found_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
                         ON CONFLICT (repo_id, ecosystem, package, version, manifest, osv_id) DO UPDATE SET
                           status = 'open', fixed_at = NULL, advisory = excluded.advisory, summary = excluded.summary,
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
        let secrets = self
            .db
            .prepare("SELECT count(*) AS n FROM secrets WHERE repo_id = ? AND status IN ('open', 'blocked')")
            .bind(&[repo_id.into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n.max(0) as u32);
        counts.critical += secrets;
        Ok((counts, secrets, vulns))
    }

    // --- Upgrades -----------------------------------------------------------

    pub async fn upgrade(&self, repo_id: &str, ecosystem: &str, package: &str) -> Result<Option<UpgradeRow>> {
        self.db
            .prepare("SELECT number FROM upgrades WHERE repo_id = ? AND ecosystem = ? AND package = ?")
            .bind(&[repo_id.into(), ecosystem.into(), package.into()])?
            .first::<UpgradeRow>(None)
            .await
    }

    pub async fn record_upgrade(
        &self,
        repo_id: &str,
        ecosystem: &str,
        package: &str,
        number: u32,
        target: &str,
        assigned: bool,
        note: Option<&str>,
    ) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO upgrades (repo_id, ecosystem, package, number, target, opened_at, assigned, note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (repo_id, ecosystem, package) DO UPDATE SET
                   number = ?4, target = ?5, opened_at = ?6, assigned = ?7, note = ?8",
            )
            .bind(&[
                repo_id.into(),
                ecosystem.into(),
                package.into(),
                number.into(),
                target.into(),
                now().into(),
                i32::from(assigned).into(),
                optional(note),
            ])?
            .run()
            .await?;
        Ok(())
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
