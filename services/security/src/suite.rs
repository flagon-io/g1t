//! What the security suite's parts share: whether a repository has the
//! paid features, telling people (events for webhooks and the inbox), and
//! the audit log.
//!
//! Who hears what: per-alert events (`<type>.created`, `.fixed`, …) go to
//! webhooks. The inbox reads the one summary each scan publishes
//! (summaries.rs), bypass requests and their answers, and vulnerability
//! reports; each names the workspace's owners and security managers as
//! `notify`, and its members as `members`, those who may see findings.

use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::billing::{Feature, HasFeatureArgs};
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::identity::{ListMembersArgs, Member};
use g1t_contracts::advisories::AdvisoryEvent;
use g1t_contracts::security_suite::{AlertType, EVENT_TYPES, PaidFeature, SecurityEvent, SecuritySummary, needs_activation};
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

    /// Publishes a security event about one alert, for webhooks (and, for
    /// a bypass request, the inbox). What the inbox tells people of new
    /// alerts comes from the scan's summary (summaries.rs), not from these.
    /// Failing to publish never fails the change.
    pub(crate) async fn publish(&self, kind: &str, repo: &RepoRow, event: SecurityEvent, actor_id: Option<String>) {
        let data = serde_json::to_value(&event).unwrap_or_default();
        let audience = kind == "secret_scanning.bypass_requested" && event.notify.is_empty();
        self.publish_data(kind, repo, data, audience, actor_id).await;
    }

    /// Publishes a scan's summary (`<type>.summary`): the inbox's one item
    /// per repository and alert type, told to the workspace's owners and
    /// security managers, and to watchers who chose security and may see
    /// findings.
    pub(crate) async fn publish_summary(&self, kind: &str, repo: &RepoRow, summary: &SecuritySummary, actor_id: Option<String>) {
        let data = serde_json::to_value(summary).unwrap_or_default();
        self.publish_data(kind, repo, data, true, actor_id).await;
    }

    /// Publishes an advisory event (`security_advisory.*`). A report tells
    /// the owners and security managers; a published advisory, webhooks
    /// and the repository's security watchers.
    pub(crate) async fn publish_advisory(&self, kind: &str, repo: &RepoRow, event: &AdvisoryEvent, actor_id: Option<String>) {
        let data = serde_json::to_value(event).unwrap_or_default();
        self.publish_data(kind, repo, data, kind == "security_advisory.reported" || kind == "security_advisory.published", actor_id).await;
    }

    /// Publishes one of [`EVENT_TYPES`]. With `audience`, `notify` (when
    /// empty) becomes the workspace's owners and security managers, and
    /// `members` names its members, as those who may see findings.
    async fn publish_data(&self, kind: &str, repo: &RepoRow, mut data: serde_json::Value, audience: bool, actor_id: Option<String>) {
        let Some(kind) = EVENT_TYPES.iter().copied().find(|known| *known == kind) else {
            worker::console_error!("security: no event called {kind}");
            return;
        };
        let Some(events) = &self.events else { return };
        if audience {
            let members = self.members(&repo.namespace).await;
            if data["notify"].as_array().is_none_or(Vec::is_empty) {
                data["notify"] = serde_json::json!(
                    members
                        .iter()
                        .filter(|member| member.role == Role::Owner || member.org_roles.contains(&g1t_contracts::OrgRole::SecurityManager))
                        .map(|member| member.username.clone())
                        .collect::<Vec<_>>()
                );
            }
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
