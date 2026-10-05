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
    /// RFC 3339, to within a few minutes. Null until it is first used.
    pub last_used_at: Option<String>,
    /// For a workspace's token, the username of the member who made it.
    /// Null once that account is gone, and on personal tokens.
    pub created_by: Option<String>,
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

/// `usernames`: the names behind account and workspace ids, as events and
/// other records store them. Returns a map from id to name; ids it does
/// not know are left out.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsernamesArgs {
    pub ids: Vec<String>,
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

/// `create_access_token`: a token that acts as `user`. For a workspace
/// acting through a token of its own, the new token belongs to that
/// workspace too.
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
    /// One line saying what the workspace is for.
    pub description: Option<String>,
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

/// `update_workspace`: owners only. An empty name falls back to the slug;
/// an empty description clears it. Returns `Outcome<Workspace>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateWorkspaceArgs {
    pub actor: User,
    pub slug: String,
    pub name: String,
    pub description: String,
}

/// `list_workspace_tokens`: members only. Returns
/// `Outcome<Vec<AccessToken>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceTokensArgs {
    pub slug: String,
    pub viewer: crate::Viewer,
}

/// `create_workspace_token`: owners only. The token belongs to the
/// workspace, acts as it, and keeps working when the member who made it
/// leaves. Returns `Outcome<CreatedAccessToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateWorkspaceTokenArgs {
    pub actor: User,
    pub slug: String,
    pub name: String,
}

/// `remove_workspace_token`: owners only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveWorkspaceTokenArgs {
    pub actor: User,
    pub slug: String,
    pub id: String,
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


/// What an agent's token may do: these operations, in this repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentScope {
    pub repo: crate::repos::RepoPath,
    /// API and MCP operation names, such as `create_issue`.
    pub operations: Vec<String>,
}

/// `create_agent_token`: a token for a g1t agent working on someone's
/// behalf. It acts as `g1t-agent`, a member of the repository's workspace,
/// and only for the operations in `scope`. Returns `CreatedAccessToken`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentTokenArgs {
    /// The person the agent works for; the token is recorded as theirs.
    pub on_behalf_of: User,
    pub scope: AgentScope,
    pub ttl_seconds: u64,
}

// `agent_scope` takes `TokenArgs` and returns `Option<AgentScope>`: what an
// agent's token may do, or null for any other token.

/// The id and name g1t's agents act under.
pub const AGENT_ID: &str = "usr_g1t_agent";
pub const AGENT_NAME: &str = "g1t-agent";

// --- Staff ---------------------------------------------------------------
//
// Staff-only methods, for sudo.g1t.sh. They take no viewer and check no
// membership: only sudo calls them, over its service binding, after it has
// verified a Cloudflare Access sign-in and its staff list. Nothing a
// customer can reach should ever forward to them.

/// `notify_owners`: emails a short notice, with one link, to each owner of
/// a workspace with a confirmed address. Called by other services (billing
/// warns owners near their usage limit), never on a person's behalf.
/// Returns how many were sent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NotifyOwnersArgs {
    pub workspace: String,
    pub subject: String,
    /// One or two sentences: what happened and what it means.
    pub intro: String,
    /// The button's words, such as `Open billing`.
    pub action: String,
    /// Where the button goes; must be on g1t.sh.
    pub link: String,
    /// Small print: why they got it.
    pub footer: String,
}

/// `admin_workspaces`: every workspace, newest first, at most
/// [`ADMIN_WORKSPACES_LIMIT`], optionally only those whose slug, name or
/// an owner's username or email contains `query`. Returns
/// `Vec<AdminWorkspace>`. Staff only.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminWorkspacesArgs {
    #[serde(default)]
    pub query: Option<String>,
}

/// The most workspaces one `admin_workspaces` call returns.
pub const ADMIN_WORKSPACES_LIMIT: usize = 500;

/// An owner of a workspace, as staff see them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdminOwner {
    pub username: String,
    pub email: Option<String>,
}

/// A workspace as staff see it: who owns it and how many belong to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWorkspace {
    pub slug: String,
    pub name: String,
    /// RFC 3339.
    pub created_at: String,
    pub owners: Vec<AdminOwner>,
    pub member_count: u32,
}

/// `admin_workspace`: one workspace with every member, or null. Takes
/// `SlugArgs`; returns `Option<AdminWorkspaceDetail>`. Staff only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWorkspaceDetail {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// Owners first, then by username.
    pub members: Vec<AdminMember>,
}

/// A member of a workspace, as staff see them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdminMember {
    pub username: String,
    pub email: Option<String>,
    pub role: crate::Role,
    /// When they joined the workspace. RFC 3339.
    pub joined: String,
}
