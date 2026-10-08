//! A workspace's rules for personal access tokens, over REST and MCP: the
//! policy (which kinds reach it, approval, lifetime), the members' tokens
//! that reach it, approving or denying fine-grained tokens that wait for
//! approval, and revoking a token there. Identity decides and keeps all of
//! it (services/identity/src/token_reach.rs); owners only, as people.

use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenOp {
    GetTokenPolicy,
    SetTokenPolicy,
    ListMemberTokens,
    ListTokenRequests,
    ReviewTokenRequest,
    RevokeMemberToken,
}

impl TokenOp {
    /// Every one: `Op::ALL` lists each as `Op::Tokens(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [TokenOp; 6] = [
        TokenOp::GetTokenPolicy,
        TokenOp::SetTokenPolicy,
        TokenOp::ListMemberTokens,
        TokenOp::ListTokenRequests,
        TokenOp::ReviewTokenRequest,
        TokenOp::RevokeMemberToken,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TokenOp::GetTokenPolicy => "get_token_policy",
            TokenOp::SetTokenPolicy => "set_token_policy",
            TokenOp::ListMemberTokens => "list_member_tokens",
            TokenOp::ListTokenRequests => "list_token_requests",
            TokenOp::ReviewTokenRequest => "review_token_request",
            TokenOp::RevokeMemberToken => "revoke_member_token",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            TokenOp::GetTokenPolicy => "Get a workspace's personal access token policy",
            TokenOp::SetTokenPolicy => "Set a workspace's personal access token policy",
            TokenOp::ListMemberTokens => "List the personal access tokens that reach a workspace",
            TokenOp::ListTokenRequests => "List fine-grained tokens waiting for approval",
            TokenOp::ReviewTokenRequest => "Approve or deny a fine-grained token",
            TokenOp::RevokeMemberToken => "Revoke a member's token in a workspace",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            TokenOp::GetTokenPolicy => "A workspace's rules for its members' personal access tokens: allow_classic (classic tokens reach it), allow_fine_grained (fine-grained tokens may name it as their resource owner), require_approval (a fine-grained token naming it waits for an owner's approval; true unless an owner says, and never for an owner's own token), max_lifetime_days (the longest a token reaching it may last; null for no limit, and a fine-grained token lasts at most 366 days anyway) and forbid_no_expiry (a token that never expires does not reach it). A token outside the rules keeps working elsewhere and reaches the workspace's public repositories only. Members only.",
            TokenOp::SetTokenPolicy => "Change a workspace's rules for personal access tokens; fields left out stay as they are. max_lifetime_days of 0 removes the limit. The rules apply from each token's next request, to tokens made before them too. Owners only, as people.",
            TokenOp::ListMemberTokens => "The personal access tokens of the workspace's members and outside collaborators that can reach it: every fine-grained token naming it as its resource owner, whatever its status, and every classic token that has not expired. Each with its owner, kind, name, scopes, a fine-grained token's permissions, repository_selection, repositories and status (active, pending, denied or revoked), when it was made, last used and expires, and whether it reaches the workspace now (reaches, and blocked_by when not: pending approval, denied, revoked, classic tokens not allowed, lasts too long, never expires). Never the token itself. kind narrows it to classic or fine_grained. Owners only, as people.",
            TokenOp::ListTokenRequests => "The fine-grained tokens naming the workspace that wait for an owner's approval, as list_member_tokens shows them. Until approved, a token reaches public repositories only. Owners only, as people.",
            TokenOp::ReviewTokenRequest => "Approve or deny a fine-grained token waiting for approval: decision is approve or deny, and reason, if given, is shown to the token's owner, who hears of it in their inbox. An approved token reaches the workspace from its next request; a denied one reaches public repositories only. Recorded in the audit log as token.approved or token.denied. Owners only, as people.",
            TokenOp::RevokeMemberToken => "Take a member's token out of the workspace, with an optional reason its owner is shown. A fine-grained token naming the workspace stops reaching it for good; a classic token keeps working everywhere else but never reaches this workspace again. Recorded in the audit log as token.revoked. Owners only, as people.",
        }
    }

    /// Whether it changes anything: checked against the scope table in tests.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        matches!(self, TokenOp::SetTokenPolicy | TokenOp::ReviewTokenRequest | TokenOp::RevokeMemberToken)
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's name, e.g. \"acme\"." });
        let id = json!({ "type": "string", "description": "The token's id, tok_…." });
        let reason = json!({ "type": "string", "description": "Why, shown to the token's owner." });
        let (properties, required): (Value, &[&str]) = match self {
            TokenOp::GetTokenPolicy | TokenOp::ListTokenRequests => (json!({ "workspace": workspace }), &["workspace"]),
            TokenOp::SetTokenPolicy => (
                json!({
                    "workspace": workspace,
                    "allow_classic": { "type": "boolean", "description": "Classic tokens reach the workspace." },
                    "allow_fine_grained": { "type": "boolean", "description": "Fine-grained tokens may name the workspace as their resource owner." },
                    "require_approval": { "type": "boolean", "description": "A fine-grained token naming the workspace waits for an owner's approval." },
                    "max_lifetime_days": { "type": "integer", "description": "The longest a token reaching it may last, in days, 1 to 3650; 0 for no limit." },
                    "forbid_no_expiry": { "type": "boolean", "description": "A token that never expires does not reach the workspace." },
                }),
                &["workspace"],
            ),
            TokenOp::ListMemberTokens => (
                json!({
                    "workspace": workspace,
                    "kind": { "type": "string", "enum": ["classic", "fine_grained"], "description": "Only tokens of this kind." },
                }),
                &["workspace"],
            ),
            TokenOp::ReviewTokenRequest => (
                json!({
                    "workspace": workspace,
                    "id": id,
                    "decision": { "type": "string", "enum": ["approve", "deny"], "description": "approve or deny. A request body shaped as `{\"action\": \"approve\"}` is read the same way." },
                    "reason": reason,
                }),
                &["workspace", "id", "decision"],
            ),
            TokenOp::RevokeMemberToken => (
                json!({
                    "workspace": workspace,
                    "id": id,
                    "reason": reason,
                }),
                &["workspace", "id"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    match &input[key] {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        _ => None,
    }
}

fn flag(input: &Value, key: &str) -> Option<bool> {
    match &input[key] {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// A member's token in one flat shape: the token's fields, a fine-grained
/// token's beside them, and its owner and whether it reaches the workspace.
/// Keys stay as identity sends them (`camelCase`); the API's converter
/// writes them out in `snake_case`.
pub(crate) fn member_view(member: &Value) -> Value {
    let mut out = Map::new();
    if let Some(token) = member["token"].as_object() {
        for (key, value) in token {
            if key != "fineGrained" && key != "legacy" {
                out.insert(key.clone(), value.clone());
            }
        }
        if let Some(details) = token.get("fineGrained").and_then(Value::as_object) {
            for (key, value) in details {
                let key = if key == "workspace" { "resourceOwner".to_owned() } else { key.clone() };
                out.insert(key, value.clone());
            }
        }
    }
    out.insert("owner".into(), member["owner"].clone());
    out.insert("reaches".into(), member["reaches"].clone());
    out.insert("blockedBy".into(), member["blockedBy"].clone());
    Value::Object(out)
}

fn map(outcome: Outcome<Value>, f: impl Fn(&Value) -> Value) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(f(&value)),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    }
}

pub async fn run(op: TokenOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(actor) = viewer.clone() else {
        return Ok(Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token."));
    };
    let Some(workspace) = text(input, "workspace") else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
    };
    let identity = &services.identity;
    let surface = services.audit.surface;
    let list = |members: &Value| Value::Array(members.as_array().map(|members| members.iter().map(member_view).collect()).unwrap_or_default());
    Ok(match op {
        TokenOp::GetTokenPolicy => g1t_kit::call(identity, "get_token_policy", &json!({ "viewer": viewer, "slug": workspace })).await?,
        TokenOp::SetTokenPolicy => {
            let days = match input.get("max_lifetime_days").filter(|value| !value.is_null()) {
                None => None,
                Some(value) => match value.as_u64().or_else(|| value.as_str().and_then(|text| text.trim().parse().ok())) {
                    Some(days) => Some(days),
                    None => return Ok(Outcome::fail(FailureCode::Invalid, "max_lifetime_days is a whole number of days; 0 for no limit.")),
                },
            };
            g1t_kit::call(
                identity,
                "set_token_policy",
                &json!({
                    "actor": actor,
                    "slug": workspace,
                    "allow_classic": flag(input, "allow_classic"),
                    "allow_fine_grained": flag(input, "allow_fine_grained"),
                    "require_approval": flag(input, "require_approval"),
                    "max_lifetime_days": days,
                    "forbid_no_expiry": flag(input, "forbid_no_expiry"),
                    "surface": surface,
                }),
            )
            .await?
        }
        TokenOp::ListMemberTokens | TokenOp::ListTokenRequests => {
            let kind = text(input, "kind");
            if kind.as_deref().is_some_and(|kind| kind != "classic" && kind != "fine_grained") {
                return Ok(Outcome::fail(FailureCode::Invalid, "kind is classic or fine_grained."));
            }
            let status = (op == TokenOp::ListTokenRequests).then_some("pending");
            let kind = if op == TokenOp::ListTokenRequests { Some("fine_grained".to_owned()) } else { kind };
            let members: Outcome<Value> =
                g1t_kit::call(identity, "list_member_tokens", &json!({ "actor": actor, "slug": workspace, "status": status, "kind": kind })).await?;
            map(members, list)
        }
        TokenOp::ReviewTokenRequest => {
            let approve = match text(input, "decision").or_else(|| text(input, "action")).as_deref() {
                Some("approve") => true,
                Some("deny") => false,
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "decision is approve or deny.")),
            };
            let reviewed: Outcome<Value> = g1t_kit::call(
                identity,
                "review_token_request",
                &json!({
                    "actor": actor,
                    "slug": workspace,
                    "id": text(input, "id").unwrap_or_default(),
                    "approve": approve,
                    "reason": text(input, "reason"),
                    "surface": surface,
                }),
            )
            .await?;
            map(reviewed, member_view)
        }
        TokenOp::RevokeMemberToken => {
            if text(input, "action").is_some_and(|action| action != "revoke") {
                return Ok(Outcome::fail(FailureCode::Invalid, "action is revoke."));
            }
            let revoked: Outcome<bool> = g1t_kit::call(
                identity,
                "revoke_member_token",
                &json!({
                    "actor": actor,
                    "slug": workspace,
                    "id": text(input, "id").unwrap_or_default(),
                    "reason": text(input, "reason"),
                    "surface": surface,
                }),
            )
            .await?;
            match revoked {
                Outcome::Ok(_) => Outcome::Ok(json!({ "revoked": true })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_token_reads_flat() {
        let view = member_view(&json!({
            "owner": "ana",
            "reaches": false,
            "blockedBy": "pending approval",
            "token": {
                "id": "tok_1", "name": "ci", "createdAt": "2026-10-08T00:00:00.000Z", "lastUsedAt": null,
                "createdBy": null, "scopes": ["repo:read", "code:read"], "legacy": false, "expiresAt": "2026-11-07T00:00:00.000Z",
                "kind": "fine_grained",
                "fineGrained": { "workspace": "acme", "repositorySelection": "selected", "repositories": ["acme/web"], "permissions": { "contents": "read", "metadata": "read" }, "status": "pending" },
            },
        }));
        assert_eq!(view["owner"], "ana");
        assert_eq!(view["resourceOwner"], "acme");
        assert_eq!(view["repositorySelection"], "selected");
        assert_eq!(view["permissions"]["contents"], "read");
        assert_eq!(view["status"], "pending");
        assert_eq!(view["blockedBy"], "pending approval");
        assert!(view.get("fineGrained").is_none() && view.get("legacy").is_none());
    }

    #[test]
    fn only_changes_write() {
        for op in TokenOp::ALL {
            assert_eq!(op.writes(), op.name().starts_with("set_") || op.name().starts_with("review_") || op.name().starts_with("revoke_"), "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")));
        }
    }
}
