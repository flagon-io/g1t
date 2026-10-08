//! What the security suite's parts share: whether a repository has the
//! paid features, telling people (events for webhooks and the inbox), and
//! the audit log.

use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::billing::{Feature, HasFeatureArgs};
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::identity::{ListMembersArgs, Member};
use g1t_contracts::security_suite::{AlertType, EVENT_TYPES, PaidFeature, SecurityEvent, needs_activation};
use g1t_contracts::{FailureCode, Outcome, Role, User, new_id};
use g1t_kit::now_ms;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;

/// The most workspace members an event names as able to see findings.
const MAX_MEMBERS_NAMED: usize = 500;

/// A failure for want of the activation.
pub fn payment_required<T>(feature: PaidFeature, workspace: &str) -> Outcome<T> {
    Outcome::fail(FailureCode::PaymentRequired, needs_activation(feature, workspace))
}

/// The page of a repository's security section: `/acme/rocket/security/…`.
pub fn link(repo: &RepoRow, rest: &str) -> String {
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        format!("/{}/{}/security", repo.namespace, repo.name)
    } else {
        format!("/{}/{}/security/{rest}", repo.namespace, repo.name)
    }
}

impl Security {
    /// Whether the workspace has the Security and quality activation (or
    /// has it included). When billing cannot say, it is taken as not: a
    /// paid feature waits rather than running unpaid.
    pub(crate) async fn activated(&self, namespace: &str) -> bool {
        let answer: Result<Outcome<bool>> = g1t_kit::call(
            &self.billing,
            "has_feature",
            &HasFeatureArgs { workspace: namespace.to_owned(), feature: Feature::Security },
        )
        .await;
        match answer {
            Ok(Outcome::Ok(on)) => on,
            Ok(Outcome::Fail(_)) => false,
            Err(error) => {
                worker::console_error!("security: has_feature for {namespace}: {error}");
                false
            }
        }
    }

    /// Whether a repository has the paid features: it is public, or its
    /// workspace has the activation.
    pub(crate) async fn entitled(&self, repo: &RepoRow) -> Result<bool> {
        let (_, private) = self.store.repo_settings(&repo.repo_id).await?;
        Ok(!private || self.activated(&repo.namespace).await)
    }

    /// `None` when the repository may use `feature`, or the refusal.
    pub(crate) async fn gate<T>(&self, repo: &RepoRow, feature: PaidFeature) -> Result<Option<Outcome<T>>> {
        Ok((!self.entitled(repo).await?).then(|| payment_required(feature, &repo.namespace)))
    }

    /// The workspace's members, as g1t sees them.
    pub(crate) async fn members(&self, namespace: &str) -> Vec<Member> {
        let found: Result<Outcome<Vec<Member>>> = g1t_kit::call(
            &self.identity,
            "list_members",
            &ListMembersArgs { slug: namespace.to_owned(), viewer: Some(User::system(namespace)) },
        )
        .await;
        match found {
            Ok(Outcome::Ok(members)) => members,
            Ok(Outcome::Fail(failure)) => {
                worker::console_error!("security: members of {namespace}: {}", failure.message);
                Vec::new()
            }
            Err(error) => {
                worker::console_error!("security: members of {namespace}: {error}");
                Vec::new()
            }
        }
    }

    /// Publishes a security event, for webhooks and the inbox. New alerts
    /// name the workspace's owners to tell, and its members as those who
    /// may see findings. Failing to publish never fails the change.
    pub(crate) async fn publish(&self, kind: &str, repo: &RepoRow, mut event: SecurityEvent, actor_id: Option<String>) {
        let Some(kind) = EVENT_TYPES.iter().copied().find(|known| *known == kind) else {
            worker::console_error!("security: no event called {kind}");
            return;
        };
        let Some(events) = &self.events else { return };
        let mut data = serde_json::to_value(&event).unwrap_or_default();
        if kind.ends_with(".created") || kind == "secret_scanning.bypass_requested" {
            let members = self.members(&repo.namespace).await;
            if event.notify.is_empty() {
                event.notify = members
                    .iter()
                    .filter(|member| member.role == Role::Owner || member.org_roles.contains(&g1t_contracts::OrgRole::SecurityManager))
                    .map(|member| member.username.clone())
                    .collect();
            }
            data = serde_json::to_value(&event).unwrap_or_default();
            data["members"] = serde_json::json!(
                members.iter().take(MAX_MEMBERS_NAMED).map(|member| member.username.clone()).collect::<Vec<_>>()
            );
        }
        let published: Result<serde_json::Value> = g1t_kit::call(
            events,
            "publish",
            &Publish {
                events: vec![NewEvent { kind, source: "security", repo_id: Some(repo.repo_id.clone()), actor: actor_id, data }],
            },
        )
        .await;
        if let Err(error) = published {
            worker::console_error!("security: {kind} for {} not published: {error}", repo.repo_id);
        }
    }

    /// Publishes `<type>.<action>` for one alert.
    pub(crate) async fn alert_event(&self, alert_type: AlertType, action: &str, repo: &RepoRow, event: SecurityEvent, actor_id: Option<String>) {
        let kind = format!("{}.{action}", alert_type.event_prefix());
        self.publish(&kind, repo, event, actor_id).await;
    }

    /// Records a security decision in the workspace's audit log.
    pub(crate) async fn audit(&self, actor: &User, action: &str, repo: Option<&RepoRow>, namespace: &str, path: Option<&str>, message: &str) {
        let Some(events) = &self.events else { return };
        let entry = NewAuditEntry {
            actor: AuditActor::of(actor),
            action: action.to_owned(),
            surface: Surface::Web,
            target: AuditTarget {
                workspace: namespace.to_owned(),
                repo: repo.map(|repo| format!("{}/{}", repo.namespace, repo.name)),
                path: path.map(str::to_owned),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: "security".to_owned(),
            result: Some("ok".to_owned()),
            message: Some(message.chars().take(500).collect()),
            request_id: new_id("req", now_ms()),
        };
        let recorded: Result<u32> = g1t_kit::call(events, "audit_record", &RecordAuditArgs { entries: vec![entry] }).await;
        if let Err(error) = recorded {
            worker::console_error!("security: audit entry {action} not recorded: {error}");
        }
    }
}
