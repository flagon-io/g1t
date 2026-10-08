//! The security suite's tables in D1 (migration 0004): settings, custom
//! patterns, secret locations and bypass requests, code scanning, the
//! dependency graph, pull request checks, fixes and daily snapshots.

use std::collections::BTreeSet;

use g1t_contracts::new_id;
use g1t_contracts::security::{AlertState, DismissReason, NewSecret, SeverityCounts};
use g1t_contracts::security_suite::{
    Analysis, BypassReason, BypassRequest, CodeAlert, CustomPattern, PatternSpec, RepoSecuritySettings, SecretLocation,
    WorkspaceSecuritySettings,
};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::store::{Store, now, optional};

/// What a purged repository leaves in the suite's tables. `?1` its id.
pub const PURGED: &[&str] = &[
    "DELETE FROM secret_locations WHERE repo_id = ?1",
    "DELETE FROM custom_patterns WHERE repo_id = ?1",
    "DELETE FROM bypass_requests WHERE repo_id = ?1",
    "DELETE FROM sarif_uploads WHERE repo_id = ?1",
    "DELETE FROM analyses WHERE repo_id = ?1",
    "DELETE FROM analysis_results WHERE repo_id = ?1",
    "DELETE FROM code_alerts WHERE repo_id = ?1",
    "DELETE FROM pull_checks WHERE repo_id = ?1",
    "DELETE FROM dependencies WHERE repo_id = ?1",
    "DELETE FROM alert_fixes WHERE repo_id = ?1",
    "DELETE FROM snapshots WHERE repo_id = ?1",
];

fn number(value: Option<u32>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[derive(Deserialize)]
struct NumberRow {
    n: i64,
}

#[derive(Deserialize)]
struct SettingsRow {
    settings: Option<String>,
    private: i64,
}

#[derive(Deserialize)]
struct WorkspaceRow {
    delegated_bypass: i64,
    validity_checks: i64,
}

#[derive(Deserialize)]
pub struct PatternRow {
    pub id: String,
    pub namespace: String,
    pub repo_id: Option<String>,
    pub name: String,
    pub pattern: String,
    pub before_text: Option<String>,
    pub after_text: Option<String>,
    pub test_strings: String,
    pub state: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_by: String,
    pub updated_at: String,
    #[serde(default)]
    pub repo_name: Option<String>,
    #[serde(default)]
    pub open_alerts: Option<i64>,
}

impl PatternRow {
    pub fn spec(&self) -> PatternSpec {
        PatternSpec {
            id: self.id.clone(),
            name: self.name.clone(),
            pattern: self.pattern.clone(),
            before: self.before_text.clone(),
            after: self.after_text.clone(),
        }
    }

    pub fn contract(&self) -> CustomPattern {
        CustomPattern {
            id: self.id.clone(),
            scope: if self.repo_id.is_some() { "repository" } else { "workspace" }.to_owned(),
            workspace: self.namespace.clone(),
            repo: self.repo_name.clone(),
            name: self.name.clone(),
            pattern: self.pattern.clone(),
            before: self.before_text.clone(),
            after: self.after_text.clone(),
            test_strings: serde_json::from_str(&self.test_strings).unwrap_or_default(),
            state: self.state.clone(),
            created_by: self.created_by.clone(),
            created_at: self.created_at.clone(),
            updated_by: self.updated_by.clone(),
            updated_at: self.updated_at.clone(),
            open_alerts: self.open_alerts.unwrap_or(0).max(0) as u32,
        }
    }
}

#[derive(Deserialize)]
struct LocationRow {
    path: String,
    line: i64,
    commit_hash: String,
    source: String,
    found_at: String,
}

#[derive(Deserialize)]
pub struct RequestRow {
    pub id: String,
    pub repo_id: String,
    pub namespace: String,
    pub secret_id: String,
    pub requester: String,
    pub reason: String,
    pub comment: Option<String>,
    pub state: String,
    pub reviewer: Option<String>,
    pub review_comment: Option<String>,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    // From the secret and the repository.
    #[serde(default)]
    pub repo_name: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub pattern_name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub preview: Option<String>,
}

impl RequestRow {
    pub fn contract(&self) -> BypassRequest {
        BypassRequest {
            id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            workspace: self.namespace.clone(),
            repo: self.repo_name.clone().unwrap_or_default(),
            secret_id: self.secret_id.clone(),
            label: crate::secret_alerts::label_of(self.kind.as_deref().unwrap_or_default(), self.pattern_name.as_deref()),
            path: self.path.clone().unwrap_or_default(),
            line: self.line.unwrap_or(0).max(0) as u32,
            preview: self.preview.clone().unwrap_or_default(),
            requester: self.requester.clone(),
            reason: BypassReason::parse(&self.reason).unwrap_or(BypassReason::WillFixLater),
            comment: self.comment.clone(),
            state: self.state.clone(),
            reviewer: self.reviewer.clone(),
            review_comment: self.review_comment.clone(),
            created_at: self.created_at.clone(),
            reviewed_at: self.reviewed_at.clone(),
        }
    }
}

const REQUEST_SELECT: &str = "SELECT b.*, r.name AS repo_name, s.kind, s.pattern_name, s.path, s.line, s.preview
    FROM bypass_requests b LEFT JOIN repos r ON r.repo_id = b.repo_id LEFT JOIN secrets s ON s.id = b.secret_id";

#[derive(Deserialize)]
pub struct CodeRow {
    pub id: String,
    pub repo_id: String,
    pub number: i64,
    pub tool: String,
    pub category: String,
    pub fingerprint: String,
    pub rule_id: String,
    pub rule_name: Option<String>,
    pub rule_description: Option<String>,
    pub help: Option<String>,
    pub help_uri: Option<String>,
    pub tags: String,
    pub level: String,
    pub security_severity: Option<String>,
    pub severity: String,
    pub message: String,
    pub path: Option<String>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub start_column: Option<i64>,
    pub end_column: Option<i64>,
    pub status: String,
    pub first_commit: String,
    pub last_commit: String,
    pub created_at: String,
    pub updated_at: String,
    pub fixed_at: Option<String>,
    pub dismiss_reason: Option<String>,
    pub dismiss_comment: Option<String>,
    pub dismissed_by: Option<String>,
    pub dismissed_at: Option<String>,
    pub issue: Option<i64>,
}

fn small(value: Option<i64>) -> Option<u32> {
    value.map(|n| n.max(0) as u32)
}

impl From<CodeRow> for CodeAlert {
    fn from(row: CodeRow) -> Self {
        let state = AlertState::parse(&row.status).unwrap_or(AlertState::Open);
        let dismissed = state == AlertState::Dismissed;
        CodeAlert {
            id: row.id,
            number: row.number.max(0) as u32,
            repo_id: row.repo_id,
            tool: row.tool,
            category: row.category,
            rule_id: row.rule_id,
            rule_name: row.rule_name,
            rule_description: row.rule_description,
            help: row.help,
            help_uri: row.help_uri,
            tags: serde_json::from_str(&row.tags).unwrap_or_default(),
            level: row.level,
            security_severity: row.security_severity,
            severity: row.severity,
            message: row.message,
            path: row.path,
            start_line: small(row.start_line),
            end_line: small(row.end_line),
            start_column: small(row.start_column),
            end_column: small(row.end_column),
            state,
            fingerprint: row.fingerprint,
            first_commit: row.first_commit,
            last_commit: row.last_commit,
            created_at: row.created_at,
            updated_at: row.updated_at,
            fixed_at: row.fixed_at,
            dismissed_by: row.dismissed_by.filter(|_| dismissed),
            dismissed_reason: row.dismiss_reason.as_deref().and_then(DismissReason::parse).filter(|_| dismissed),
            dismissed_comment: row.dismiss_comment.filter(|_| dismissed),
            dismissed_at: row.dismissed_at.filter(|_| dismissed),
            issue: small(row.issue),
        }
    }
}

#[derive(Deserialize)]
pub struct AnalysisRow {
    pub id: String,
    pub repo_id: String,
    pub sarif_id: String,
    pub tool: String,
    pub tool_version: Option<String>,
    pub category: String,
    pub commit_sha: String,
    pub git_ref: String,
    pub pull: Option<i64>,
    pub results: i64,
    pub new_alerts: i64,
    pub fixed_alerts: i64,
    pub dropped: i64,
    pub created_at: String,
}

impl From<AnalysisRow> for Analysis {
    fn from(row: AnalysisRow) -> Self {
        Analysis {
            id: row.id,
            repo_id: row.repo_id,
            sarif_id: row.sarif_id,
            tool: row.tool,
            tool_version: row.tool_version,
            category: row.category,
            commit_sha: row.commit_sha,
            git_ref: row.git_ref,
            pull: small(row.pull),
            results: row.results.max(0) as u32,
            new_alerts: row.new_alerts.max(0) as u32,
            fixed_alerts: row.fixed_alerts.max(0) as u32,
            dropped: row.dropped.max(0) as u32,
            created_at: row.created_at,
        }
    }
}

#[derive(Deserialize)]
pub struct UploadRow {
    pub id: String,
    pub commit_sha: String,
    pub git_ref: String,
    pub status: String,
    pub errors: String,
    pub analyses: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct PullCheckRow {
    pub commit_sha: String,
    pub state: String,
    pub description: String,
    pub detail: String,
    pub commented: String,
}

#[derive(Clone, Deserialize)]
pub struct DependencyRow {
    pub manifest: String,
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub relationship: String,
    pub development: i64,
    pub license: Option<String>,
}

#[derive(Deserialize)]
struct CountRow {
    severity: String,
    n: i64,
}

#[derive(Deserialize)]
pub struct SnapshotRow {
    pub day: String,
    pub alert_type: String,
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub unknown: i64,
}

/// A new or changed result of an analysis on the default branch.
pub struct NewCodeAlert<'a> {
    pub tool: &'a str,
    pub category: &'a str,
    pub finding: &'a g1t_scan::sarif::Finding,
    pub commit: &'a str,
}

fn counts_of(rows: Vec<CountRow>) -> SeverityCounts {
    let mut counts = SeverityCounts::default();
    for row in rows {
        let n = row.n.max(0) as u32;
        match row.severity.as_str() {
            "critical" => counts.critical += n,
            "high" => counts.high += n,
            "medium" => counts.medium += n,
            "low" => counts.low += n,
            _ => counts.unknown += n,
        }
    }
    counts
}

impl Store {
    // --- Repository and workspace settings ----------------------------------

    pub async fn set_private(&self, repo_id: &str, private: bool) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET private = ? WHERE repo_id = ?")
            .bind(&[i32::from(private).into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A repository's settings, and whether it is private.
    pub async fn repo_settings(&self, repo_id: &str) -> Result<(RepoSecuritySettings, bool)> {
        let row = self
            .db
            .prepare("SELECT settings, private FROM repos WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<SettingsRow>(None)
            .await?;
        Ok(match row {
            Some(row) => (
                row.settings.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default(),
                row.private != 0,
            ),
            None => (RepoSecuritySettings::default(), true),
        })
    }

    pub async fn set_repo_settings(&self, repo_id: &str, settings: &RepoSecuritySettings) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET settings = ? WHERE repo_id = ?")
            .bind(&[serde_json::to_string(settings)?.into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn workspace_settings(&self, namespace: &str) -> Result<WorkspaceSecuritySettings> {
        let row = self
            .db
            .prepare("SELECT delegated_bypass, validity_checks FROM workspace_settings WHERE namespace = ?")
            .bind(&[namespace.into()])?
            .first::<WorkspaceRow>(None)
            .await?;
        Ok(row.map_or_else(WorkspaceSecuritySettings::default, |row| WorkspaceSecuritySettings {
            delegated_bypass: row.delegated_bypass != 0,
            validity_checks: row.validity_checks != 0,
        }))
    }

    pub async fn set_workspace_settings(&self, namespace: &str, settings: &WorkspaceSecuritySettings, by: &str) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO workspace_settings (namespace, delegated_bypass, validity_checks, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (namespace) DO UPDATE SET delegated_bypass = ?2, validity_checks = ?3, updated_by = ?4, updated_at = ?5",
            )
            .bind(&[
                namespace.into(),
                i32::from(settings.delegated_bypass).into(),
                i32::from(settings.validity_checks).into(),
                by.into(),
                now().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Everything the suite keeps for a purged repository goes.
    pub async fn purge_suite(&self, repo_id: &str) -> Result<()> {
        let mut batch = Vec::with_capacity(PURGED.len());
        for sql in PURGED {
            batch.push(self.db.prepare(*sql).bind(&[repo_id.into()])?);
        }
        self.db.batch(batch).await?;
        Ok(())
    }

    // --- Custom patterns ----------------------------------------------------

    /// A repository's own patterns (with `repo_id`) and its workspace's, or
    /// only the workspace's.
    pub async fn patterns(&self, namespace: &str, repo_id: Option<&str>) -> Result<Vec<PatternRow>> {
        let sql = "SELECT p.*, r.name AS repo_name,
               (SELECT count(*) FROM secrets s WHERE s.pattern_id = p.id AND s.status IN ('open', 'blocked')) AS open_alerts
             FROM custom_patterns p LEFT JOIN repos r ON r.repo_id = p.repo_id
             WHERE p.namespace = ?1 AND (p.repo_id IS NULL OR p.repo_id = ?2)
             ORDER BY p.repo_id IS NOT NULL, p.name";
        self.db
            .prepare(sql)
            .bind(&[namespace.into(), optional(repo_id.or(Some("")))])?
            .all()
            .await?
            .results::<PatternRow>()
    }

    pub async fn pattern(&self, id: &str) -> Result<Option<PatternRow>> {
        self.db
            .prepare(
                "SELECT p.*, r.name AS repo_name, 0 AS open_alerts FROM custom_patterns p
                 LEFT JOIN repos r ON r.repo_id = p.repo_id WHERE p.id = ?",
            )
            .bind(&[id.into()])?
            .first::<PatternRow>(None)
            .await
    }

    /// Creates or changes a pattern; returns its id.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_pattern(
        &self,
        id: Option<&str>,
        namespace: &str,
        repo_id: Option<&str>,
        spec: &PatternSpec,
        tests: &[String],
        state: &str,
        by: &str,
    ) -> Result<String> {
        let id = id.map_or_else(|| new_id("pat", now_ms()), str::to_owned);
        let now = now();
        self.db
            .prepare(
                "INSERT INTO custom_patterns (id, namespace, repo_id, name, pattern, before_text, after_text, test_strings,
                   state, created_by, created_at, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, ?11)
                 ON CONFLICT (id) DO UPDATE SET name = ?4, pattern = ?5, before_text = ?6, after_text = ?7,
                   test_strings = ?8, state = ?9, updated_by = ?10, updated_at = ?11",
            )
            .bind(&[
                id.as_str().into(),
                namespace.into(),
                optional(repo_id),
                spec.name.as_str().into(),
                spec.pattern.as_str().into(),
                optional(spec.before.as_deref()),
                optional(spec.after.as_deref()),
                serde_json::to_string(tests)?.into(),
                state.into(),
                by.into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn delete_pattern(&self, id: &str) -> Result<()> {
        self.db.prepare("DELETE FROM custom_patterns WHERE id = ?").bind(&[id.into()])?.run().await?;
        Ok(())
    }

    /// The published patterns a repository is scanned with.
    pub async fn published_patterns(&self, namespace: &str, repo_id: &str) -> Result<Vec<PatternSpec>> {
        Ok(self
            .patterns(namespace, Some(repo_id))
            .await?
            .into_iter()
            .filter(|row| row.state == "published")
            .map(|row| row.spec())
            .collect())
    }

    /// Restarts the history scan of the repositories a published pattern
    /// covers, so it looks for the pattern too.
    pub async fn rescan_for_pattern(&self, namespace: &str, repo_id: Option<&str>) -> Result<()> {
        let sql = match repo_id {
            Some(_) => "UPDATE repos SET history = 'pending', history_cursor = NULL, history_commits = 0, history_finished_at = NULL WHERE repo_id = ?",
            None => "UPDATE repos SET history = 'pending', history_cursor = NULL, history_commits = 0, history_finished_at = NULL WHERE namespace = ?",
        };
        self.db.prepare(sql).bind(&[repo_id.unwrap_or(namespace).into()])?.run().await?;
        Ok(())
    }

    // --- Secrets: locations, patterns, bypasses, validity -------------------

    /// Records where each secret was found, and which custom pattern found
    /// it, once the secrets themselves are stored.
    pub async fn note_found(&self, repo_id: &str, secrets: &[NewSecret], source: &str) -> Result<()> {
        if secrets.is_empty() {
            return Ok(());
        }
        let found_at = now();
        let mut statements = Vec::new();
        for secret in secrets {
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO secret_locations (secret_id, repo_id, path, line, commit_hash, source, found_at)
                         SELECT id, ?1, ?2, ?3, ?4, ?5, ?6 FROM secrets WHERE repo_id = ?1 AND fingerprint = ?7",
                    )
                    .bind(&[
                        repo_id.into(),
                        secret.path.as_str().into(),
                        secret.line.into(),
                        secret.commit.as_str().into(),
                        source.into(),
                        found_at.as_str().into(),
                        secret.fingerprint.as_str().into(),
                    ])?,
            );
            if let Some(pattern) = &secret.pattern_id {
                statements.push(
                    self.db
                        .prepare("UPDATE secrets SET pattern_id = ?, pattern_name = ? WHERE repo_id = ? AND fingerprint = ? AND pattern_id IS NULL")
                        .bind(&[
                            pattern.as_str().into(),
                            optional(secret.pattern_name.as_deref()),
                            repo_id.into(),
                            secret.fingerprint.as_str().into(),
                        ])?,
                );
            }
        }
        for chunk in statements.chunks(50) {
            self.db.batch(chunk.to_vec()).await?;
        }
        Ok(())
    }

    pub async fn locations(&self, secret_id: &str) -> Result<Vec<SecretLocation>> {
        Ok(self
            .db
            .prepare("SELECT * FROM secret_locations WHERE secret_id = ? ORDER BY found_at, path, line LIMIT 200")
            .bind(&[secret_id.into()])?
            .all()
            .await?
            .results::<LocationRow>()?
            .into_iter()
            .map(|row| SecretLocation {
                path: row.path,
                line: row.line.max(0) as u32,
                commit: row.commit_hash,
                source: row.source,
                found_at: row.found_at,
            })
            .collect())
    }

    /// Of these fingerprints, those someone bypassed push protection for.
    pub async fn bypassed(&self, repo_id: &str, fingerprints: &[String]) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            fingerprint: String,
        }
        let mut found = Vec::new();
        for chunk in fingerprints.chunks(90) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut binds: Vec<JsValue> = vec![repo_id.into()];
            binds.extend(chunk.iter().map(|fingerprint| JsValue::from(fingerprint.as_str())));
            let rows = self
                .db
                .prepare(format!(
                    "SELECT fingerprint FROM secrets WHERE repo_id = ? AND bypassed_at IS NOT NULL AND fingerprint IN ({marks})"
                ))
                .bind(&binds)?
                .all()
                .await?
                .results::<Row>()?;
            found.extend(rows.into_iter().map(|row| row.fingerprint));
        }
        Ok(found)
    }

    /// Lets a secret through push protection: `status` is what it becomes
    /// (`allowed` when the reason closes it, `open` for one to fix later).
    #[allow(clippy::too_many_arguments)]
    pub async fn bypass(
        &self,
        repo_id: &str,
        id: &str,
        reason: BypassReason,
        comment: Option<&str>,
        by: &str,
        approved_by: Option<&str>,
    ) -> Result<()> {
        let now = now();
        let statement = match reason.dismissal() {
            Some(dismissal) => self
                .db
                .prepare(
                    "UPDATE secrets SET status = 'allowed', decided_by = ?1, reason = ?2, decided_at = ?3, dismiss_reason = ?4,
                       bypass_reason = ?5, bypass_comment = ?2, bypassed_by = ?1, bypassed_at = ?3, bypass_approved_by = ?6
                     WHERE repo_id = ?7 AND id = ?8",
                )
                .bind(&[
                    by.into(),
                    optional(comment),
                    now.as_str().into(),
                    dismissal.as_str().into(),
                    reason.as_str().into(),
                    optional(approved_by),
                    repo_id.into(),
                    id.into(),
                ])?,
            // Real, to be rotated: it stays open, and lands with the push.
            None => self
                .db
                .prepare(
                    "UPDATE secrets SET status = CASE status WHEN 'blocked' THEN 'open' ELSE status END,
                       bypass_reason = ?1, bypass_comment = ?2, bypassed_by = ?3, bypassed_at = ?4, bypass_approved_by = ?5
                     WHERE repo_id = ?6 AND id = ?7",
                )
                .bind(&[
                    reason.as_str().into(),
                    optional(comment),
                    by.into(),
                    now.as_str().into(),
                    optional(approved_by),
                    repo_id.into(),
                    id.into(),
                ])?,
        };
        statement.run().await?;
        Ok(())
    }

    pub async fn fingerprint_of(&self, repo_id: &str, id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            fingerprint: String,
        }
        Ok(self
            .db
            .prepare("SELECT fingerprint FROM secrets WHERE repo_id = ? AND id = ?")
            .bind(&[repo_id.into(), id.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.fingerprint))
    }

    pub async fn set_validity(&self, repo_id: &str, id: &str, validity: &str) -> Result<()> {
        self.db
            .prepare("UPDATE secrets SET validity = ?, validity_checked_at = ? WHERE repo_id = ? AND id = ?")
            .bind(&[validity.into(), now().into(), repo_id.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Open secrets due a validity check: never checked, or not for a week.
    pub async fn unchecked_secrets(&self, repo_id: &str, before: &str, limit: u32) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT id FROM secrets WHERE repo_id = ? AND status = 'open' AND test_value IS NULL AND kind <> 'custom_pattern'
                   AND (validity_checked_at IS NULL OR validity_checked_at < ?) AND (validity IS NULL OR validity <> 'unsupported')
                 ORDER BY found_at DESC LIMIT ?",
            )
            .bind(&[repo_id.into(), before.into(), limit.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    // --- Bypass requests ----------------------------------------------------

    pub async fn add_request(
        &self,
        repo_id: &str,
        namespace: &str,
        secret_id: &str,
        requester: &str,
        reason: BypassReason,
        comment: Option<&str>,
    ) -> Result<String> {
        let id = new_id("byp", now_ms());
        self.db
            .prepare(
                "INSERT INTO bypass_requests (id, repo_id, namespace, secret_id, requester, reason, comment, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo_id.into(),
                namespace.into(),
                secret_id.into(),
                requester.into(),
                reason.as_str().into(),
                optional(comment),
                now().into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn request(&self, id: &str) -> Result<Option<RequestRow>> {
        self.db.prepare(format!("{REQUEST_SELECT} WHERE b.id = ?")).bind(&[id.into()])?.first::<RequestRow>(None).await
    }

    pub async fn pending_request(&self, secret_id: &str, requester: &str) -> Result<Option<RequestRow>> {
        self.db
            .prepare(format!("{REQUEST_SELECT} WHERE b.secret_id = ? AND b.requester = ? AND b.state = 'pending'"))
            .bind(&[secret_id.into(), requester.into()])?
            .first::<RequestRow>(None)
            .await
    }

    pub async fn requests_for_secret(&self, secret_id: &str) -> Result<Vec<RequestRow>> {
        self.db
            .prepare(format!("{REQUEST_SELECT} WHERE b.secret_id = ? ORDER BY b.created_at DESC LIMIT 50"))
            .bind(&[secret_id.into()])?
            .all()
            .await?
            .results::<RequestRow>()
    }

    pub async fn requests(&self, namespace: &str, repo_id: Option<&str>, state: Option<&str>) -> Result<Vec<RequestRow>> {
        self.db
            .prepare(format!(
                "{REQUEST_SELECT} WHERE b.namespace = ?1 AND (?2 IS NULL OR b.repo_id = ?2) AND (?3 IS NULL OR b.state = ?3)
                 ORDER BY b.state = 'pending' DESC, b.created_at DESC LIMIT 200"
            ))
            .bind(&[namespace.into(), optional(repo_id), optional(state)])?
            .all()
            .await?
            .results::<RequestRow>()
    }

    pub async fn review_request(&self, id: &str, state: &str, reviewer: &str, comment: Option<&str>) -> Result<bool> {
        let changed = self
            .db
            .prepare(
                "UPDATE bypass_requests SET state = ?, reviewer = ?, review_comment = ?, reviewed_at = ?
                 WHERE id = ? AND state = 'pending' RETURNING id",
            )
            .bind(&[state.into(), reviewer.into(), optional(comment), now().into(), id.into()])?
            .first::<serde_json::Value>(None)
            .await?;
        Ok(changed.is_some())
    }

    // --- Code scanning ------------------------------------------------------

    pub async fn add_upload(&self, repo_id: &str, commit_sha: &str, git_ref: &str, by: &str) -> Result<String> {
        let id = new_id("sar", now_ms());
        self.db
            .prepare(
                "INSERT INTO sarif_uploads (id, repo_id, commit_sha, git_ref, status, created_by, created_at)
                 VALUES (?, ?, ?, ?, 'complete', ?, ?)",
            )
            .bind(&[id.as_str().into(), repo_id.into(), commit_sha.into(), git_ref.into(), by.into(), now().into()])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn finish_upload(&self, id: &str, failed: bool, errors: &[String], analyses: &[String]) -> Result<()> {
        self.db
            .prepare("UPDATE sarif_uploads SET status = ?, errors = ?, analyses = ? WHERE id = ?")
            .bind(&[
                if failed { "failed" } else { "complete" }.into(),
                serde_json::to_string(errors)?.into(),
                serde_json::to_string(analyses)?.into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn upload(&self, repo_id: &str, id: &str) -> Result<Option<UploadRow>> {
        self.db
            .prepare("SELECT * FROM sarif_uploads WHERE repo_id = ? AND id = ?")
            .bind(&[repo_id.into(), id.into()])?
            .first::<UploadRow>(None)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_analysis(
        &self,
        repo_id: &str,
        sarif_id: &str,
        run: &g1t_scan::sarif::Run,
        commit_sha: &str,
        git_ref: &str,
        pull: Option<u32>,
        new_alerts: u32,
        fixed_alerts: u32,
    ) -> Result<String> {
        let id = new_id("ana", now_ms());
        self.db
            .prepare(
                "INSERT INTO analyses (id, repo_id, sarif_id, tool, tool_version, category, commit_sha, git_ref, pull, results,
                   new_alerts, fixed_alerts, dropped, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo_id.into(),
                sarif_id.into(),
                run.tool.as_str().into(),
                optional(run.tool_version.as_deref()),
                run.category.as_str().into(),
                commit_sha.into(),
                git_ref.into(),
                number(pull),
                (run.findings.len() as u32).into(),
                new_alerts.into(),
                fixed_alerts.into(),
                (run.dropped as u32).into(),
                now().into(),
            ])?
            .run()
            .await?;
        // Each result, so pull requests and alerts can name them.
        let mut statements = Vec::new();
        for finding in &run.findings {
            let result = crate::code_scanning::result_json(finding);
            statements.push(
                self.db
                    .prepare("INSERT OR IGNORE INTO analysis_results (analysis_id, repo_id, fingerprint, result) VALUES (?, ?, ?, ?)")
                    .bind(&[id.as_str().into(), repo_id.into(), finding.fingerprint.as_str().into(), result.to_string().into()])?,
            );
        }
        for chunk in statements.chunks(100) {
            self.db.batch(chunk.to_vec()).await?;
        }
        Ok(id)
    }

    pub async fn analyses(&self, repo_id: &str, limit: u32) -> Result<Vec<Analysis>> {
        Ok(self
            .db
            .prepare("SELECT * FROM analyses WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?")
            .bind(&[repo_id.into(), limit.into()])?
            .all()
            .await?
            .results::<AnalysisRow>()?
            .into_iter()
            .map(Analysis::from)
            .collect())
    }

    pub async fn analyses_reporting(&self, repo_id: &str, fingerprint: &str) -> Result<Vec<Analysis>> {
        Ok(self
            .db
            .prepare(
                "SELECT a.* FROM analyses a JOIN analysis_results r ON r.analysis_id = a.id
                 WHERE r.repo_id = ? AND r.fingerprint = ? ORDER BY a.created_at DESC LIMIT 20",
            )
            .bind(&[repo_id.into(), fingerprint.into()])?
            .all()
            .await?
            .results::<AnalysisRow>()?
            .into_iter()
            .map(Analysis::from)
            .collect())
    }

    /// The fingerprints of a tool's and category's open (or dismissed)
    /// alerts on the default branch.
    pub async fn live_fingerprints(&self, repo_id: &str, tool: &str, category: &str) -> Result<BTreeSet<String>> {
        #[derive(Deserialize)]
        struct Row {
            fingerprint: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT fingerprint FROM code_alerts WHERE repo_id = ? AND tool = ? AND category = ? AND status IN ('open', 'dismissed')",
            )
            .bind(&[repo_id.into(), tool.into(), category.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.fingerprint)
            .collect())
    }

    /// Every open alert's fingerprint, any tool: a pull request's result
    /// with one of these is not its own.
    pub async fn open_code_fingerprints(&self, repo_id: &str) -> Result<BTreeSet<String>> {
        #[derive(Deserialize)]
        struct Row {
            fingerprint: String,
        }
        Ok(self
            .db
            .prepare("SELECT fingerprint FROM code_alerts WHERE repo_id = ? AND status IN ('open', 'dismissed')")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.fingerprint)
            .collect())
    }

    /// Records what an analysis on the default branch found: new results
    /// open alerts, results seen before refresh theirs (a fixed one opens
    /// again; a dismissed one stays dismissed). Returns the ids of alerts
    /// that opened, new or again.
    pub async fn upsert_code_alerts(&self, repo_id: &str, found: &[NewCodeAlert<'_>]) -> Result<Vec<String>> {
        let mut opened = Vec::new();
        let now = now();
        for item in found {
            let finding = item.finding;
            let location = finding.location.as_ref();
            #[derive(Deserialize)]
            struct Existing {
                id: String,
                status: String,
            }
            let existing = self
                .db
                .prepare("SELECT id, status FROM code_alerts WHERE repo_id = ? AND tool = ? AND category = ? AND fingerprint = ?")
                .bind(&[repo_id.into(), item.tool.into(), item.category.into(), finding.fingerprint.as_str().into()])?
                .first::<Existing>(None)
                .await?;
            let tags = serde_json::to_string(&finding.tags)?;
            let security = finding.security_severity.map(|severity| severity.as_str());
            let severity = finding.severity().as_str();
            match existing {
                Some(existing) => {
                    self.db
                        .prepare(
                            "UPDATE code_alerts SET status = CASE status WHEN 'fixed' THEN 'open' ELSE status END,
                               fixed_at = NULL, last_commit = ?, message = ?, level = ?, security_severity = ?, severity = ?,
                               rule_name = ?, rule_description = ?, help = ?, help_uri = ?, tags = ?, path = ?, start_line = ?,
                               end_line = ?, start_column = ?, end_column = ?, updated_at = ?
                             WHERE id = ?",
                        )
                        .bind(&[
                            item.commit.into(),
                            finding.message.as_str().into(),
                            finding.level.as_str().into(),
                            optional(security),
                            severity.into(),
                            optional(finding.rule_name.as_deref()),
                            optional(finding.rule_description.as_deref()),
                            optional(finding.help.as_deref()),
                            optional(finding.help_uri.as_deref()),
                            tags.into(),
                            optional(location.map(|l| l.path.as_str())),
                            number(location.map(|l| l.start_line)),
                            number(location.map(|l| l.end_line)),
                            number(location.and_then(|l| l.start_column)),
                            number(location.and_then(|l| l.end_column)),
                            now.as_str().into(),
                            existing.id.as_str().into(),
                        ])?
                        .run()
                        .await?;
                    if existing.status == "fixed" {
                        opened.push(existing.id);
                    }
                }
                None => {
                    let id = new_id("cod", now_ms());
                    // The next number; two uploads at once retry on the
                    // unique number.
                    for _ in 0..3 {
                        let next = self
                            .db
                            .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM code_alerts WHERE repo_id = ?")
                            .bind(&[repo_id.into()])?
                            .first::<NumberRow>(None)
                            .await?
                            .map_or(1, |row| row.n);
                        let inserted = self
                            .db
                            .prepare(
                                "INSERT INTO code_alerts (id, repo_id, number, tool, category, fingerprint, rule_id, rule_name,
                                   rule_description, help, help_uri, tags, level, security_severity, severity, message, path,
                                   start_line, end_line, start_column, end_column, status, first_commit, last_commit, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
                            )
                            .bind(&[
                                id.as_str().into(),
                                repo_id.into(),
                                JsValue::from(next as f64),
                                item.tool.into(),
                                item.category.into(),
                                finding.fingerprint.as_str().into(),
                                finding.rule_id.as_str().into(),
                                optional(finding.rule_name.as_deref()),
                                optional(finding.rule_description.as_deref()),
                                optional(finding.help.as_deref()),
                                optional(finding.help_uri.as_deref()),
                                tags.as_str().into(),
                                finding.level.as_str().into(),
                                optional(security),
                                severity.into(),
                                finding.message.as_str().into(),
                                optional(location.map(|l| l.path.as_str())),
                                number(location.map(|l| l.start_line)),
                                number(location.map(|l| l.end_line)),
                                number(location.and_then(|l| l.start_column)),
                                number(location.and_then(|l| l.end_column)),
                                item.commit.into(),
                                item.commit.into(),
                                now.as_str().into(),
                                now.as_str().into(),
                            ])?
                            .run()
                            .await;
                        if inserted.is_ok() {
                            opened.push(id.clone());
                            break;
                        }
                    }
                }
            }
        }
        Ok(opened)
    }

    /// Marks fixed the open alerts of a tool and category whose
    /// fingerprints an analysis no longer reports. Returns their ids.
    pub async fn fix_code_alerts(&self, repo_id: &str, tool: &str, category: &str, fingerprints: &[String]) -> Result<Vec<String>> {
        let mut fixed = Vec::new();
        let now = now();
        for fingerprint in fingerprints {
            #[derive(Deserialize)]
            struct Row {
                id: String,
            }
            if let Some(row) = self
                .db
                .prepare(
                    "UPDATE code_alerts SET status = 'fixed', fixed_at = ?, updated_at = ?
                     WHERE repo_id = ? AND tool = ? AND category = ? AND fingerprint = ? AND status = 'open' RETURNING id",
                )
                .bind(&[now.as_str().into(), now.as_str().into(), repo_id.into(), tool.into(), category.into(), fingerprint.as_str().into()])?
                .first::<Row>(None)
                .await?
            {
                fixed.push(row.id);
            }
        }
        Ok(fixed)
    }

    pub async fn code_alerts(&self, repo_id: &str) -> Result<Vec<CodeAlert>> {
        Ok(self
            .db
            .prepare(
                "SELECT * FROM code_alerts WHERE repo_id = ?
                 ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
                   CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                   number DESC LIMIT 1000",
            )
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<CodeRow>()?
            .into_iter()
            .map(CodeAlert::from)
            .collect())
    }

    pub async fn code_alert(&self, repo_id: &str, number: u32) -> Result<Option<CodeAlert>> {
        Ok(self
            .db
            .prepare("SELECT * FROM code_alerts WHERE repo_id = ? AND number = ?")
            .bind(&[repo_id.into(), number.into()])?
            .first::<CodeRow>(None)
            .await?
            .map(CodeAlert::from))
    }

    pub async fn code_alert_by_id(&self, repo_id: &str, id: &str) -> Result<Option<CodeAlert>> {
        Ok(self
            .db
            .prepare("SELECT * FROM code_alerts WHERE repo_id = ? AND id = ?")
            .bind(&[repo_id.into(), id.into()])?
            .first::<CodeRow>(None)
            .await?
            .map(CodeAlert::from))
    }

    pub async fn set_code_alert(
        &self,
        repo_id: &str,
        id: &str,
        dismissal: Option<(DismissReason, Option<&str>, &str)>,
    ) -> Result<()> {
        let now = now();
        match dismissal {
            Some((reason, comment, by)) => {
                self.db
                    .prepare(
                        "UPDATE code_alerts SET status = 'dismissed', dismiss_reason = ?, dismiss_comment = ?, dismissed_by = ?,
                           dismissed_at = ?, updated_at = ? WHERE repo_id = ? AND id = ?",
                    )
                    .bind(&[reason.as_str().into(), optional(comment), by.into(), now.as_str().into(), now.as_str().into(), repo_id.into(), id.into()])?
                    .run()
                    .await?;
            }
            None => {
                self.db
                    .prepare(
                        "UPDATE code_alerts SET status = 'open', dismiss_reason = NULL, dismiss_comment = NULL, dismissed_by = NULL,
                           dismissed_at = NULL, updated_at = ? WHERE repo_id = ? AND id = ?",
                    )
                    .bind(&[now.as_str().into(), repo_id.into(), id.into()])?
                    .run()
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn set_code_issue(&self, repo_id: &str, id: &str, issue: u32) -> Result<()> {
        self.db
            .prepare("UPDATE code_alerts SET issue = ? WHERE repo_id = ? AND id = ?")
            .bind(&[issue.into(), repo_id.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn code_counts(&self, repo_id: &str) -> Result<SeverityCounts> {
        let rows = self
            .db
            .prepare("SELECT severity, count(*) AS n FROM code_alerts WHERE repo_id = ? AND status = 'open' GROUP BY severity")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<CountRow>()?;
        Ok(counts_of(rows))
    }

    // --- Pull request checks ------------------------------------------------

    pub async fn pull_check(&self, repo_id: &str, pull: u32, kind: &str) -> Result<Option<PullCheckRow>> {
        self.db
            .prepare("SELECT commit_sha, state, description, detail, commented FROM pull_checks WHERE repo_id = ? AND pull = ? AND kind = ?")
            .bind(&[repo_id.into(), pull.into(), kind.into()])?
            .first::<PullCheckRow>(None)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn set_pull_check(
        &self,
        repo_id: &str,
        pull: u32,
        kind: &str,
        commit: &str,
        state: &str,
        description: &str,
        detail: &serde_json::Value,
        commented: &[String],
    ) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO pull_checks (repo_id, pull, kind, commit_sha, state, description, detail, commented, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT (repo_id, pull, kind) DO UPDATE SET commit_sha = ?4, state = ?5, description = ?6, detail = ?7,
                   commented = ?8, updated_at = ?9",
            )
            .bind(&[
                repo_id.into(),
                pull.into(),
                kind.into(),
                commit.into(),
                state.into(),
                description.into(),
                detail.to_string().into(),
                serde_json::to_string(commented)?.into(),
                now().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    // --- The dependency graph -----------------------------------------------

    pub async fn replace_dependencies(&self, repo_id: &str, deps: &[g1t_scan::graph::Dependency]) -> Result<()> {
        let mut statements = vec![self.db.prepare("DELETE FROM dependencies WHERE repo_id = ?").bind(&[repo_id.into()])?];
        for dep in deps {
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO dependencies (repo_id, manifest, ecosystem, name, version, relationship, development, license)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        repo_id.into(),
                        dep.manifest.as_str().into(),
                        dep.package.ecosystem.osv().into(),
                        dep.package.name.as_str().into(),
                        dep.package.version.as_str().into(),
                        dep.relationship.as_str().into(),
                        i32::from(dep.development).into(),
                        optional(dep.license.as_deref()),
                    ])?,
            );
        }
        // D1 runs a batch as one transaction: readers never see it empty.
        self.db.batch(statements).await?;
        Ok(())
    }

    /// The commit the dependencies were last read at.
    pub async fn deps_commit(&self, repo_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            deps_commit: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT deps_commit FROM repos WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.deps_commit))
    }

    pub async fn dependencies(&self, repo_id: &str) -> Result<Vec<DependencyRow>> {
        self.db
            .prepare("SELECT * FROM dependencies WHERE repo_id = ? ORDER BY manifest, relationship <> 'direct', name, version LIMIT 20000")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<DependencyRow>()
    }

    // --- Fixes --------------------------------------------------------------

    pub async fn fix_issue(&self, alert_id: &str) -> Result<Option<u32>> {
        Ok(self
            .db
            .prepare("SELECT issue AS n FROM alert_fixes WHERE alert_id = ?")
            .bind(&[alert_id.into()])?
            .first::<NumberRow>(None)
            .await?
            .map(|row| row.n.max(0) as u32))
    }

    pub async fn add_fix(&self, repo_id: &str, alert_id: &str, issue: u32, by: &str) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO alert_fixes (alert_id, repo_id, issue, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (alert_id) DO UPDATE SET issue = ?3, created_by = ?4, created_at = ?5",
            )
            .bind(&[alert_id.into(), repo_id.into(), issue.into(), by.into(), now().into()])?
            .run()
            .await?;
        Ok(())
    }

    // --- Snapshots and counts -----------------------------------------------

    /// Open secrets by severity: one that looks real and landed is
    /// critical; a blocked one high; a likely test value low.
    pub async fn secret_severity_counts(&self, repo_id: &str) -> Result<SeverityCounts> {
        let rows = self
            .db
            .prepare(
                "SELECT CASE WHEN test_value IS NOT NULL THEN 'low' WHEN status = 'blocked' THEN 'high' ELSE 'critical' END AS severity,
                   count(*) AS n FROM secrets WHERE repo_id = ? AND status IN ('open', 'blocked') GROUP BY severity",
            )
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<CountRow>()?;
        Ok(counts_of(rows))
    }

    pub async fn vulnerability_counts(&self, repo_id: &str) -> Result<SeverityCounts> {
        let rows = self
            .db
            .prepare("SELECT severity, count(*) AS n FROM vulnerabilities WHERE repo_id = ? AND status = 'open' GROUP BY severity")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<CountRow>()?;
        Ok(counts_of(rows))
    }

    /// Alerts of a type opened and closed since `since`, across `repo_ids`.
    pub async fn opened_and_closed(&self, alert_type: &str, repo_ids: &[String], since: &str) -> Result<(u32, u32)> {
        if repo_ids.is_empty() {
            return Ok((0, 0));
        }
        let (table, opened, closed) = match alert_type {
            "secret_scanning" => ("secrets", "found_at", "decided_at"),
            "code_scanning" => ("code_alerts", "created_at", "COALESCE(fixed_at, dismissed_at)"),
            _ => ("vulnerabilities", "found_at", "COALESCE(fixed_at, dismissed_at)"),
        };
        let mut totals = (0u32, 0u32);
        for chunk in repo_ids.chunks(80) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut binds: Vec<JsValue> = vec![since.into(), since.into()];
            binds.extend(chunk.iter().map(|id| JsValue::from(id.as_str())));
            #[derive(Deserialize)]
            struct Row {
                opened: Option<i64>,
                closed: Option<i64>,
            }
            let row = self
                .db
                .prepare(format!(
                    "SELECT sum({opened} >= ?1) AS opened, sum({closed} IS NOT NULL AND {closed} >= ?2) AS closed
                     FROM {table} WHERE repo_id IN ({marks})"
                ))
                .bind(&binds)?
                .first::<Row>(None)
                .await?;
            if let Some(row) = row {
                totals.0 += row.opened.unwrap_or(0).max(0) as u32;
                totals.1 += row.closed.unwrap_or(0).max(0) as u32;
            }
        }
        Ok(totals)
    }

    pub async fn snapshot(&self, repo_id: &str, namespace: &str, day: &str, alert_type: &str, counts: &SeverityCounts) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO snapshots (repo_id, namespace, day, alert_type, critical, high, medium, low, unknown)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT (repo_id, day, alert_type) DO UPDATE SET namespace = ?2, critical = ?5, high = ?6, medium = ?7,
                   low = ?8, unknown = ?9",
            )
            .bind(&[
                repo_id.into(),
                namespace.into(),
                day.into(),
                alert_type.into(),
                counts.critical.into(),
                counts.high.into(),
                counts.medium.into(),
                counts.low.into(),
                counts.unknown.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Repositories without today's snapshot.
    pub async fn unsnapshotted(&self, day: &str, limit: u32) -> Result<Vec<crate::store::RepoRow>> {
        self.db
            .prepare(
                "SELECT * FROM repos r WHERE NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.repo_id = r.repo_id AND s.day = ?)
                 ORDER BY r.repo_id LIMIT ?",
            )
            .bind(&[day.into(), limit.into()])?
            .all()
            .await?
            .results::<crate::store::RepoRow>()
    }

    pub async fn snapshots(&self, namespace: &str, since: &str, repo_ids: &[String]) -> Result<Vec<SnapshotRow>> {
        let wanted: BTreeSet<&str> = repo_ids.iter().map(String::as_str).collect();
        #[derive(Deserialize)]
        struct Row {
            repo_id: String,
            #[serde(flatten)]
            snapshot: SnapshotRow,
        }
        Ok(self
            .db
            .prepare("SELECT * FROM snapshots WHERE namespace = ? AND day >= ? ORDER BY day")
            .bind(&[namespace.into(), since.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .filter(|row| wanted.contains(row.repo_id.as_str()))
            .map(|row| row.snapshot)
            .collect())
    }

    /// When code scanning last reported on a repository's default branch.
    pub async fn last_analysis_at(&self, repo_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            at: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT max(created_at) AS at FROM analyses WHERE repo_id = ? AND pull IS NULL")
            .bind(&[repo_id.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.at))
    }

    /// Published patterns covering a repository, its own and its workspace's.
    pub async fn pattern_count(&self, namespace: &str, repo_id: &str) -> Result<u32> {
        Ok(self
            .db
            .prepare(
                "SELECT count(*) AS n FROM custom_patterns WHERE namespace = ? AND state = 'published' AND (repo_id IS NULL OR repo_id = ?)",
            )
            .bind(&[namespace.into(), repo_id.into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n.max(0) as u32))
    }
}
