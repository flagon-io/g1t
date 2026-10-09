//! Access tokens, and a workspace's rules for the personal tokens that
//! reach it: the identity methods for both.
//!
//! There is one kind of access token. It belongs to a person (and acts as
//! them) or to a workspace (and acts as it), and it has:
//!
//! - **permissions**: a level for each resource, such as issues: write or
//!   repositories: read ([`crate::scopes::resolve_permissions`]). They are
//!   stored as scopes, the highest of each resource, and every check (the
//!   API, the MCP server, git, the registries) reads those scopes.
//! - **a reach**: a person's token reaches every workspace they belong to,
//!   or one workspace they choose, and in it all of its repositories, the
//!   ones chosen, or none of the private ones. With no workspace and no
//!   repositories it reaches its owner's account and public repositories
//!   only. A workspace's token reaches its own workspace: all of its
//!   repositories or the ones chosen.
//! - **an expiry**: up to [`MAX_LIFETIME_DAYS`] days, or none where the
//!   workspaces it reaches allow that.
//!
//! A workspace's owners decide whether tokens made for every workspace of
//! their owner reach it, whether tokens made for it alone do, whether those
//! wait for their approval, and how long a token reaching it may last; they
//! see every member's token that reaches it, and can revoke one there.
//!
//! Each `*Args` struct is the argument of the identity method of the same
//! name, served at `POST /rpc/<method>`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::identity::AccessToken;
use crate::scopes::RepositorySelection;
use crate::{User, Viewer};

/// The longest a token with an expiry may last, in days.
pub const MAX_LIFETIME_DAYS: u32 = 366;

/// The most repositories a token may select.
pub const MAX_SELECTED_REPOSITORIES: usize = 50;

/// Whether a token made for one workspace may be used there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenStatus {
    #[default]
    Active,
    /// Waiting for an owner of the workspace to approve it. Until then it
    /// reads public repositories only.
    Pending,
    /// An owner turned it down.
    Denied,
    /// An owner took it out of the workspace.
    Revoked,
}

impl TokenStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenStatus::Active => "active",
            TokenStatus::Pending => "pending",
            TokenStatus::Denied => "denied",
            TokenStatus::Revoked => "revoked",
        }
    }

    pub fn parse(text: &str) -> TokenStatus {
        match text {
            "pending" => TokenStatus::Pending,
            "denied" => TokenStatus::Denied,
            "revoked" => TokenStatus::Revoked,
            _ => TokenStatus::Active,
        }
    }
}

/// `create_token`: a person makes an access token, for themselves or, as
/// an owner, for a workspace. People only, signed in (not with a token),
/// with a confirmed address. Returns `Outcome<CreatedAccessToken>`; a
/// personal token made for a workspace that asks for approval starts
/// pending unless its owner is an owner there.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CreateTokenArgs {
    pub actor: User,
    /// Who it belongs to: null for the actor, or the slug of a workspace
    /// the actor owns, whose token it then is.
    #[serde(default)]
    pub owner: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// How long it lasts: 1 to [`MAX_LIFETIME_DAYS`] days; null for no
    /// expiry, where the workspaces it reaches allow that.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    /// A personal token's reach: null for every workspace its owner
    /// belongs to, or the slug of one. Ignored for a workspace's token,
    /// which reaches its own workspace.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Which repositories of that workspace: all, the selected ones, or
    /// public ones only. With no workspace, `public` makes a token for its
    /// owner's account and public repositories only; `selected` needs one.
    #[serde(default)]
    pub repository_selection: RepositorySelection,
    /// With `selected`: the repositories, as `owner/name` or a name in the
    /// workspace. At most [`MAX_SELECTED_REPOSITORIES`].
    #[serde(default)]
    pub repositories: Vec<String>,
    /// Each resource's level by name, such as `{"issues": "write"}`; left
    /// out or `none` is no access. See [`crate::scopes::resolve_permissions`].
    #[serde(default)]
    pub permissions: BTreeMap<String, String>,
}

/// `update_token`: a person changes a token of theirs, or, as an owner,
/// a workspace's token: its name, description, repositories or
/// permissions. What is left out stays; the token itself, its reach's
/// workspace and its expiry do not change. A personal token made for a
/// workspace that asks for approval waits for it again when its
/// repositories or permissions change, unless its owner is an owner there.
/// Returns `Outcome<AccessToken>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UpdateTokenArgs {
    pub actor: User,
    pub id: String,
    /// The workspace whose token it is; null for one of the actor's own.
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub repository_selection: Option<RepositorySelection>,
    #[serde(default)]
    pub repositories: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: Option<BTreeMap<String, String>>,
}

/// A workspace's rules for personal access tokens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPolicy {
    /// Whether a token made for every workspace of its owner reaches this
    /// one. Off: it still works everywhere else.
    pub allow_tokens_for_all_workspaces: bool,
    /// Whether a token may be made for this workspace alone.
    pub allow_tokens_for_this_workspace: bool,
    /// Whether a token made for this workspace alone waits for an owner's
    /// approval. Owners' own tokens never wait.
    pub require_approval: bool,
    /// The longest a token reaching it may last, in days. Null: no limit
    /// (a token with an expiry still lasts at most 366 days).
    pub max_lifetime_days: Option<u32>,
    /// Whether a token that never expires is kept out.
    pub forbid_no_expiry: bool,
    /// Who changed it last, and when; null for the defaults.
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl Default for TokenPolicy {
    /// What a workspace has until an owner changes it.
    fn default() -> Self {
        TokenPolicy {
            allow_tokens_for_all_workspaces: true,
            allow_tokens_for_this_workspace: true,
            require_approval: true,
            max_lifetime_days: None,
            forbid_no_expiry: false,
            updated_by: None,
            updated_at: None,
        }
    }
}

impl TokenPolicy {
    /// Whether a token made at `created_ms` that expires at `expires_ms`
    /// (none: never) lasts no longer than the policy allows.
    pub fn lifetime_allowed(&self, created_ms: u64, expires_ms: Option<u64>) -> bool {
        match (expires_ms, self.max_lifetime_days) {
            (None, _) if self.forbid_no_expiry => false,
            (None, Some(_)) => false,
            (None, None) => true,
            (Some(_), None) => true,
            // A day's grace, for clocks and for "30 days" picked at 23:59.
            (Some(expires), Some(days)) => expires.saturating_sub(created_ms) <= (u64::from(days) + 1) * 86_400_000,
        }
    }

    /// Why a token that lasts `ttl_seconds` (none: forever) cannot be made
    /// to reach the workspace `slug`, if it cannot. `this_workspace` is
    /// whether it is made for that workspace alone, rather than for every
    /// workspace of its owner.
    pub fn refusal(&self, slug: &str, this_workspace: bool, ttl_seconds: Option<u64>) -> Option<String> {
        if this_workspace && !self.allow_tokens_for_this_workspace {
            return Some(format!("{slug} does not allow personal access tokens made for it."));
        }
        if !this_workspace && !self.allow_tokens_for_all_workspaces {
            return Some(format!("{slug} does not allow tokens made for all of a member's workspaces: make one for {slug} alone."));
        }
        if !self.lifetime_allowed(0, ttl_seconds.map(|ttl| ttl * 1000)) {
            return Some(match self.max_lifetime_days {
                Some(days) => format!("{slug} allows tokens that last at most {days} days."),
                None => format!("{slug} does not allow tokens that never expire."),
            });
        }
        None
    }
}

/// `get_token_policy`: a workspace's rules. Members may read them, so the
/// token form can say what a workspace allows. Returns
/// `Outcome<TokenPolicy>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetTokenPolicyArgs {
    pub viewer: Viewer,
    pub slug: String,
}

/// `set_token_policy`: an owner, as a person, changes the rules. What is
/// left out stays. Returns `Outcome<TokenPolicy>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetTokenPolicyArgs {
    pub actor: User,
    pub slug: String,
    #[serde(default)]
    pub allow_tokens_for_all_workspaces: Option<bool>,
    #[serde(default)]
    pub allow_tokens_for_this_workspace: Option<bool>,
    #[serde(default)]
    pub require_approval: Option<bool>,
    /// Zero clears the limit.
    #[serde(default)]
    pub max_lifetime_days: Option<u32>,
    #[serde(default)]
    pub forbid_no_expiry: Option<bool>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// A member's personal token that reaches a workspace, as its owners see
/// it: never the token itself.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberToken {
    /// The person it belongs to.
    pub owner: String,
    pub token: AccessToken,
    /// Whether it reaches the workspace now: active, allowed by the
    /// policy, and not revoked here.
    pub reaches: bool,
    /// Why not, when it does not.
    #[serde(default)]
    pub blocked_by: Option<String>,
}

/// `list_member_tokens`: owners only. The personal tokens of the
/// workspace's members and outside collaborators that could reach it:
/// those made for it alone (`status` to narrow them), and those made for
/// every workspace of their owner. Returns `Outcome<Vec<MemberToken>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListMemberTokensArgs {
    pub actor: User,
    pub slug: String,
    /// `pending` for approval requests only.
    #[serde(default)]
    pub status: Option<TokenStatus>,
}

/// `review_token_request`: an owner approves or denies a token waiting
/// for approval. Its owner is told. Returns `Outcome<MemberToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewTokenRequestArgs {
    pub actor: User,
    pub slug: String,
    pub id: String,
    pub approve: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `revoke_member_token`: an owner takes a member's token out of the
/// workspace. A token made for it alone stops working; one made for every
/// workspace of its owner keeps working everywhere else. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RevokeMemberTokenArgs {
    pub actor: User,
    pub slug: String,
    pub id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifetimes_are_checked_against_the_policy() {
        let day = 86_400_000;
        let open = TokenPolicy::default();
        assert!(open.lifetime_allowed(0, None));
        assert!(open.lifetime_allowed(0, Some(900 * day)));
        let capped = TokenPolicy { max_lifetime_days: Some(90), ..TokenPolicy::default() };
        assert!(capped.lifetime_allowed(0, Some(90 * day)));
        assert!(capped.lifetime_allowed(0, Some(90 * day + day / 2)), "a day's grace");
        assert!(!capped.lifetime_allowed(0, Some(92 * day)));
        assert!(!capped.lifetime_allowed(0, None), "a limit keeps out tokens that never expire");
        let no_forever = TokenPolicy { forbid_no_expiry: true, ..TokenPolicy::default() };
        assert!(!no_forever.lifetime_allowed(0, None));
        assert!(no_forever.lifetime_allowed(0, Some(900 * day)));
    }

    #[test]
    fn refusals_name_the_rule() {
        let closed = TokenPolicy { allow_tokens_for_all_workspaces: false, allow_tokens_for_this_workspace: false, ..TokenPolicy::default() };
        assert!(closed.refusal("acme", true, Some(60)).unwrap().contains("made for it"));
        assert!(closed.refusal("acme", false, Some(60)).unwrap().contains("all of a member's workspaces"));
        let capped = TokenPolicy { max_lifetime_days: Some(30), ..TokenPolicy::default() };
        assert!(capped.refusal("acme", true, Some(31 * 86_400 + 86_400)).unwrap().contains("30 days"));
        assert_eq!(capped.refusal("acme", true, Some(7 * 86_400)), None);
        assert!(TokenPolicy::default().require_approval, "tokens made for a workspace wait for approval unless an owner says otherwise");
    }

    #[test]
    fn statuses_read_as_words() {
        for status in [TokenStatus::Active, TokenStatus::Pending, TokenStatus::Denied, TokenStatus::Revoked] {
            assert_eq!(TokenStatus::parse(status.as_str()), status);
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
    }
}
