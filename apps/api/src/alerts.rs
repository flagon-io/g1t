//! Security alerts as the API gives them: a secret found in a repository,
//! or a dependency with a known vulnerability, in one flat `snake_case`
//! shape with `kind` saying which.
//!
//! The security service keeps them as `SecretFinding` and `Vulnerability`
//! (see `g1t_contracts::security`); this is the public form of both.

use g1t_contracts::security::{
    AlertChange, AlertState, DismissReason, SecretFinding, SecretStatus, SecurityUpdate, UpdateState,
    Vulnerability,
};
use serde::{Deserialize, Serialize};

/// Which kind of alert.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Secret,
    Dependency,
}

impl AlertKind {
    pub const ALL: [AlertKind; 2] = [AlertKind::Secret, AlertKind::Dependency];

    pub fn as_str(self) -> &'static str {
        match self {
            AlertKind::Secret => "secret",
            AlertKind::Dependency => "dependency",
        }
    }

    pub fn parse(text: &str) -> Option<AlertKind> {
        AlertKind::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// The kind an alert's id names: `sec_…` or `vul_…`.
    pub fn of_id(id: &str) -> Option<AlertKind> {
        if id.starts_with("sec_") {
            Some(AlertKind::Secret)
        } else if id.starts_with("vul_") {
            Some(AlertKind::Dependency)
        } else {
            None
        }
    }

    /// Whether `reason` can dismiss an alert of this kind.
    pub fn takes(self, reason: DismissReason) -> bool {
        reason.for_secrets() == (self == AlertKind::Secret)
    }

    /// The reasons that dismiss an alert of this kind, as words.
    pub fn reasons(self) -> Vec<&'static str> {
        DismissReason::ALL
            .into_iter()
            .filter(|reason| self.takes(*reason))
            .map(DismissReason::as_str)
            .collect()
    }
}

/// One alert.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecurityAlert {
    pub kind: AlertKind,
    /// `sec_…` for a secret, `vul_…` for a dependency.
    pub id: String,
    pub state: AlertState,
    #[serde(flatten)]
    pub detail: AlertDetail,
    /// RFC 3339.
    pub found_at: String,
    /// Why it was dismissed (or, for a secret, revoked); null while open.
    pub dismissed_reason: Option<DismissReason>,
    pub dismissed_comment: Option<String>,
    /// Who dismissed it.
    pub dismissed_by: Option<String>,
    /// RFC 3339.
    pub dismissed_at: Option<String>,
}

/// What only one kind of alert has.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AlertDetail {
    Secret(SecretDetail),
    Dependency(DependencyDetail),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecretDetail {
    /// `aws_access_key`, `github_token`, …
    pub secret_type: String,
    /// "an AWS access key".
    pub label: String,
    pub path: String,
    pub line: u32,
    pub commit: String,
    /// Enough of it to recognise; the secret itself is never kept.
    pub preview: String,
    /// open, blocked, allowed or resolved.
    pub status: SecretStatus,
    /// `push` or `history`.
    pub source: String,
    /// Why the value looks made for tests or documentation, when it does.
    pub test_value: Option<String>,
    /// Who pushed it, for a push.
    pub found_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DependencyDetail {
    pub ecosystem: String,
    pub package: String,
    pub version: String,
    /// The lockfile that resolves it.
    pub manifest: String,
    pub advisory: String,
    pub osv_id: String,
    pub summary: String,
    pub severity: String,
    /// Null when no patched version is available.
    pub fixed_version: Option<String>,
    pub fixed_at: Option<String>,
    /// The pull request g1t opens to upgrade it, once started.
    pub update: Option<AlertUpdate>,
}

/// The security update for a dependency's package.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AlertUpdate {
    pub state: UpdateState,
    pub target: String,
    pub branch: Option<String>,
    pub pull: Option<u32>,
    pub issue: Option<u32>,
    pub error: Option<String>,
    pub updated_at: String,
}

impl From<SecurityUpdate> for AlertUpdate {
    fn from(update: SecurityUpdate) -> Self {
        AlertUpdate {
            state: update.state,
            target: update.target,
            branch: update.branch,
            pull: update.pull,
            issue: update.issue,
            error: update.error,
            updated_at: update.updated_at,
        }
    }
}

impl From<SecretFinding> for SecurityAlert {
    fn from(secret: SecretFinding) -> Self {
        let decided = secret.state != AlertState::Open;
        SecurityAlert {
            kind: AlertKind::Secret,
            id: secret.id,
            state: secret.state,
            detail: AlertDetail::Secret(SecretDetail {
                secret_type: secret.kind,
                label: secret.label,
                path: secret.path,
                line: secret.line,
                commit: secret.commit,
                preview: secret.preview,
                status: secret.status,
                source: secret.source,
                test_value: secret.test_value,
                found_by: secret.found_by,
            }),
            found_at: secret.found_at,
            dismissed_reason: secret.dismissed_reason.filter(|_| decided),
            dismissed_comment: secret.reason.filter(|_| decided),
            dismissed_by: secret.decided_by.filter(|_| decided),
            dismissed_at: secret.decided_at.filter(|_| decided),
        }
    }
}

impl From<Vulnerability> for SecurityAlert {
    fn from(vulnerability: Vulnerability) -> Self {
        let dismissed = vulnerability.state == AlertState::Dismissed;
        SecurityAlert {
            kind: AlertKind::Dependency,
            id: vulnerability.id,
            state: vulnerability.state,
            detail: AlertDetail::Dependency(DependencyDetail {
                ecosystem: vulnerability.ecosystem,
                package: vulnerability.package,
                version: vulnerability.version,
                manifest: vulnerability.manifest,
                advisory: vulnerability.advisory,
                osv_id: vulnerability.osv_id,
                summary: vulnerability.summary,
                severity: vulnerability.severity,
                fixed_version: vulnerability.fixed_version,
                fixed_at: vulnerability.fixed_at,
                update: vulnerability.update.map(AlertUpdate::from),
            }),
            found_at: vulnerability.found_at,
            dismissed_reason: vulnerability.dismissed_reason.filter(|_| dismissed),
            dismissed_comment: vulnerability.dismissed_comment.filter(|_| dismissed),
            dismissed_by: vulnerability.dismissed_by.filter(|_| dismissed),
            dismissed_at: vulnerability.dismissed_at.filter(|_| dismissed),
        }
    }
}

impl SecurityAlert {
    /// The alert `dismiss` or `reopen` changed, if it names one.
    pub fn from_change(change: AlertChange) -> Option<SecurityAlert> {
        change
            .secret
            .map(SecurityAlert::from)
            .or_else(|| change.vulnerability.map(SecurityAlert::from))
    }
}

/// Secrets, then dependencies, filtered by state and kind when given.
pub fn list(
    secrets: Vec<SecretFinding>,
    vulnerabilities: Vec<Vulnerability>,
    state: Option<AlertState>,
    kind: Option<AlertKind>,
) -> Vec<SecurityAlert> {
    let secrets = secrets.into_iter().map(SecurityAlert::from);
    let dependencies = vulnerabilities.into_iter().map(SecurityAlert::from);
    secrets
        .chain(dependencies)
        .filter(|alert| state.is_none_or(|state| alert.state == state))
        .filter(|alert| kind.is_none_or(|kind| alert.kind == kind))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn secret(state: AlertState) -> SecretFinding {
        serde_json::from_value(json!({
            "id": "sec_1",
            "repoId": "rep_1",
            "kind": "aws_access_key",
            "label": "an AWS access key",
            "path": "config/dev.env",
            "line": 3,
            "commit": "9f2c1e0",
            "preview": "AKIA…MPLE",
            "status": if state == AlertState::Open { "open" } else { "allowed" },
            "source": "history",
            "foundBy": null,
            "foundAt": "2026-10-01T12:00:00Z",
            "decidedBy": "ada",
            "reason": "Only in the test fixtures.",
            "decidedAt": "2026-10-02T09:00:00Z",
            "dismissedReason": "used_in_tests",
            "testValue": "a documented example key",
            "state": state,
        }))
        .unwrap()
    }

    fn vulnerability() -> Vulnerability {
        serde_json::from_value(json!({
            "id": "vul_1",
            "repoId": "rep_1",
            "ecosystem": "npm",
            "package": "lodash",
            "version": "4.17.20",
            "manifest": "package-lock.json",
            "advisory": "GHSA-35jh-r3h4-6jhm",
            "osvId": "GHSA-35jh-r3h4-6jhm",
            "summary": "Command injection in lodash",
            "severity": "high",
            "fixedVersion": null,
            "status": "open",
            "issue": null,
            "foundAt": "2026-10-01T12:00:00Z",
            "fixedAt": null,
            "state": "open",
            "update": { "state": "open", "target": "4.17.21", "branch": "g1t/security/lodash-4.17.21", "pull": 12, "issue": null, "error": null, "updatedAt": "2026-10-01T12:05:00Z" },
        }))
        .unwrap()
    }

    fn keys(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    out.push(key.clone());
                    keys(value, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| keys(item, out)),
            _ => {}
        }
    }

    #[test]
    fn an_alert_is_snake_case_in_one_flat_shape() {
        let alerts = list(vec![secret(AlertState::Dismissed)], vec![vulnerability()], None, None);
        let sent = serde_json::to_value(&alerts).unwrap();
        assert!(g1t_kit::wire::camel_case_keys(&sent).is_empty(), "{sent}");
        let mut names = Vec::new();
        keys(&sent, &mut names);
        for name in names {
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}");
        }
        let (secret, dependency) = (&sent[0], &sent[1]);
        assert_eq!(secret["kind"], "secret");
        assert_eq!(secret["secret_type"], "aws_access_key");
        assert_eq!(secret["dismissed_reason"], "used_in_tests");
        assert_eq!(secret["dismissed_comment"], "Only in the test fixtures.");
        assert_eq!(secret["dismissed_by"], "ada");
        assert!(secret.get("package").is_none());
        assert_eq!(dependency["kind"], "dependency");
        // No patched version is a null, not a missing field.
        assert!(dependency["fixed_version"].is_null() && dependency.get("fixed_version").is_some());
        assert_eq!(dependency["update"]["updated_at"], "2026-10-01T12:05:00Z");
        assert!(dependency["dismissed_reason"].is_null());
        assert!(dependency.get("secret_type").is_none());
        // And it reads back as it was.
        let again: Vec<SecurityAlert> = serde_json::from_value(sent).unwrap();
        assert_eq!(again, alerts);
    }

    #[test]
    fn an_open_secret_shows_no_decision() {
        let alert = SecurityAlert::from(secret(AlertState::Open));
        assert_eq!(alert.dismissed_reason, None);
        assert_eq!(alert.dismissed_by, None);
        assert_eq!(alert.dismissed_comment, None);
    }

    #[test]
    fn alerts_filter_by_state_and_kind() {
        let all = || (vec![secret(AlertState::Dismissed)], vec![vulnerability()]);
        let (s, v) = all();
        assert_eq!(list(s, v, Some(AlertState::Open), None).len(), 1);
        let (s, v) = all();
        let secrets = list(s, v, None, Some(AlertKind::Secret));
        assert_eq!(secrets.len(), 1);
        assert_eq!(secrets[0].kind, AlertKind::Secret);
        let (s, v) = all();
        assert!(list(s, v, Some(AlertState::Fixed), None).is_empty());
    }

    #[test]
    fn each_kind_takes_its_own_reasons() {
        assert_eq!(AlertKind::Secret.reasons(), ["false_positive", "used_in_tests", "revoked", "wont_fix"]);
        assert_eq!(
            AlertKind::Dependency.reasons(),
            ["fix_started", "no_bandwidth", "tolerable_risk", "inaccurate", "not_used"]
        );
        assert_eq!(AlertKind::of_id("sec_9"), Some(AlertKind::Secret));
        assert_eq!(AlertKind::of_id("vul_9"), Some(AlertKind::Dependency));
        assert_eq!(AlertKind::of_id("x"), None);
    }
}
