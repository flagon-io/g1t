//! Least privilege and the audit trail, around every operation.
//!
//! An agent's token is checked against its run's scope and the person it
//! acts for before anything runs (see `g1t_contracts::credentials`); a
//! runner's credential then acts downstream as that person. Everything an
//! agent does is recorded, reads included, as is every change a person or
//! a workspace token makes. Refusals are recorded with their rule.

use g1t_contracts::audit::{AuditActor, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::credentials::{Decision, as_person, decide_operation, is_read};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::scopes;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use serde_json::Value;
use worker::{Request, Result, console_error};

use crate::operations::{Op, Services};

/// Where a request came in, and the id it is recorded under.
#[derive(Clone, Debug)]
pub struct AuditContext {
    pub request_id: String,
    pub surface: Surface,
}

impl Default for AuditContext {
    fn default() -> Self {
        AuditContext {
            request_id: String::new(),
            surface: Surface::Rest,
        }
    }
}

impl AuditContext {
    /// Cloudflare's ray id, which also finds the request in Workers logs.
    pub fn of(request: &Request, on_mcp: bool) -> Self {
        let ray = request.headers().get("cf-ray").ok().flatten();
        AuditContext {
            request_id: ray.unwrap_or_else(|| g1t_contracts::new_id("req", g1t_kit::now_ms())),
            surface: if on_mcp { Surface::Mcp } else { Surface::Rest },
        }
    }
}

fn repo_path(input: &Value) -> Option<RepoPath> {
    let mut parts = input["repo"].as_str()?.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(namespace), Some(name), None) if !namespace.is_empty() && !name.is_empty() => {
            Some(RepoPath {
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            })
        }
        _ => None,
    }
}

fn number(input: &Value) -> Option<u32> {
    match &input["number"] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.parse().ok(),
        _ => None,
    }
}

fn some_text(input: &Value, key: &str) -> Option<String> {
    input[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// What an operation named, for its entry.
pub fn target(user: &User, input: &Value) -> AuditTarget {
    let repo = repo_path(input);
    let workspace = repo
        .as_ref()
        .map(|repo| repo.namespace.clone())
        .or_else(|| some_text(input, "workspace"))
        .or_else(|| some_text(input, "slug"))
        .or_else(|| {
            user.acting
                .as_ref()
                .map(|acting| acting.scope.repo.namespace.clone())
        })
        .unwrap_or_default()
        .to_lowercase();
    AuditTarget {
        workspace,
        repo: repo.map(|repo| format!("{}/{}", repo.namespace, repo.name)),
        number: number(input),
        git_ref: some_text(input, "ref").or_else(|| some_text(input, "branch")),
        path: some_text(input, "path"),
    }
}

/// The rule that let a person or a workspace token through: theirs is
/// decided by the service that owns what they asked about.
fn principal_rule(user: &User) -> &'static str {
    match user.kind {
        PrincipalKind::Workspace => "workspace-token",
        _ => "person",
    }
}

/// Whether the API refused a caller before anything ran, and why: an
/// agent against its run's scope, or an access token against its scopes.
/// `None` for a signed-in session, which only the person's role limits.
/// A token reaches whatever the one it acts as can reach; the service
/// that owns what was asked about checks that.
pub fn decide(op: Op, services: &Services, viewer: &Viewer, input: &Value) -> Option<Decision> {
    let user = viewer.as_ref()?;
    if user.kind == PrincipalKind::Agent {
        let scope = services.scope.as_ref()?;
        return Some(decide_operation(
            user,
            scope,
            op.name(),
            repo_path(input).as_ref(),
            op.needs_repo(),
            number(input),
        ));
    }
    token_decision(op, user, input)
}

/// What an access token's scopes decide about a call; `None` for a
/// caller without one.
fn token_decision(op: Op, user: &User, input: &Value) -> Option<Decision> {
    let access = user.token.as_deref()?;
    Some(scopes::decide(access, op.name(), input))
}

/// The scope a refused call lacked, for the error the caller is sent.
pub fn missing_scope(op: Op, viewer: &Viewer, input: &Value) -> Option<scopes::Scope> {
    let access = viewer.as_ref()?.token.as_deref()?;
    scopes::needed(op.name(), input)
        .into_iter()
        .find(|scope| !access.allows(*scope))
}

/// Runs `op` for `viewer`: enforcing an agent's scope first, and recording
/// what happened.
pub async fn run(
    op: Op,
    services: &Services,
    viewer: &Viewer,
    input: &Value,
) -> Result<Outcome<Value>> {
    let decision = decide(op, services, viewer, input);
    if let Some(decision) = decision.as_ref().filter(|decision| !decision.allowed) {
        record(op, services, viewer, input, decision, None).await;
        return Ok(Outcome::fail(
            FailureCode::Forbidden,
            decision.reason.as_deref().unwrap_or("Not allowed."),
        ));
    }
    // A runner's credential acts as the person, within the run's scope.
    let downstream: Viewer = viewer
        .as_ref()
        .and_then(as_person)
        .or_else(|| viewer.clone());
    let outcome = op.run(services, &downstream, input).await?;
    let decision = decision.unwrap_or_else(|| match viewer {
        Some(user) => Decision::allow(principal_rule(user)),
        None => Decision::allow("anonymous"),
    });
    record(op, services, viewer, input, &decision, Some(&outcome)).await;
    Ok(outcome)
}

/// Appends the entry, if this is something the log keeps. A failure to
/// record is logged, never passed on to the caller.
async fn record(
    op: Op,
    services: &Services,
    viewer: &Viewer,
    input: &Value,
    decision: &Decision,
    outcome: Option<&Outcome<Value>>,
) {
    let Some(user) = viewer.as_ref() else {
        return;
    };
    let actor = AuditActor::of(user);
    if !actor.records_reads() && is_read(op.name()) {
        return;
    }
    // A person's own inbox is nobody else's business.
    if op.personal() {
        return;
    }
    let mut entry = NewAuditEntry::new(
        actor,
        op.name(),
        services.audit.surface,
        target(user, input),
        decision,
        services.audit.request_id.clone(),
    );
    match outcome {
        Some(Outcome::Ok(_)) => entry.result = Some("ok".to_owned()),
        Some(Outcome::Fail(failure)) => {
            let code = serde_json::to_value(failure.code)
                .ok()
                .and_then(|code| code.as_str().map(str::to_owned))
                .unwrap_or_else(|| "failed".to_owned());
            // Refused by the service that owns it: still a denial.
            if matches!(
                failure.code,
                FailureCode::Forbidden | FailureCode::Unauthenticated
            ) {
                entry.outcome = g1t_contracts::audit::AuditOutcome::Denied;
                entry.rule = "service".to_owned();
            }
            entry.message = Some(failure.message.clone());
            entry.result = Some(code);
        }
        None => entry.result = Some("forbidden".to_owned()),
    }
    let recorded: Result<u32> = g1t_kit::call(
        &services.events,
        "audit_record",
        &RecordAuditArgs {
            entries: vec![entry],
        },
    )
    .await;
    if let Err(error) = recorded {
        console_error!("audit entry not recorded for {}: {error}", op.name());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::credentials::{Acting, Principal};
    use g1t_contracts::identity::AgentScope;
    use g1t_contracts::scopes::{Scope, TokenAccess};
    use serde_json::json;

    #[test]
    fn the_target_comes_from_the_input() {
        let person = User {
            id: "usr_1".to_owned(),
            username: "syntaqx".to_owned(),
            ..User::default()
        };
        let target = target(
            &person,
            &json!({ "repo": "Acme/rocket", "number": "12", "path": "src/a.rs" }),
        );
        assert_eq!(target.workspace, "acme");
        assert_eq!(target.repo.as_deref(), Some("Acme/rocket"));
        assert_eq!(target.number, Some(12));
        assert_eq!(target.path.as_deref(), Some("src/a.rs"));
        assert_eq!(
            super::target(&person, &json!({ "workspace": "Ops" })).workspace,
            "ops"
        );
    }

    fn with_token(scopes: Option<&[Scope]>, legacy: bool) -> User {
        User {
            id: "usr_1".to_owned(),
            username: "syntaqx".to_owned(),
            token: Some(Box::new(TokenAccess {
                token_id: "tok_1".to_owned(),
                scopes: scopes.map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
                legacy,
                name: None,
                ..TokenAccess::default()
            })),
            ..User::default()
        }
    }

    #[test]
    fn a_session_is_limited_only_by_the_person_s_role() {
        let person = User { id: "usr_1".to_owned(), ..User::default() };
        assert!(token_decision(Op::DeleteRepo, &person, &json!({})).is_none());
    }

    #[test]
    fn a_legacy_token_still_does_everything() {
        let legacy = with_token(None, true);
        for op in Op::ALL {
            let decision = token_decision(op, &legacy, &json!({ "repo": "acme/rocket" })).unwrap();
            assert!(decision.allowed, "{}", op.name());
            assert_eq!(decision.rule, "token:legacy");
        }
    }

    #[test]
    fn a_token_without_the_scope_is_refused_and_told_which() {
        let reader = with_token(Some(&[Scope::IssuesRead]), false);
        let input = json!({ "repo": "acme/rocket", "title": "x" });
        assert!(token_decision(Op::GetIssue, &reader, &input).unwrap().allowed);
        let refused = token_decision(Op::CreateIssue, &reader, &input).unwrap();
        assert!(!refused.allowed);
        assert!(refused.reason.unwrap().contains("issues:write"));
        assert_eq!(missing_scope(Op::CreateIssue, &Some(reader.clone()), &input), Some(Scope::IssuesWrite));
        assert_eq!(missing_scope(Op::GetIssue, &Some(reader), &input), None);
    }

    #[test]
    fn a_token_reaches_what_its_owner_can() {
        // Scopes are the only limit a token adds: which workspaces and
        // repositories it reaches is the owner's, decided downstream.
        let admin = with_token(Some(&[Scope::RepoAdmin]), false);
        let moved = token_decision(Op::TransferRepo, &admin, &json!({ "repo": "acme/rocket", "to": "elsewhere" })).unwrap();
        assert!(moved.allowed);
        assert_eq!(moved.rule, "token:scope");
        let full = with_token(None, false);
        assert!(token_decision(Op::ListWebhooks, &full, &json!({ "workspace": "other" })).unwrap().allowed);
    }

    #[test]
    fn an_agent_with_no_repository_is_logged_in_its_run_s_workspace() {
        let agent = User {
            kind: PrincipalKind::Agent,
            acting: Some(Box::new(Acting {
                credential_id: "tok_1".to_owned(),
                agent: "g1t".to_owned(),
                on_behalf_of: Principal::default(),
                scope: AgentScope {
                    repo: RepoPath {
                        namespace: "acme".to_owned(),
                        name: "rocket".to_owned(),
                    },
                    operations: vec![],
                    run: None,
                },
            })),
            ..User::default()
        };
        assert_eq!(target(&agent, &json!({})).workspace, "acme");
    }
}
