//! Secret alerts beyond the list: every place a secret was found, pushing
//! past push protection with a reason (or asking to, when the workspace
//! delegates bypasses to its owners and the repository's admins), and
//! asking a secret's issuer whether it still works.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::security::{AlertActivity, NewSecret, SecretFinding, SecretStatus};
use g1t_contracts::security_suite::{
    AlertType, BypassArgs, BypassReason, BypassRequest, BypassRequestsArgs, BypassResult, CheckSecretArgs, CheckValidityArgs,
    PaidFeature, ReviewBypassArgs, SecretAlertArgs, SecretAlertDetail, SecretValidity, SecurityEvent,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, User};
use g1t_kit::now_ms;
use g1t_scan::secrets::SecretKind;
use worker::Result;

use crate::Security;
use crate::store::{Activity, RepoRow};
use crate::suite::link;

const MAX_COMMENT_CHARS: usize = 500;
/// Validity checks the sweep makes per repository, and how often a secret
/// is asked about again.
const CHECKS_PER_SWEEP: u32 = 10;
const RECHECK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// How a sentence names a secret: its format's label, or its custom
/// pattern's.
pub fn label_of(kind: &str, pattern_name: Option<&str>) -> String {
    if kind == g1t_scan::custom::KIND {
        return g1t_scan::custom::label(pattern_name.unwrap_or("custom"));
    }
    SecretKind::parse(kind).map_or("a secret", |kind| kind.label()).to_owned()
}

/// "An AWS access key in config/prod.env": a secret alert's title.
pub fn title_of(secret: &SecretFinding) -> String {
    let mut label = secret.label.clone();
    if let Some(first) = label.get(..1) {
        label = format!("{}{}", first.to_uppercase(), &label[1..]);
    }
    format!("{label} in {}", secret.path)
}

/// The event that tells of a secret alert.
pub fn secret_event(repo: &RepoRow, secret: &SecretFinding) -> SecurityEvent {
    SecurityEvent {
        repo_id: repo.repo_id.clone(),
        alert_id: secret.id.clone(),
        alert_type: AlertType::SecretScanning.as_str().to_owned(),
        severity: if secret.test_value.is_some() { "low" } else { "critical" }.to_owned(),
        title: title_of(secret),
        link: link(repo, &format!("secret-scanning/{}", secret.id)),
        path: Some(secret.path.clone()),
        line: Some(secret.line),
        state: secret.state.as_str().to_owned(),
        ..SecurityEvent::default()
    }
}

/// Whether a person reviews bypass requests in this repository: an owner
/// or a security manager of its workspace, or one of its admins.
fn reviews_bypasses(user: &User, repo: &RepoRow) -> bool {
    user.manages_security(&repo.namespace)
        || access::can(Some(user), access::RepoRef { id: &repo.repo_id, namespace: &repo.namespace, private: true }, Capability::ManageSecurity)
}

impl Security {
    /// Records where new secrets were found and publishes an alert for each
    /// one seen for the first time. `fresh` are the fingerprints not known
    /// before; `pusher` is who pushed, for a blocked push.
    pub(crate) async fn secrets_found(&self, repo: &RepoRow, secrets: &[NewSecret], source: &str, fresh: &[String], pusher: Option<&str>) -> Result<()> {
        self.store.note_found(&repo.repo_id, secrets, source).await?;
        let known = self.store.known(&repo.repo_id, fresh).await?;
        for (_, id, _) in known.iter().take(20) {
            if let Some(secret) = self.store.secret(&repo.repo_id, id).await? {
                let mut event = secret_event(repo, &secret);
                event.pusher = pusher.filter(|_| secret.status == SecretStatus::Blocked).map(str::to_owned);
                self.alert_event(AlertType::SecretScanning, "created", repo, event, None).await;
            }
        }
        Ok(())
    }

    pub(crate) async fn secret_alert(&self, a: SecretAlertArgs) -> Result<Outcome<SecretAlertDetail>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(secret) = self.store.secret(&repo.repo_id, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        let activity: Vec<AlertActivity> =
            self.store.activity(&repo.repo_id, 500).await?.into_iter().filter(|item| item.alert_id == secret.id).collect();
        let workspace = self.store.workspace_settings(&repo.namespace).await?;
        let viewer = a.viewer.as_ref();
        let blocked = secret.status == SecretStatus::Blocked && secret.bypass.is_none();
        let reviewer = viewer.is_some_and(|user| reviews_bypasses(user, &repo));
        let delegated = workspace.delegated_bypass && self.entitled(&repo).await?;
        Ok(Outcome::Ok(SecretAlertDetail {
            locations: self.store.locations(&secret.id).await?,
            requests: self.store.requests_for_secret(&secret.id).await?.iter().map(|row| row.contract()).collect(),
            checkable: SecretKind::parse(&secret.kind).is_some_and(|kind| g1t_scan::validity::SUPPORTED.contains(&kind)),
            can_bypass: blocked && (!delegated || reviewer),
            can_request_bypass: blocked && delegated && !reviewer,
            activity,
            secret,
        }))
    }

    pub(crate) async fn bypass(&self, a: BypassArgs) -> Result<Outcome<BypassResult>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let Some(secret) = self.store.secret(&repo.repo_id, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        if secret.status != SecretStatus::Blocked || secret.bypass.is_some() {
            return Ok(fail(FailureCode::Conflict, "Only a secret push protection blocked, and not bypassed yet, can be bypassed."));
        }
        let comment: String = a.comment.trim().chars().take(MAX_COMMENT_CHARS).collect();
        let comment = (!comment.is_empty()).then_some(comment);
        let workspace = self.store.workspace_settings(&repo.namespace).await?;
        let delegated = workspace.delegated_bypass && self.entitled(&repo).await?;
        if delegated && !reviews_bypasses(&a.actor, &repo) {
            // Asked for, not made: an owner or admin decides.
            if let Some(pending) = self.store.pending_request(&secret.id, &a.actor.username).await? {
                return Ok(Outcome::Ok(BypassResult { secret, request: Some(pending.contract()) }));
            }
            let id = self
                .store
                .add_request(&repo.repo_id, &repo.namespace, &secret.id, &a.actor.username, a.reason, comment.as_deref())
                .await?;
            self.store
                .record(&repo.repo_id, &[Activity {
                    alert_id: &secret.id,
                    action: "bypass_requested",
                    actor: Some(&a.actor.username),
                    reason: None,
                    comment: Some(a.reason.label()),
                    number: None,
                }])
                .await?;
            let request = self.store.request(&id).await?.map(|row| row.contract());
            let reviewers = self.bypass_reviewers(&repo).await;
            let event = SecurityEvent {
                request_id: Some(id.clone()),
                reason: Some(a.reason.as_str().to_owned()),
                notify: reviewers.into_iter().filter(|name| !name.eq_ignore_ascii_case(&a.actor.username)).collect(),
                link: format!("/{}/-/security/bypass-requests", repo.namespace),
                ..secret_event(&repo, &secret)
            };
            self.publish("secret_scanning.bypass_requested", &repo, event, Some(a.actor.id.clone())).await;
            self.audit(
                &a.actor,
                "secret_scanning.bypass_requested",
                Some(&repo),
                &repo.namespace,
                Some(&secret.path),
                &format!("Asked to bypass push protection for {} ({})", title_of(&secret), a.reason.label()),
            )
            .await;
            return Ok(Outcome::Ok(BypassResult { secret, request }));
        }
        self.apply_bypass(&repo, &secret, a.reason, comment.as_deref(), &a.actor, None).await?;
        let secret = self.store.secret(&repo.repo_id, &a.id).await?.unwrap_or(secret);
        Ok(Outcome::Ok(BypassResult { secret, request: None }))
    }

    /// The people who review bypass requests that the inbox tells: the
    /// workspace's owners and security managers.
    async fn bypass_reviewers(&self, repo: &RepoRow) -> Vec<String> {
        self.members(&repo.namespace)
            .await
            .into_iter()
            .filter(|member| member.role == Role::Owner || member.org_roles.contains(&g1t_contracts::OrgRole::SecurityManager))
            .map(|member| member.username)
            .collect()
    }

    /// Lets a secret through: recorded on the alert, in its activity and in
    /// the audit log.
    async fn apply_bypass(
        &self,
        repo: &RepoRow,
        secret: &SecretFinding,
        reason: BypassReason,
        comment: Option<&str>,
        by: &User,
        approved_by: Option<&str>,
    ) -> Result<()> {
        self.store.bypass(&repo.repo_id, &secret.id, reason, comment, &by.username, approved_by).await?;
        self.store
            .record(&repo.repo_id, &[Activity {
                alert_id: &secret.id,
                action: "bypassed",
                actor: Some(&by.username),
                reason: reason.dismissal(),
                comment: Some(comment.unwrap_or(reason.label())),
                number: None,
            }])
            .await?;
        self.audit(
            by,
            "secret_scanning.bypass",
            Some(repo),
            &repo.namespace,
            Some(&secret.path),
            &format!(
                "Bypassed push protection for {} ({}){}",
                title_of(secret),
                reason.label(),
                approved_by.map(|who| format!(", approved by {who}")).unwrap_or_default()
            ),
        )
        .await;
        if let Some(dismissal) = reason.dismissal() {
            let event = SecurityEvent { reason: Some(dismissal.as_str().to_owned()), state: "dismissed".to_owned(), ..secret_event(repo, secret) };
            self.alert_event(AlertType::SecretScanning, "dismissed", repo, event, Some(by.id.clone())).await;
        }
        Ok(())
    }

    pub(crate) async fn bypass_requests(&self, a: BypassRequestsArgs) -> Result<Outcome<Vec<BypassRequest>>> {
        let workspace = a.workspace.to_lowercase();
        let Some(viewer) = a.viewer.as_ref().filter(|user| user.is_member(&workspace)) else {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        };
        let repo_id = match &a.repo {
            Some(path) => match self.member_repo(path, &a.viewer, crate::SEE_FINDINGS).await? {
                Outcome::Ok(repo) => Some(repo.repo_id),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        let owner = viewer.manages_security(&workspace);
        let mut shown = Vec::new();
        for row in self.store.requests(&workspace, repo_id.as_deref(), a.state.as_deref()).await? {
            // Reviewers see every request; anyone else their own.
            let reviewer = owner
                || access::can(Some(viewer), access::RepoRef { id: &row.repo_id, namespace: &workspace, private: true }, Capability::ManageSecurity);
            if reviewer || row.requester.eq_ignore_ascii_case(&viewer.username) {
                shown.push(row.contract());
            }
        }
        Ok(Outcome::Ok(shown))
    }

    pub(crate) async fn review_bypass(&self, a: ReviewBypassArgs) -> Result<Outcome<BypassRequest>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.is_member(&workspace) {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        }
        let Some(request) = self.store.request(&a.id).await?.filter(|row| row.namespace == workspace) else {
            return Ok(fail(FailureCode::NotFound, "No such request."));
        };
        let Some(repo) = self.store.repo(&request.repo_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such request."));
        };
        if request.state != "pending" {
            return Ok(fail(FailureCode::Conflict, format!("This request was {} already.", request.state)));
        }
        let comment: String = a.comment.trim().chars().take(MAX_COMMENT_CHARS).collect();
        let comment = (!comment.is_empty()).then_some(comment);
        let state = match a.decision.as_str() {
            "cancel" if request.requester.eq_ignore_ascii_case(&a.actor.username) => "cancelled",
            "cancel" => return Ok(fail(FailureCode::Forbidden, "Only whoever asked can cancel a request.")),
            "approve" | "deny" if !reviews_bypasses(&a.actor, &repo) => {
                return Ok(fail(FailureCode::Forbidden, "Only the workspace's owners and the repository's admins review bypass requests."));
            }
            "approve" | "deny" if request.requester.eq_ignore_ascii_case(&a.actor.username) => {
                return Ok(fail(FailureCode::Forbidden, "Someone else has to review your own request."));
            }
            "approve" => "approved",
            "deny" => "denied",
            _ => return Ok(fail(FailureCode::Invalid, "The decision is approve, deny or cancel.")),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        if !self.store.review_request(&a.id, state, &a.actor.username, comment.as_deref()).await? {
            return Ok(fail(FailureCode::Conflict, "This request was reviewed already."));
        }
        let reason = BypassReason::parse(&request.reason).unwrap_or(BypassReason::WillFixLater);
        let secret = self.store.secret(&repo.repo_id, &request.secret_id).await?;
        if let (Some(secret), "approved") = (&secret, state) {
            let requester = User { username: request.requester.clone(), ..User::default() };
            self.apply_bypass(&repo, secret, reason, request.comment.as_deref(), &requester, Some(&a.actor.username)).await?;
        }
        if let Some(secret) = &secret {
            self.store
                .record(&repo.repo_id, &[Activity {
                    alert_id: &secret.id,
                    action: match state {
                        "approved" => "bypass_approved",
                        "denied" => "bypass_denied",
                        _ => "bypass_cancelled",
                    },
                    actor: Some(&a.actor.username),
                    reason: None,
                    comment: comment.as_deref(),
                    number: None,
                }])
                .await?;
            if state != "cancelled" {
                let event = SecurityEvent {
                    request_id: Some(request.id.clone()),
                    state: state.to_owned(),
                    reason: Some(reason.as_str().to_owned()),
                    notify: vec![request.requester.clone()],
                    ..secret_event(&repo, secret)
                };
                self.publish("secret_scanning.bypass_reviewed", &repo, event, Some(a.actor.id.clone())).await;
            }
        }
        self.audit(
            &a.actor,
            "secret_scanning.bypass_reviewed",
            Some(&repo),
            &workspace,
            None,
            &format!("Bypass request {} by {} {state}", request.id, request.requester),
        )
        .await;
        let Some(row) = self.store.request(&a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such request."));
        };
        Ok(Outcome::Ok(row.contract()))
    }

    pub(crate) async fn check_validity(&self, a: CheckValidityArgs) -> Result<Outcome<SecretFinding>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Some(refusal) = self.gate(&repo, PaidFeature::ValidityChecks).await? {
            return Ok(refusal);
        }
        if !self.store.workspace_settings(&repo.namespace).await?.validity_checks {
            return Ok(fail(
                FailureCode::Conflict,
                "Validity checks are off for this workspace. An owner can turn them on in its Security settings.",
            ));
        }
        let Some(secret) = self.store.secret(&repo.repo_id, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        let validity = self.ask_issuer(&repo, &secret).await;
        self.store.set_validity(&repo.repo_id, &secret.id, &validity.validity).await?;
        if let Some(detail) = &validity.detail {
            worker::console_log!("security: validity of {} unknown: {detail}", secret.id);
        }
        Ok(match self.store.secret(&repo.repo_id, &a.id).await? {
            Some(secret) => Outcome::Ok(secret),
            None => fail(FailureCode::NotFound, "No such alert."),
        })
    }

    /// Asks the repos service, which can read the secret where it landed,
    /// to ask its issuer. A secret that never landed (blocked at a push)
    /// cannot be read again, so it is unknown.
    async fn ask_issuer(&self, repo: &RepoRow, secret: &SecretFinding) -> SecretValidity {
        let supported = SecretKind::parse(&secret.kind).is_some_and(|kind| g1t_scan::validity::SUPPORTED.contains(&kind));
        if !supported {
            return SecretValidity { validity: "unsupported".to_owned(), detail: None };
        }
        if secret.status == SecretStatus::Blocked {
            return SecretValidity { validity: "unknown".to_owned(), detail: Some("it never landed, so it cannot be read again".to_owned()) };
        }
        let fingerprint = match self.store.fingerprint_of(&repo.repo_id, &secret.id).await {
            Ok(Some(fingerprint)) => fingerprint,
            _ => return SecretValidity { validity: "unknown".to_owned(), detail: Some("no fingerprint".to_owned()) },
        };
        let asked: Result<SecretValidity> = g1t_kit::call(
            &self.repos,
            "check_secret",
            &CheckSecretArgs {
                repo_id: repo.repo_id.clone(),
                commit: secret.commit.clone(),
                path: secret.path.clone(),
                line: secret.line,
                kind: secret.kind.clone(),
                fingerprint,
            },
        )
        .await;
        asked.unwrap_or_else(|error| SecretValidity { validity: "unknown".to_owned(), detail: Some(error.to_string()) })
    }

    /// The sweep's part: in workspaces that turned validity checks on, open
    /// secrets not asked about for a week are asked about again.
    pub(crate) async fn sweep_validity(&self, repo: &RepoRow) -> Result<()> {
        if !self.store.workspace_settings(&repo.namespace).await?.validity_checks || !self.entitled(repo).await? {
            return Ok(());
        }
        let before = rfc3339(now_ms().saturating_sub(RECHECK_MS));
        for id in self.store.unchecked_secrets(&repo.repo_id, &before, CHECKS_PER_SWEEP).await? {
            if let Some(secret) = self.store.secret(&repo.repo_id, &id).await? {
                let validity = self.ask_issuer(repo, &secret).await;
                self.store.set_validity(&repo.repo_id, &id, &validity.validity).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_name_the_secret_and_its_file() {
        assert_eq!(label_of("aws_access_key", None), "an AWS access key");
        assert_eq!(label_of("custom_pattern", Some("Acme key")), "a match for the custom pattern \"Acme key\"");
        assert_eq!(label_of("unheard_of", None), "a secret");
    }

    #[test]
    fn owners_and_admins_review_bypasses() {
        let repo = RepoRow {
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
        };
        let member = |role| User {
            id: "usr_1".into(),
            username: "ana".into(),
            workspaces: vec![g1t_contracts::Membership { role, ..g1t_contracts::Membership::member("acme") }],
            ..User::default()
        };
        assert!(reviews_bypasses(&member(Role::Owner), &repo));
        assert!(!reviews_bypasses(&User { username: "eve".into(), ..User::default() }, &repo));
        // A security manager reviews them too; a plain member does not.
        let mut manager = member(Role::Member);
        manager.workspaces[0].base_permission = Some(g1t_contracts::access::BasePermission::None);
        assert!(!reviews_bypasses(&manager, &repo));
        manager.workspaces[0].org_roles.push(g1t_contracts::OrgRole::SecurityManager);
        assert!(reviews_bypasses(&manager, &repo));
    }
}
