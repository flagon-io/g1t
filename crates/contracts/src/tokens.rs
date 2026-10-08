//! Fine-grained personal access tokens, and a workspace's rules for the
//! personal tokens that reach it: the identity methods for both.
//!
//! A **classic** token reaches whatever its owner can, narrowed by its
//! scopes. A **fine-grained** token names one resource owner (the person's
//! own account, or one workspace they belong to), which of that
//! workspace's repositories it reaches, and a level for each permission
//! ([`crate::fine_grained`]); it must expire. A workspace's owners decide
//! whether either kind reaches the workspace, whether a fine-grained token
//! naming it waits for their approval, and how long a token reaching it may
//! last; they see every member's token that reaches it, and can revoke one.
//!
//! Each `*Args` struct is the argument of the identity method of the same
//! name, served at `POST /rpc/<method>`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::fine_grained::Access;
use crate::identity::AccessToken;
use crate::scopes::RepositorySelection;
use crate::{User, Viewer};

/// What kind of token it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    /// A personal token with scopes, reaching whatever its owner can.
    #[default]
    Classic,
    /// A personal token with one resource owner and permissions.
    FineGrained,
    /// A workspace's own token.
    Workspace,
}

/// Whether a fine-grained token may be used on its resource owner.
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

/// `create_fine_grained_token`: a person makes a fine-grained token.
/// People only, with a confirmed address. Returns
/// `Outcome<CreatedAccessToken>`; the token starts pending when its
/// workspace asks for approval and the person is not one of its owners.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateFineGrainedTokenArgs {
    pub user: User,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// How long it lasts: at most [`crate::fine_grained::MAX_LIFETIME_DAYS`]
    /// days, and at most what the workspace allows.
    pub ttl_seconds: u64,
    /// The resource owner: a workspace's slug, or null for your own account.
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub repository_selection: RepositorySelection,
    /// With `selected`: the repositories, as `owner/name` or a name in the
    /// workspace. At most [`MAX_SELECTED_REPOSITORIES`].
    #[serde(default)]
    pub repositories: Vec<String>,
    /// Each permission's level by name, such as `{"contents": "write"}`.
    #[serde(default)]
    pub permissions: BTreeMap<String, String>,
}

/// The most repositories a fine-grained token may select.
pub const MAX_SELECTED_REPOSITORIES: usize = 50;

/// `update_fine_grained_token`: its owner changes its name, description,
/// repositories or permissions. What is left out stays. A token aimed at a
/// workspace that asks for approval waits for it again when its
/// repositories or permissions change, unless its owner is an owner there.
/// Returns `Outcome<AccessToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateFineGrainedTokenArgs {
    pub user: User,
    pub id: String,
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
    /// Whether classic tokens reach the workspace. Off: they still work
    /// everywhere else.
    pub allow_classic: bool,
    /// Whether fine-grained tokens may name the workspace as their
    /// resource owner.
    pub allow_fine_grained: bool,
    /// Whether a fine-grained token naming it waits for an owner's
    /// approval. Owners' own tokens never wait.
    pub require_approval: bool,
    /// The longest a token reaching it may last, in days. Null: no limit
    /// (a fine-grained token still lasts at most 366 days).
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
            allow_classic: true,
            allow_fine_grained: true,
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

    /// Why a token of `kind` that lasts `ttl_seconds` (none: forever)
    /// cannot be made for the workspace `slug`, if it cannot.
    pub fn refusal(&self, slug: &str, kind: TokenKind, ttl_seconds: Option<u64>) -> Option<String> {
        match kind {
            TokenKind::FineGrained if !self.allow_fine_grained => {
                return Some(format!("{slug} does not allow fine-grained personal access tokens."));
            }
            TokenKind::Classic if !self.allow_classic => {
                return Some(format!("{slug} does not allow classic personal access tokens."));
            }
            _ => {}
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
    pub allow_classic: Option<bool>,
    #[serde(default)]
    pub allow_fine_grained: Option<bool>,
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
/// fine-grained ones naming it (`status` to narrow them), and classic ones.
/// Returns `Outcome<Vec<MemberToken>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListMemberTokensArgs {
    pub actor: User,
    pub slug: String,
    /// `pending` for approval requests only.
    #[serde(default)]
    pub status: Option<TokenStatus>,
    /// `classic` or `fine_grained` only.
    #[serde(default)]
    pub kind: Option<TokenKind>,
}

/// `review_token_request`: an owner approves or denies a fine-grained
/// token waiting for approval. Its owner is told. Returns
/// `Outcome<MemberToken>`.
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
/// workspace. A fine-grained token naming it stops working; a classic one
/// keeps working everywhere else. Returns `Outcome<bool>`.
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

/// A fine-grained token's details, as listings show them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineGrainedDetails {
    /// The resource owner's slug; null for the person's own account.
    pub workspace: Option<String>,
    pub repository_selection: RepositorySelection,
    /// With `selected`: the repositories, as `owner/name`, that the viewer
    /// can see.
    #[serde(default)]
    pub repositories: Vec<String>,
    pub permissions: BTreeMap<String, Access>,
    pub status: TokenStatus,
    /// Why an owner denied or revoked it.
    #[serde(default)]
    pub review_reason: Option<String>,
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
        let closed = TokenPolicy { allow_classic: false, allow_fine_grained: false, ..TokenPolicy::default() };
        assert!(closed.refusal("acme", TokenKind::FineGrained, Some(60)).unwrap().contains("fine-grained"));
        assert!(closed.refusal("acme", TokenKind::Classic, Some(60)).unwrap().contains("classic"));
        let capped = TokenPolicy { max_lifetime_days: Some(30), ..TokenPolicy::default() };
        assert!(capped.refusal("acme", TokenKind::FineGrained, Some(31 * 86_400 + 86_400)).unwrap().contains("30 days"));
        assert_eq!(capped.refusal("acme", TokenKind::FineGrained, Some(7 * 86_400)), None);
        assert!(TokenPolicy::default().require_approval, "fine-grained tokens wait for approval unless an owner says otherwise");
    }

    #[test]
    fn kinds_and_statuses_read_as_words() {
        assert_eq!(serde_json::to_value(TokenKind::FineGrained).unwrap(), "fine_grained");
        for status in [TokenStatus::Active, TokenStatus::Pending, TokenStatus::Denied, TokenStatus::Revoked] {
            assert_eq!(TokenStatus::parse(status.as_str()), status);
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
    }
}
