//! The identity service: accounts, credentials and sessions.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::User;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub id: String,
    pub title: String,
    pub fingerprint: String,
    /// RFC 3339.
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessToken {
    pub id: String,
    pub name: String,
    /// RFC 3339.
    pub created_at: String,
}

/// `sign_in`: verifies a username and password for website sign-in.
/// Returns `Outcome<SignedIn>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SignInArgs {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub user: User,
    pub session_token: String,
}

/// `sign_out` and `user_for_session`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArgs {
    pub session_token: String,
}

/// `user_for_git_credentials`: the account password or an access token.
#[derive(Debug, Serialize, Deserialize)]
pub struct GitCredentialsArgs {
    pub username: String,
    pub secret: String,
}

/// `user_for_access_token`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TokenArgs {
    pub token: String,
}

/// `user_for_ssh_key`.
#[derive(Debug, Serialize, Deserialize)]
pub struct FingerprintArgs {
    pub fingerprint: String,
}

/// `user_by_username`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsernameArgs {
    pub username: String,
}

/// `list_ssh_keys` and `list_access_tokens`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserArgs {
    pub user: User,
}

/// `add_ssh_key`: `public_key` is one line in OpenSSH format.
/// Returns `Outcome<SshKey>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSshKeyArgs {
    pub user: User,
    pub title: String,
    pub public_key: String,
}

/// `remove_ssh_key` and `remove_access_token`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveArgs {
    pub user: User,
    pub id: String,
}

/// `create_access_token`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccessTokenArgs {
    pub user: User,
    pub name: String,
    /// When set, the token stops working after this many seconds and is
    /// left out of the user's token list. Used for hosted attempts.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

/// The plaintext token is returned once and never stored.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreatedAccessToken {
    pub token: String,
    pub info: AccessToken,
}

/// `register`: creates an account and signs it in.
/// Returns `Outcome<SignedIn>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterArgs {
    pub username: String,
    pub email: String,
    pub password: String,
}

/// `verify_email`: the token from the emailed link. Returns `Outcome<User>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmailTokenArgs {
    pub token: String,
}

/// `request_password_reset`. Always succeeds, so it cannot be used to find
/// out which addresses have accounts.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmailArgs {
    pub email: String,
}

/// `reset_password`: sets a new password and ends every session.
/// Returns `Outcome<User>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResetPasswordArgs {
    pub token: String,
    pub password: String,
}

/// `device_start`: begins a device sign-in. Returns `DeviceStart`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartArgs {
    /// What is asking, shown to the person approving, e.g. "Claude Code".
    pub client_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    /// Secret held by the tool and exchanged for a token once approved.
    pub device_code: String,
    /// Short code shown to the person, e.g. `WDJB-MJHT`.
    pub user_code: String,
    /// Seconds until both codes stop working.
    pub expires_in: u32,
    /// Seconds the tool should wait between polls.
    pub interval: u32,
}

/// `device_lookup`: what a user code is asking for, or null if it is not
/// valid. Returns `Option<DeviceRequest>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLookupArgs {
    pub user_code: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRequest {
    pub user_code: String,
    pub client_name: String,
}

/// `device_resolve`: the signed-in person approves or denies a request.
/// Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResolveArgs {
    pub user_code: String,
    pub user: User,
    pub approve: bool,
}

/// `device_claim`: the tool asks whether its request was approved.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaimArgs {
    pub device_code: String,
}

/// The answer to a `device_claim`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DeviceClaim {
    /// Nobody has approved or denied it yet; ask again after the interval.
    Pending,
    Denied,
    /// The code was never issued, has expired, or was already used.
    Expired,
    /// The access token, returned once.
    Approved {
        token: String,
        user: User,
    },
}

/// A workspace: the owner of repositories, and the first segment of their
/// URLs. A person's own space and a team's are the same thing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub slug: String,
    pub name: String,
    /// RFC 3339.
    pub created_at: String,
    pub member_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub username: String,
    pub role: crate::Role,
}

/// `create_workspace`. Returns `Outcome<Workspace>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateWorkspaceArgs {
    pub user: User,
    pub slug: String,
    #[serde(default)]
    pub name: String,
}

/// `get_workspace`: public details, or null. Returns `Option<Workspace>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SlugArgs {
    pub slug: String,
}

/// `list_members`: members only. Returns `Outcome<Vec<Member>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListMembersArgs {
    pub slug: String,
    pub viewer: crate::Viewer,
}

/// `add_member` and `remove_member`: owners only.
/// Each returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MemberArgs {
    pub actor: User,
    pub slug: String,
    pub username: String,
}

/// `oauth_authorize`: the signed-in person approved an application. The
/// caller has checked the client and that it may be redirected to
/// `redirect_uri`. Returns `OAuthCode`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAuthorizeArgs {
    pub user: User,
    pub client_id: String,
    /// Shown wherever the application's access is listed.
    pub client_name: String,
    pub redirect_uri: String,
    /// PKCE challenge, method S256.
    pub code_challenge: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthCode {
    pub code: String,
}

/// `oauth_exchange`: redeems an authorization code.
/// Returns `Outcome<OAuthTokens>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthExchangeArgs {
    pub code: String,
    pub code_verifier: String,
    pub client_id: String,
    pub redirect_uri: String,
}

/// `oauth_refresh`: trades a refresh token for new tokens.
/// Returns `Outcome<OAuthTokens>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthRefreshArgs {
    pub refresh_token: String,
    pub client_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    /// Works once; using it returns the next one.
    pub refresh_token: String,
    /// Seconds until the access token stops working.
    pub expires_in: u64,
}

/// An application a person has signed in to. Listed by `list_oauth_grants`
/// and ended by `revoke_oauth_grant`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthGrant {
    pub id: String,
    pub client_name: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub last_used_at: String,
}
