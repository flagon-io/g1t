//! The audit log: who did what, with which credential, to what, and
//! whether it was allowed.
//!
//! Every action taken with a run credential is recorded, reads included,
//! and so is every change people and workspace tokens make through the API
//! and git. Refusals are recorded with the rule that refused them. Entries
//! are only ever appended.
//!
//! The events service keeps the log, beside the event log; the API and the
//! repos service, which see the requests, write to it. Methods, served at
//! `POST /rpc/<method>` on the events service:
//!
//! - `audit_record` takes `RecordAuditArgs` and returns how many were kept.
//! - `audit_list` takes `ListAuditArgs` and returns `AuditPage`. Callers
//!   check who may see a workspace's log and say so in `visibility`.

use serde::{Deserialize, Serialize};

use crate::credentials::{Acting, Decision};
use crate::{PrincipalKind, User};

/// What kind of actor did it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Person,
    Agent,
    /// A workspace's own access token.
    Workspace,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::Person => "person",
            ActorKind::Agent => "agent",
            ActorKind::Workspace => "workspace",
        }
    }
}

/// Whether the action was let through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    Allowed,
    Denied,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Allowed => "allowed",
            AuditOutcome::Denied => "denied",
        }
    }
}

/// Where the request came in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Rest,
    Mcp,
    Git,
}

/// The actor of an entry, from whoever made the request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditActor {
    pub actor_kind: Option<ActorKind>,
    /// The username: a person's, the agent's (`g1t-agent`), or the
    /// workspace's slug.
    pub actor: String,
    pub actor_id: String,
    pub agent: Option<String>,
    /// The person an agent acted for.
    pub on_behalf_of: Option<String>,
    pub run_id: Option<String>,
    pub run_kind: Option<String>,
    /// The token used, when one was.
    pub credential_id: Option<String>,
}

impl AuditActor {
    pub fn of(user: &User) -> Self {
        let kind = match user.kind {
            PrincipalKind::User => ActorKind::Person,
            PrincipalKind::Agent => ActorKind::Agent,
            PrincipalKind::Workspace => ActorKind::Workspace,
        };
        let acting: Option<&Acting> = user.acting.as_deref();
        AuditActor {
            actor_kind: Some(kind),
            actor: user.username.clone(),
            actor_id: user.id.clone(),
            agent: acting.map(|acting| acting.agent.clone()),
            on_behalf_of: acting.map(|acting| acting.on_behalf_of.username.clone()),
            run_id: acting
                .and_then(|acting| acting.run())
                .and_then(|run| run.run_id.clone()),
            run_kind: acting
                .and_then(|acting| acting.run())
                .map(|run| run.kind.as_str().to_owned()),
            credential_id: acting.map(|acting| acting.credential_id.clone()),
        }
    }

    /// Whether everything this actor does is recorded, reads too.
    pub fn records_reads(&self) -> bool {
        self.actor_kind == Some(ActorKind::Agent)
    }
}

/// What an action was done to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditTarget {
    /// The workspace's slug: whose log it goes in.
    pub workspace: String,
    /// `owner/name`, when the action was about one repository.
    pub repo: Option<String>,
    /// The issue or pull request.
    pub number: Option<u32>,
    /// A full git ref, such as `refs/heads/main`.
    pub git_ref: Option<String>,
    /// A file, or another path the action named.
    pub path: Option<String>,
}

/// An entry to record. The log assigns the id and time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAuditEntry {
    #[serde(flatten)]
    pub actor: AuditActor,
    /// An API or MCP operation, such as `create_issue`, or `git.push` and
    /// `git.fetch`.
    pub action: String,
    pub surface: Surface,
    #[serde(flatten)]
    pub target: AuditTarget,
    pub outcome: AuditOutcome,
    /// The rule that allowed or refused it, such as `run:implement/tools`,
    /// `scope:repository` or `member`.
    pub rule: String,
    /// `ok`, or the failure's code when the service refused or failed it.
    pub result: Option<String>,
    /// Why it was refused, when it was.
    pub message: Option<String>,
    pub request_id: String,
}

impl NewAuditEntry {
    pub fn new(
        actor: AuditActor,
        action: impl Into<String>,
        surface: Surface,
        target: AuditTarget,
        decision: &Decision,
        request_id: impl Into<String>,
    ) -> Self {
        NewAuditEntry {
            actor,
            action: action.into(),
            surface,
            target,
            outcome: if decision.allowed {
                AuditOutcome::Allowed
            } else {
                AuditOutcome::Denied
            },
            rule: decision.rule.clone(),
            result: None,
            message: decision.reason.clone(),
            request_id: request_id.into(),
        }
    }
}

/// A recorded entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    /// RFC 3339.
    pub time: String,
    #[serde(flatten)]
    pub entry: NewAuditEntry,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RecordAuditArgs {
    pub entries: Vec<NewAuditEntry>,
}

/// Which of a workspace's entries the viewer may see.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditVisibility {
    /// An owner: everything.
    All,
    /// A member: what was done to the workspace's projects, and what they
    /// did themselves or had done on their behalf; not what owners did to
    /// the workspace itself.
    Projects { username: String },
}

/// The most entries one `audit_list` returns.
pub const MAX_AUDIT_PAGE: u32 = 500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAuditArgs {
    pub workspace: String,
    pub visibility: AuditVisibility,
    /// Matches the actor or whoever an agent acted for.
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    /// `owner/name`.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub outcome: Option<AuditOutcome>,
    #[serde(default)]
    pub actor_kind: Option<ActorKind>,
    /// Entries of these runs only.
    #[serde(default)]
    pub run_ids: Vec<String>,
    /// RFC 3339; inclusive.
    #[serde(default)]
    pub since: Option<String>,
    /// RFC 3339; exclusive.
    #[serde(default)]
    pub until: Option<String>,
    /// Entries older than this entry id, for the next page.
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Newest first.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    /// Pass as `before` for the next page; null on the last.
    pub next: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialUse, Principal, RunBinding, RunCredentialKind};
    use crate::identity::AgentScope;
    use crate::repos::RepoPath;

    #[test]
    fn an_agent_is_recorded_with_who_it_worked_for() {
        let user = User {
            id: "usr_g1t_agent".to_owned(),
            username: "g1t-agent".to_owned(),
            kind: PrincipalKind::Agent,
            acting: Some(Box::new(Acting {
                credential_id: "tok_9".to_owned(),
                agent: "g1t-agent".to_owned(),
                on_behalf_of: Principal {
                    id: "usr_1".to_owned(),
                    username: "syntaqx".to_owned(),
                },
                scope: AgentScope {
                    repo: RepoPath {
                        namespace: "acme".to_owned(),
                        name: "rocket".to_owned(),
                    },
                    operations: vec![],
                    run: Some(RunBinding {
                        kind: RunCredentialKind::Implement,
                        usage: CredentialUse::Tools,
                        run_id: Some("run_3".to_owned()),
                        number: Some(4),
                        agent: "g1t-agent".to_owned(),
                        read: vec![],
                        push: vec![],
                    }),
                },
            })),
            ..User::default()
        };
        let actor = AuditActor::of(&user);
        assert_eq!(actor.actor_kind, Some(ActorKind::Agent));
        assert_eq!(actor.on_behalf_of.as_deref(), Some("syntaqx"));
        assert_eq!(actor.run_id.as_deref(), Some("run_3"));
        assert_eq!(actor.run_kind.as_deref(), Some("implement"));
        assert_eq!(actor.credential_id.as_deref(), Some("tok_9"));
        assert!(actor.records_reads());

        let person = AuditActor::of(&User {
            id: "usr_1".to_owned(),
            username: "syntaqx".to_owned(),
            ..User::default()
        });
        assert_eq!(person.actor_kind, Some(ActorKind::Person));
        assert!(!person.records_reads());
    }

    #[test]
    fn an_entry_carries_the_rule_that_refused_it() {
        let entry = NewAuditEntry::new(
            AuditActor::default(),
            "merge_pull_request",
            Surface::Mcp,
            AuditTarget::default(),
            &Decision::deny("never", "No."),
            "req_1",
        );
        assert_eq!(entry.outcome, AuditOutcome::Denied);
        assert_eq!(entry.rule, "never");
        assert_eq!(entry.message.as_deref(), Some("No."));
        let json = serde_json::to_value(&entry).unwrap();
        // Flattened, in the names the site reads.
        assert_eq!(json["outcome"], "denied");
        assert_eq!(json["surface"], "mcp");
        assert!(json.get("actorKind").is_some());
        assert!(json.get("gitRef").is_some());
        let visibility = serde_json::to_value(AuditVisibility::Projects {
            username: "ana".to_owned(),
        })
        .unwrap();
        assert_eq!(visibility["kind"], "projects");
    }
}
