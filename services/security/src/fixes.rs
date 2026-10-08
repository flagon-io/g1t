//! "Fix with g1t": an alert becomes an issue assigned to g1t, which writes
//! the fix in a pull request that lands through the repository's required
//! checks, as any agent's work does. Nothing new is built for it: it is the
//! issue → agent → checks → queue pipeline, and the agent's run is charged
//! as agent usage.

use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::{SecretFinding, Vulnerability};
use g1t_contracts::security_suite::{AlertFix, AlertType, CodeAlert, FixAlertArgs, PaidFeature};
use g1t_contracts::work::{Issue, OpenIssueArgs, with_definition_of_done};
use g1t_contracts::{FailureCode, Outcome};
use serde_json::{Value, json};
use worker::Result;

use crate::Security;
use crate::store::{Activity, VulnRow};

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

const FOOTER: &str = "\n\n---\n_Opened from a security alert with Fix with g1t. The pull request lands through this repository's required checks._";

/// The issue for a code scanning alert.
pub fn code_issue(alert: &CodeAlert, page: &str) -> (String, String) {
    let place = match (&alert.path, alert.start_line) {
        (Some(path), Some(line)) => format!("`{path}` line {line}"),
        (Some(path), None) => format!("`{path}`"),
        _ => "the repository".to_owned(),
    };
    let rule = alert.rule_name.as_deref().unwrap_or(&alert.rule_id);
    let title = format!("Fix code scanning alert #{}: {rule}", alert.number);
    let mut body = format!(
        "{} reports **{}** ({}) in {place}:\n\n> {}\n\n",
        alert.tool,
        alert.rule_id,
        alert.security_severity.as_deref().unwrap_or(&alert.level),
        alert.message.replace('\n', "\n> ")
    );
    if let Some(description) = &alert.rule_description {
        body.push_str(&format!("{description}\n\n"));
    }
    if let Some(help) = &alert.help {
        body.push_str(&format!("<details><summary>About this rule</summary>\n\n{help}\n\n</details>\n\n"));
    }
    body.push_str(&format!(
        "Change the code so the problem is gone, not hidden: no suppression comments, and no change to the analysis. \
         Keep the change to what the fix needs. The alert: {page}\n"
    ));
    let done = vec![
        format!("{} no longer reports `{}` at {place} when it runs on the pull request.", alert.tool, alert.rule_id),
        "The project's tests still pass.".to_owned(),
    ];
    (title, format!("{}{FOOTER}", with_definition_of_done(&body, &done)))
}

/// The issue for a leaked secret: take it out of the code. Rotating it is
/// the person's: only they can at its issuer.
pub fn secret_issue(secret: &SecretFinding, page: &str) -> (String, String) {
    let title = format!("Remove {} from {}", secret.label, secret.path);
    let body = format!(
        "{} (`{}`) is in `{}` at line {}, committed in {}. Take it out of the code and read it from configuration \
         instead: an environment variable, or the repository's Actions secrets for workflows. Do not write the value \
         anywhere else, including in tests, docs or this pull request.\n\nRemoving it from the code does not make it \
         safe: it is in the history. Whoever owns it has to rotate it at its issuer, then mark the alert revoked. \
         The alert: {page}\n",
        secret.label,
        secret.preview,
        secret.path,
        secret.line,
        &secret.commit[..secret.commit.len().min(7)],
    );
    let done = vec![format!("`{}` no longer holds the secret, and nothing else does instead.", secret.path), "The project's tests still pass.".to_owned()];
    (title, format!("{}{FOOTER}", with_definition_of_done(&body, &done)))
}

impl Security {
    pub(crate) async fn fix_alert(&self, a: FixAlertArgs) -> Result<Outcome<AlertFix>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let page = |rest: &str| format!("https://g1t.sh{}", crate::suite::link(&repo, rest));
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let (title, body, labels, existing) = match AlertType::of_id(&a.id) {
            Some(AlertType::CodeScanning) => {
                if let Some(refusal) = self.gate(&repo, PaidFeature::CodeScanning).await? {
                    return Ok(refusal);
                }
                let Some(alert) = self.store.code_alert_by_id(&repo.repo_id, &a.id).await? else {
                    return Ok(fail(FailureCode::NotFound, "No such alert."));
                };
                let (title, body) = code_issue(&alert, &page(&format!("code-scanning/{}", alert.number)));
                (title, body, vec!["security".to_owned(), "code-scanning".to_owned()], alert.issue)
            }
            Some(AlertType::SecretScanning) => {
                let Some(secret) = self.store.secret(&repo.repo_id, &a.id).await? else {
                    return Ok(fail(FailureCode::NotFound, "No such alert."));
                };
                if secret.status == g1t_contracts::security::SecretStatus::Blocked {
                    return Ok(fail(FailureCode::Conflict, "This secret never landed: take it out of your commit and push again."));
                }
                let (title, body) = secret_issue(&secret, &page(&format!("secret-scanning/{}", secret.id)));
                (title, body, vec!["security".to_owned()], self.store.fix_issue(&a.id).await?)
            }
            Some(AlertType::Vulnerability) => {
                let Some(vuln) = self.store.vulnerability(&repo.repo_id, &a.id).await? else {
                    return Ok(fail(FailureCode::NotFound, "No such alert."));
                };
                let (title, body) = self.vulnerability_issue(&repo.repo_id, &vuln).await?;
                (title, body, vec!["dependencies".to_owned(), "security".to_owned()], self.store.fix_issue(&a.id).await?.or(vuln.issue))
            }
            None => return Ok(fail(FailureCode::NotFound, "No such alert.")),
        };
        if let Some(number) = existing
            && self.issue(&a.actor, &path, number).await?.is_some_and(|issue| issue.state == g1t_contracts::work::State::Open)
        {
            return Ok(Outcome::Ok(AlertFix { issue: number, started: false, message: Some(format!("g1t is already on it in #{number}.")) }));
        }
        let opened: Outcome<Issue> = g1t_kit::call(
            &self.work,
            "open_issue",
            &OpenIssueArgs { actor: a.actor.clone(), repo: path.clone(), title: title.chars().take(200).collect(), body, labels, checks: Vec::new(), milestone: None },
        )
        .await?;
        let issue = match opened {
            Outcome::Ok(issue) => issue,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        match AlertType::of_id(&a.id) {
            Some(AlertType::CodeScanning) => self.store.set_code_issue(&repo.repo_id, &a.id, issue.number).await?,
            _ => self.store.add_fix(&repo.repo_id, &a.id, issue.number, &a.actor.username).await?,
        }
        self.store
            .record(&repo.repo_id, &[Activity {
                alert_id: &a.id,
                action: "fix_requested",
                actor: Some(&a.actor.username),
                reason: None,
                comment: None,
                number: Some(issue.number),
            }])
            .await?;
        // g1t takes it, as the person who asked: their agent usage.
        let started: Outcome<Value> = g1t_kit::call(&self.runner, "run", &json!({ "actor": a.actor, "repo": path, "issue": issue.number })).await?;
        Ok(Outcome::Ok(match started {
            Outcome::Ok(_) => AlertFix { issue: issue.number, started: true, message: None },
            Outcome::Fail(refused) => AlertFix {
                issue: issue.number,
                started: false,
                message: Some(format!("The issue is open, but g1t could not start on it: {}", refused.message)),
            },
        }))
    }

    async fn vulnerability_issue(&self, repo_id: &str, vuln: &Vulnerability) -> Result<(String, String)> {
        let open = self.store.open_vulnerabilities(repo_id).await?;
        let rows: Vec<&VulnRow> = open.iter().filter(|row| row.ecosystem == vuln.ecosystem && row.package == vuln.package).collect();
        let target = vuln.fixed_version.clone().unwrap_or_else(|| "a version without these advisories".to_owned());
        let body = crate::deps::issue_text(&vuln.ecosystem, &vuln.package, &target, &rows, &[]);
        Ok((format!("Upgrade {} to {target}", vuln.package), body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::security::AlertState;

    #[test]
    fn a_code_alert_becomes_an_issue_with_a_definition_of_done() {
        let alert = CodeAlert {
            id: "cod_1".into(),
            number: 4,
            repo_id: "rep_1".into(),
            tool: "Semgrep OSS".into(),
            category: "Semgrep OSS".into(),
            rule_id: "javascript.browser.security.eval-detected.eval-detected".into(),
            rule_name: None,
            rule_description: Some("Detected the use of eval().".into()),
            help: None,
            help_uri: None,
            tags: Vec::new(),
            level: "warning".into(),
            security_severity: None,
            severity: "medium".into(),
            message: "Detected the use of eval().".into(),
            path: Some("src/server.js".into()),
            start_line: Some(10),
            end_line: Some(10),
            start_column: None,
            end_column: None,
            state: AlertState::Open,
            fingerprint: "f".into(),
            first_commit: "c".into(),
            last_commit: "c".into(),
            created_at: String::new(),
            updated_at: String::new(),
            fixed_at: None,
            dismissed_by: None,
            dismissed_reason: None,
            dismissed_comment: None,
            dismissed_at: None,
            issue: None,
        };
        let (title, body) = code_issue(&alert, "https://g1t.sh/acme/rocket/security/code-scanning/4");
        assert_eq!(title, "Fix code scanning alert #4: javascript.browser.security.eval-detected.eval-detected");
        assert!(body.contains("in `src/server.js` line 10"));
        assert!(body.contains("## Definition of done"));
        assert!(body.contains("no longer reports"));
        assert!(body.contains("no suppression comments"));
    }
}
