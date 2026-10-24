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
    /// When it was last used to sign in over SSH, RFC 3339, to within 5
    /// minutes; null when it never was.
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    /// Its scopes, as `resource:level`, the highest of each resource.
    /// Null: full access (an application's or an agent's credential).
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// Made before tokens had scopes: full access until someone narrows it.
    #[serde(default)]
    pub legacy: bool,
    /// RFC 3339. Null: it does not expire.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Its scopes as permissions: each resource it may use, by name, at
    /// the highest level, such as `{"work": "write"}`. Every resource at
    /// its highest when `scopes` is null.
    #[serde(default)]
    pub permissions: std::collections::BTreeMap<String, String>,
    /// What it is for, as its owner wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A personal token's reach: the workspace it is made for, by slug;
    /// null for every workspace its owner belongs to (or, with
    /// `repository_selection` public, none). Null on a workspace's own
    /// token, which reaches its workspace.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Which repositories of that workspace it reaches.
    #[serde(default)]
    pub repository_selection: crate::scopes::RepositorySelection,
    /// With `selected`: the repositories, as `owner/name`, that the viewer
    /// can see.
    #[serde(default)]
    pub repositories: Vec<String>,
    /// Whether a token made for a workspace that approves tokens may be
    /// used there yet.
    #[serde(default)]
    pub status: crate::tokens::TokenStatus,
    /// Why an owner denied or revoked it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_reason: Option<String>,
    /// Whether it is a workspace's own token, acting as the workspace.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub workspace_owned: bool,
    /// A workspace's own token with Repositories: admin, which acts as an
    /// admin of the workspace's repositories rather than with Write.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub admin: bool,
    /// A person's token its owner let use the website (g1t.sh) as them,
    /// with `Authorization: Bearer`. See [`crate::scopes::TokenAccess::website`].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub website: bool,
}

/// `sign_in`: verifies a username, or any confirmed email address of the
/// account, and its password, for website sign-in. Wrong passwords are
/// counted against the account and `client`, and past a limit nothing is
/// checked for a while (see identity's `throttle.rs`).
/// Returns `Outcome<SignedIn>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SignInArgs {
    pub username: String,
    pub password: String,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub user: User,
    /// Empty while `two_factor_challenge` is set: no session is made until
    /// the code is given.
    pub session_token: String,
    /// Set when the account has two-factor authentication on: the token to
    /// pass to `two_factor_sign_in` with a code. Valid for
    /// `accounts::TWO_FACTOR_CHALLENGE_SECONDS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub two_factor_challenge: Option<String>,
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

/// `user_for_ssh_key`, and `principal_for_ssh_key` (see [`crate::deploy_keys`]).
#[derive(Debug, Serialize, Deserialize)]
pub struct FingerprintArgs {
    pub fingerprint: String,
}

/// `user_by_username`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UsernameArgs {
    pub username: String,
}

/// `user_by_id`: a person as they are now, with their workspaces and roles,
/// for a service acting later on what they asked (auto-merge), which must
/// hold them to what they may do then. For services only. Returns
/// `Viewer`: none for a deleted or unknown account.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserIdArgs {
    pub id: String,
}

/// `usernames`: the names behind account and workspace ids, as events and
/// other records store them. Returns a map from id to name; ids it does
/// not know are left out. Also `accounts`: the accounts behind user ids,
/// each with its username and avatar (`HashMap<String, accounts::EmailOwner>`).
#[derive(Debug, Serialize, Deserialize)]
pub struct UsernamesArgs {
    pub ids: Vec<String>,
}

/// `members_by_email`: services only. Which of these email addresses (at
/// most 500, any case) belong to members of `workspace` (its slug) who
/// have verified them. An address nobody has verified, or a non-member's,
/// is left out. Returns `Vec<MemberEmail>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MembersByEmailArgs {
    pub workspace: String,
    pub emails: Vec<String>,
}

/// An address a member has verified, lowercased, and who they are.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberEmail {
    pub email: String,
    pub user_id: String,
    pub username: String,
}

/// `members_among`: services only. Which of these people (by username,
/// at most 200) are members of `workspace` (its slug). Returns their
/// usernames, lowercased.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MembersAmongArgs {
    pub workspace: String,
    pub usernames: Vec<String>,
}

/// `display_usernames`: how each of these people (by lowercased username,
/// at most 200) wrote their username, for showing it beside the key.
/// Returns a map from the lowercased username to its chosen case; people
/// who chose none, and names nobody has, are left out.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DisplayUsernamesArgs {
    pub usernames: Vec<String>,
}

/// `list_ssh_keys` and `list_access_tokens`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserArgs {
    pub user: User,
}

/// `ssh_key_owners`: services only. The account (user id) that registered
/// each key, by fingerprint (`SHA256:…`, as `ssh-keygen -lf` prints it),
/// for verifying commits signed with SSH keys. Returns a map of the
/// fingerprints found to user ids.
#[derive(Debug, Serialize, Deserialize)]
pub struct SshKeyOwnersArgs {
    pub fingerprints: Vec<String>,
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
    /// left out of the user's token list, unless `listed`. Used for hosted
    /// attempts.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    /// Its scopes, as `resource:level`; unknown names are left out. Null:
    /// full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// Listed with the person's tokens although it expires: one they made
    /// themselves, with an expiry.
    #[serde(default)]
    pub listed: bool,
    /// The one repository it reaches, as `owner/name`: every other is
    /// refused, whatever its owner could reach. Used for a session g1t
    /// starts on someone's Anthropic account (`start_agent_session`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

/// `create_job_token`: a workflow job's `G1T_TOKEN`. It acts as the
/// repository's workspace, reaches that repository only, holds `scopes`
/// (from the job's `permissions`), and is never listed. The actions service
/// revokes it when the job ends (`revoke_job_tokens`); `ttl_seconds` is a
/// backstop. Returns `CreatedAccessToken`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobTokenArgs {
    /// The workspace the repository belongs to, as its own principal.
    pub workspace: User,
    pub repo: crate::repos::RepoPath,
    pub run_id: String,
    pub job_id: String,
    /// What the token is listed as in logs: `G1T_TOKEN for acme/web run 4`.
    pub name: String,
    pub ttl_seconds: u64,
    /// As `resource:level`; unknown names are left out.
    pub scopes: Vec<String>,
    /// Whether it may open and approve pull requests (`JobToken::pull_requests`).
    #[serde(default)]
    pub pull_requests: bool,
}

/// `revoke_job_tokens`: ends a workflow job's tokens at once, when the job
/// finishes or is cancelled. Only job tokens are touched. Returns `bool`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeJobTokensArgs {
    pub job_id: String,
}

/// `create_ask_token`: the credential Ask g1t reads g1t with while it
/// answers one question, through the MCP server, as the person asking.
///
/// It is that person's own token, so every read is checked exactly as
/// theirs would be, cut down three ways: it holds the read scopes only
/// ([`ask_token_scopes`]), so every change is refused whatever the person's
/// role; it is made for `workspace` alone (its repositories, and public
/// ones); and it expires in [`ASK_TOKEN_TTL_SECONDS`]. It is never listed,
/// never shown to the model or the browser, and the integrations service
/// revokes it when the answer ends (`revoke_ask_token`). A workspace's
/// rules for personal access tokens do not apply to it: g1t makes it, for
/// a feature the workspace's owner turned on, and nobody ever holds it.
///
/// Only the integrations service calls it, over its service binding.
/// Returns `Outcome<AskToken>`: refused for anyone but a person who belongs
/// to the workspace.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAskTokenArgs {
    pub actor: User,
    pub workspace: String,
}

/// What `create_ask_token` returns. The plaintext token is returned once
/// and never stored.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskToken {
    pub token: String,
    /// Its id, to revoke it with.
    pub id: String,
}

/// `revoke_ask_token`: ends an Ask credential at once. Only Ask's tokens
/// are touched. Returns `bool`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeAskTokenArgs {
    pub id: String,
}

/// How long an Ask credential lives at most: longer than any one answer.
pub const ASK_TOKEN_TTL_SECONDS: u64 = 5 * 60;
/// What an Ask credential is named, in audit entries and logs.
pub const ASK_TOKEN_NAME: &str = "Ask g1t";
/// Marks a token as Ask's in identity's records (`access_tokens.purpose`).
pub const ASK_TOKEN_PURPOSE: &str = "ask";

/// What an Ask credential holds: every read scope and nothing else.
pub fn ask_token_scopes() -> Vec<crate::scopes::Scope> {
    crate::scopes::Preset::ReadOnly.scopes().unwrap_or_default()
}

/// The plaintext token is returned once and never stored.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreatedAccessToken {
    pub token: String,
    pub info: AccessToken,
}

/// `register`: creates an account and signs it in.
/// Returns `Outcome<SignedIn>`.
///
/// While registration is open, anyone may register, and `invite_code` is
/// optional: an invitation sent to an address without an account
/// (`invite_member`, a repository invitation, Invite a friend, or staff
/// approving a request on the waitlist) carries one, and using it applies
/// the invitation once the address is confirmed. While g1t is in private
/// preview ([`RegistrationMode::Invite`]), a new account needs such a code,
/// for its own address; without one, people ask with `request_access`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterArgs {
    pub username: String,
    pub email: String,
    pub password: String,
    /// An invite code such as `g1t-k7m2-q9xd-4hpw-…`, from an invitation.
    /// One that is unknown, spent or for another address is ignored.
    #[serde(default)]
    pub invite_code: Option<String>,
    /// The `proof` from the invite email's link. When it is the invite's
    /// own and `email` is the address the invite was sent to, the account
    /// starts with that address confirmed; otherwise it is ignored.
    #[serde(default)]
    pub email_proof: Option<String>,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
}

/// `verify_email`: the token from the emailed link. Returns `Outcome<User>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmailTokenArgs {
    pub token: String,
}

/// `request_password_reset`. Always succeeds, so it cannot be used to find
/// out which addresses have accounts. Any confirmed address of an account
/// works: the link goes to the address given, and the primary (and the
/// backup) are told a reset was asked for. A few requests an hour per
/// address and per `client`; past that, nothing is sent.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmailArgs {
    pub email: String,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
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
    /// The workspace's uploaded icon: the SHA-256 of its bytes, served at
    /// `/avatars/<avatar>`. Null means the generated letter avatar.
    #[serde(default)]
    pub avatar: Option<String>,
    /// What every member gets on each of its repositories; owners have
    /// Admin. See [`crate::access`].
    #[serde(default)]
    pub base_permission: crate::access::BasePermission,
    /// Who may create its teams. See [`crate::teams::TeamCreation`].
    #[serde(default)]
    pub team_creation: crate::teams::TeamCreation,
    /// What members may do, by GitHub's names for each
    /// (`members_can_create_public_repositories`...), at the top level as
    /// GitHub's organization has them. See [`crate::MemberPrivileges`].
    #[serde(flatten)]
    pub privileges: crate::MemberPrivileges,
    /// Whether members and outside collaborators need two-factor
    /// authentication to use it.
    #[serde(default)]
    pub two_factor_requirement_enabled: bool,
    /// Its website: an `https://` address.
    #[serde(default)]
    pub website: Option<String>,
    /// Where to reach it: a public email address. Its billing email is
    /// private, and not here (`workspace_billing_email`).
    #[serde(default)]
    pub email: Option<String>,
    /// Where it is, as it puts it.
    #[serde(default)]
    pub location: Option<String>,
    /// Its accounts elsewhere: at most [`MAX_WORKSPACE_SOCIAL_ACCOUNTS`]
    /// `https://` addresses.
    #[serde(default)]
    pub social_accounts: Vec<String>,
}

/// The most social accounts a workspace's profile lists.
pub const MAX_WORKSPACE_SOCIAL_ACCOUNTS: usize = 4;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub username: String,
    /// The username as its owner wrote it (`Ana`), when that differs from
    /// `username`: what pages show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_username: Option<String>,
    pub role: crate::Role,
    /// The roles they hold besides `role`.
    #[serde(default)]
    pub org_roles: Vec<crate::OrgRole>,
    /// Whether they have two-factor authentication on. Shown to owners
    /// only; null for anyone else.
    #[serde(default)]
    pub two_factor: Option<bool>,
    /// Their display name, when they set one.
    #[serde(default)]
    pub name: Option<String>,
    /// Their uploaded avatar: the SHA-256 of its bytes, served at
    /// `/avatars/<avatar>`. None means the generated letter avatar.
    #[serde(default)]
    pub avatar: Option<String>,
}

/// Where a workspace keeps its repositories' git data: anywhere g1t
/// stores it (the default), or in the EU only. It applies to repositories
/// made after it is set; the repos service reads it when it places a new
/// one (`storage_options` says whether the EU can be chosen).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataResidency {
    #[default]
    Anywhere,
    Eu,
}

impl DataResidency {
    pub fn as_str(self) -> &'static str {
        match self {
            DataResidency::Anywhere => "anywhere",
            DataResidency::Eu => "eu",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "anywhere" => Some(DataResidency::Anywhere),
            "eu" => Some(DataResidency::Eu),
            _ => None,
        }
    }
}

/// `workspace_residency` takes [`SlugArgs`] and returns
/// `Option<DataResidency>` (null when there is no such workspace).
/// `set_workspace_residency`: owners only. Returns `Outcome<DataResidency>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetResidencyArgs {
    pub actor: User,
    pub slug: String,
    pub residency: DataResidency,
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

/// `list_members`: members only. Owners also see each member's
/// `two_factor`. Returns `Outcome<Vec<Member>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListMembersArgs {
    pub slug: String,
    pub viewer: crate::Viewer,
}

/// `add_member` and `remove_member`: owners only. `add_member` never adds a
/// person at once: it sends them a workspace invitation to accept or
/// decline, as `invite_member` with a username does. Only g1t's own agent
/// is added at once. Removing yourself is
/// leaving (`members::LeaveWorkspaceArgs`); removing an owner is refused
/// when they are the last. Each returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MemberArgs {
    pub actor: User,
    pub slug: String,
    pub username: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `update_workspace`: owners only. An empty name falls back to the slug;
/// an empty description clears it. Returns `Outcome<Workspace>`.
///
/// The profile fields after `description` are each optional: left out, the
/// stored value stays as it is; empty (or an empty list) clears it. The
/// website and each social account must be `https://` addresses (a bare
/// `example.com` means `https://example.com`); the emails must look like
/// addresses. Blank and repeated social accounts are dropped; more than
/// [`MAX_WORKSPACE_SOCIAL_ACCOUNTS`] are refused.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateWorkspaceArgs {
    pub actor: User,
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub website: Option<String>,
    /// The public email address.
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub social_accounts: Option<Vec<String>>,
    /// The private address billing sends receipts and invoices to.
    #[serde(default)]
    pub billing_email: Option<String>,
}

/// `workspace_billing_email`: owners and billing managers only. The
/// private address billing sends receipts and invoices to, or null when
/// none is set (billing then uses an owner's). Returns
/// `Outcome<Option<String>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceBillingEmailArgs {
    pub actor: User,
    pub slug: String,
}

/// `rename_workspace`: owners only. Changes the workspace's slug, the first
/// segment of its URLs, to `new_slug`; the display name is untouched. The
/// old slug redirects to the new one, and is held for this workspace, for
/// [`SLUG_HOLD_DAYS`]. Publishes `workspace.renamed`. Returns
/// `Outcome<Workspace>`.
///
/// `check_workspace_rename` takes the same arguments and answers whether
/// the rename would be allowed, changing nothing. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorkspaceArgs {
    pub actor: User,
    pub slug: String,
    pub new_slug: String,
}

/// `delete_workspace`: owners only, and only a person. `confirm` must be
/// the workspace's slug, typed out. Refused for a protected workspace
/// ([`protected_names`]), whoever asks, and while billing cannot settle it
/// (`close_workspace`). Everything in it goes with it at once: nobody can
/// reach it, its tokens stop working, its pages are not found, and its
/// repositories, projects and apps are deleted with it. It is kept for
/// [`WORKSPACE_RESTORE_DAYS`] so g1t's staff can restore it, then purged:
/// its memberships, access tokens and old-slug redirects go, and billing's
/// ledger and the audit log keep its history. The slug is never given to
/// another workspace; the person whose username it is may make a workspace
/// of that name again once it is purged. Publishes `workspace.deleting`,
/// and `workspace.deleted` at the purge. Returns `Outcome<bool>`.
///
/// `check_workspace_deletion` takes the same arguments (with `confirm`
/// ignored) and says what would go and whether anything stands in the way,
/// changing nothing. Returns `Outcome<WorkspaceDeletion>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteWorkspaceArgs {
    pub actor: User,
    pub slug: String,
    #[serde(default)]
    pub confirm: String,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// What deleting a workspace takes with it, and what stands in the way.
/// Nothing does when `billing` is null and it is not `protected`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceDeletion {
    /// Its live repositories, which are deleted with it.
    pub repositories: u32,
    /// Its projects, hidden with it.
    pub projects: u32,
    #[serde(default)]
    pub members: u32,
    /// Why billing cannot close the workspace yet, in words for its owner.
    pub billing: Option<String>,
    /// It can never be deleted, by anyone ([`protected_names`]).
    #[serde(default)]
    pub protected: bool,
}

impl WorkspaceDeletion {
    pub fn blocked(&self) -> bool {
        self.protected || self.billing.is_some()
    }

    /// Why the workspace cannot be deleted, as one sentence, or `None`.
    pub fn reason(&self, slug: &str) -> Option<String> {
        if self.protected {
            return Some(protected_refusal(slug));
        }
        self.billing.clone()
    }
}

/// How long a deleted workspace is kept, for staff to restore, before it is
/// purged.
pub const WORKSPACE_RESTORE_DAYS: u64 = 30;

/// Workspaces nobody can delete, whatever identity's `PROTECTED_WORKSPACES`
/// says: Flagon's, which runs g1t.
pub const ALWAYS_PROTECTED: &[&str] = &["flagon-io"];

/// The protected workspaces: `configured` (comma-separated slugs or
/// workspace ids, as identity's `PROTECTED_WORKSPACES` holds them), and
/// [`ALWAYS_PROTECTED`] whatever it says, so an empty or missing variable
/// still protects them. Lowercased, without duplicates.
pub fn protected_names(configured: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let given = configured.unwrap_or_default().split(',');
    for name in ALWAYS_PROTECTED.iter().copied().chain(given) {
        let name = name.trim().to_lowercase();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Why a protected workspace is not deleted, purged or acted on.
pub fn protected_refusal(slug: &str) -> String {
    format!("{slug} is protected and can never be deleted.")
}

/// `admin_deleted_workspaces` takes no arguments (`{}`) and returns
/// `Vec<DeletedWorkspace>`, newest first. Staff only.
///
/// A workspace an owner deleted, kept until `purge_after` for staff to
/// restore.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedWorkspace {
    pub workspace_id: String,
    pub slug: String,
    pub name: String,
    /// RFC 3339.
    pub deleted_at: String,
    /// The username of the owner who deleted it, or the staff member (by
    /// email) who deleted it with the account that was its only owner.
    pub deleted_by: String,
    /// RFC 3339: when it is purged unless restored first.
    pub purge_after: String,
    /// What went with it, counted when it was deleted.
    pub went: WorkspaceDeletion,
    /// Whether staff can still restore it.
    pub restorable: bool,
}

/// `admin_restore_workspace` and `admin_purge_workspace`: staff restore a
/// deleted workspace within [`WORKSPACE_RESTORE_DAYS`], or purge it now.
/// `staff` is who, for the audit logs. Purging needs `confirm`, the slug
/// typed out, and is refused for a protected workspace. Restoring publishes
/// `workspace.restored`; purging, `workspace.deleted`. Both return
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminDeletedWorkspaceArgs {
    pub workspace_id: String,
    pub staff: String,
    #[serde(default)]
    pub confirm: String,
}

/// `transfer_repo_scopes`: a repository moved from `from` to `to`; the
/// tokens of agents at work on it are kept pointing at it. For repos'
/// `transfer`. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TransferRepoScopesArgs {
    pub from: crate::repos::RepoPath,
    pub to: crate::repos::RepoPath,
}

/// How long a workspace's old slug keeps redirecting to it, and stays
/// reserved for it, after a rename.
pub const SLUG_HOLD_DAYS: u64 = 90;

/// How long a workspace must wait between renames.
pub const RENAME_COOLDOWN_HOURS: u64 = 24;

// `resolve_slug` takes `SlugArgs` and returns `Option<String>`: the
// workspace's current slug when `slug` is one it was renamed from within
// the last `SLUG_HOLD_DAYS`, and null otherwise (including for a slug that
// is in use), or the workspace's slug when `slug` is one of its aliases.

// `resolve_alias` takes `SlugArgs` and returns `Option<String>`: the slug
// now of the workspace `slug` is an alias of, and null when it is none.
// Aliases are set by g1t's staff only: `g1t` is Flagon, Inc.'s `flagon-io`.
// An alias follows its workspace through renames.

/// `admin_aliases` takes no arguments (`{}`) and returns
/// `Vec<WorkspaceAlias>`, by alias. Staff only.
///
/// A name staff point at a workspace, so that its addresses (pages, git,
/// the API, packages) lead to the workspace under its own name.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAlias {
    pub alias: String,
    pub workspace_id: String,
    /// The workspace's slug and name now.
    pub workspace: String,
    pub workspace_name: String,
    /// Why it exists, as staff wrote it.
    pub note: String,
    /// The staff member who set it, or `migration`.
    pub created_by: String,
    /// RFC 3339.
    pub created_at: String,
}

/// `admin_set_alias`: points `alias` at the workspace whose slug is
/// `workspace`. The alias must have a namespace's shape, must not be one of
/// the site's routes, and must not be anyone's username, a workspace's slug
/// (deleted, or held after a rename) or another alias. `note` is required:
/// it is the reason, kept with the alias and in sudo's audit log. Staff
/// only. Returns `Outcome<WorkspaceAlias>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSetAliasArgs {
    pub alias: String,
    pub workspace: String,
    pub note: String,
    pub staff: String,
}

/// `admin_remove_alias`: the alias stops leading anywhere, and the name is
/// nobody's again unless it is reserved. `reason` goes in sudo's audit log.
/// Staff only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminRemoveAliasArgs {
    pub alias: String,
    pub reason: String,
    pub staff: String,
}

/// `set_workspace_avatar`: owners only. `image` is the file's bytes in
/// base64: PNG, JPEG, WebP or GIF, at most `MAX_AVATAR_BYTES`. Null removes
/// the icon. Returns `Outcome<Workspace>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetWorkspaceAvatarArgs {
    pub actor: User,
    pub slug: String,
    pub image: Option<String>,
}

/// `set_user_avatar`: a person's own avatar, as `SetWorkspaceAvatarArgs`.
/// Returns `Outcome<Option<String>>`: the new avatar, or null once removed.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetUserAvatarArgs {
    pub user: User,
    pub image: Option<String>,
}

/// The largest avatar that can be uploaded, in bytes.
pub const MAX_AVATAR_BYTES: usize = 1024 * 1024;

/// `list_workspace_tokens`: members only. Returns
/// `Outcome<Vec<AccessToken>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceTokensArgs {
    pub slug: String,
    pub viewer: crate::Viewer,
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
    /// What the person granted, as `resource:level`. Null: full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
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
    /// The scopes granted, space-separated, or `*` for full access.
    #[serde(default)]
    pub scope: Option<String>,
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
    /// What the person granted. Null: full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// Signed in before applications were given scopes: full access until
    /// someone narrows it.
    #[serde(default)]
    pub legacy: bool,
}

/// `update_oauth_grant`: changes what an application the person signed in
/// to may do, at once and when it refreshes. Returns `Outcome<OAuthGrant>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateOAuthGrantArgs {
    pub user: User,
    pub id: String,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
}

/// What a scoped token may do: these operations, in this repository. Run
/// credentials (a token for one CI or sandbox run, see
/// [`crate::credentials`]) carry one today, and so do tokens g1t's retired
/// hosted agents were issued, which still parse so their stored rows and
/// the `@g1t` history they wrote read as before.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentScope {
    pub repo: crate::repos::RepoPath,
    /// API and MCP operation names, such as `open_work_item`.
    pub operations: Vec<String>,
    /// Set on a run credential: the run it belongs to, and what it may do
    /// with git. See [`crate::credentials`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<crate::credentials::RunBinding>,
}

/// The id g1t's retired hosted agent acted under. Only ever stored, never
/// shown: rows it wrote keep it, and still render as g1t's
/// ([`crate::system::ID`]) work without counting as g1t itself, such as
/// for whether an approval counts.
pub const AGENT_ID: &str = "usr_g1t_agent";
/// The name g1t's agent is shown by: g1t's own, [`crate::system::USERNAME`].
/// Everything it does, people see g1t do.
pub const AGENT_NAME: &str = crate::system::USERNAME;

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

/// `admin_growth` takes `{}` and returns `AdminGrowth`: how many people
/// and workspaces there are, and how many are new. Deleted ones are not
/// counted. Staff only.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AdminGrowth {
    pub people: GrowthCount,
    pub workspaces: GrowthCount,
}

/// One count for [`AdminGrowth`], with what is new in it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthCount {
    pub total: u32,
    /// Created in the last 24 hours.
    pub day: u32,
    /// Created in the last 7 days.
    pub week: u32,
    /// Created in the 7 days before those.
    pub prior_week: u32,
    /// The newest one's username or slug.
    pub newest: Option<String>,
    /// When the newest one was created. RFC 3339.
    pub newest_at: Option<String>,
}

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
    /// It can never be deleted ([`protected_names`]).
    #[serde(default)]
    pub protected: bool,
    /// Set while staff have it suspended.
    #[serde(default)]
    pub suspended: Option<Suspension>,
    /// The private address billing sends receipts and invoices to, when
    /// one is set; billing otherwise uses an owner's.
    #[serde(default)]
    pub billing_email: Option<String>,
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

// --- Profiles ------------------------------------------------------------
//
// A person's public page at `g1t.sh/u/<username>`. Everything in a
// `Profile` is shown to anyone, signed in or not; an email address never is.

/// The most characters each profile field takes.
pub const MAX_PROFILE_NAME: usize = 80;
pub const MAX_PROFILE_BIO: usize = 160;
pub const MAX_PROFILE_LOCATION: usize = 80;
pub const MAX_PROFILE_WEBSITE: usize = 200;
pub const MAX_PROFILE_PRONOUNS: usize = 40;
pub const MAX_PROFILE_TIMEZONE: usize = 64;

/// What anyone may see about a person.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Lowercased: what the profile is found and linked by.
    pub username: String,
    /// The username as its owner wrote it, when that differs: what the page shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_username: Option<String>,
    /// The name they go by, if they gave one.
    pub name: Option<String>,
    /// One or two lines about them, at most [`MAX_PROFILE_BIO`] characters.
    pub bio: Option<String>,
    pub location: Option<String>,
    /// An `https://` address.
    pub website: Option<String>,
    pub pronouns: Option<String>,
    /// The time zone they are in, an IANA name such as `America/Denver`.
    #[serde(default)]
    pub timezone: Option<String>,
    /// The uploaded avatar's hash, served at `/avatars/<avatar>`.
    pub avatar: Option<String>,
    /// When the account was made. RFC 3339.
    pub created_at: String,
}

// `profile` takes `UsernameArgs` and returns `Option<Profile>`: null for
// an account that does not exist.

/// `update_profile`: a person changes their own profile. Every field is
/// replaced; an empty one is cleared. Returns `Outcome<Profile>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileArgs {
    pub actor: User,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub pronouns: String,
    /// An IANA time zone name, such as `America/Denver`.
    #[serde(default)]
    pub timezone: String,
}

/// `profile_workspaces`: the workspaces shown on a person's profile, as
/// `viewer` may see them. A membership is shown only when it is no secret
/// from the viewer: a workspace the viewer belongs to as well, or one of
/// `public`, the workspaces the caller found the person has made a public
/// project in (whose page shows that already). Returns
/// `Vec<ProfileWorkspace>`; empty for an account that does not exist.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileWorkspacesArgs {
    pub username: String,
    pub viewer: crate::Viewer,
    #[serde(default)]
    pub public: Vec<String>,
}

/// A workspace on a person's profile.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProfileWorkspace {
    pub slug: String,
    pub name: String,
    pub avatar: Option<String>,
}

// --- Dock pins -------------------------------------------------------------
//
// The apps a person pins to their dock in a workspace, kept with their
// account so the dock follows them to every device. Each person's own:
// nobody else reads or sets them.

/// The most apps a person pins in one workspace.
pub const MAX_DOCK_PINS: usize = 24;
/// The most characters an app key takes.
pub const MAX_DOCK_APP_KEY: usize = 32;

/// `dock_pins`: the apps `user` pinned in the workspace `workspace` (a
/// slug), in the order they set. Returns `Option<Vec<String>>`: null when
/// they never saved any there, or are not one of its members.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockPinsArgs {
    pub user: User,
    pub workspace: String,
}

/// `set_dock_pins`: replaces `user`'s pins in `workspace` with `apps`, in
/// that order. Each key is lowercase letters, digits and hyphens, at most
/// [`MAX_DOCK_APP_KEY`] characters; a repeat is dropped; at most
/// [`MAX_DOCK_PINS`]. Which keys name real apps is the web app's to say.
/// Returns `Outcome<Vec<String>>`: the pins as saved.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDockPinsArgs {
    pub user: User,
    pub workspace: String,
    #[serde(default)]
    pub apps: Vec<String>,
}

// --- Getting started in a workspace ----------------------------------------
//
// The setup guide a workspace's owners see on its Home until they finish
// or dismiss it: adding an AI provider, Ask's model, bringing code,
// connecting a harness, inviting people and a runner. Whether each step is
// done is read from the workspace itself (its providers, repositories,
// members, runners), never kept here; identity keeps only what the person
// chose: that they dismissed it, and the steps they skipped. Each person's
// own, per workspace. Mirrors `Onboarding` in
// packages/contracts/src/identity.ts.

/// The steps of the guide, in order. `ask`, `people` and `runner` can be
/// skipped; the rest are what a workspace needs to get going.
pub const ONBOARDING_STEPS: [&str; 6] = ["ai", "ask", "code", "harness", "people", "runner"];

/// A person's own state of the guide in one workspace, as kept and as
/// answered. Wire fields are snake_case, as the API's are.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Onboarding {
    /// When they dismissed it, so it no longer opens by itself; null while
    /// it still does. Opening it again from Settings or the AI page leaves
    /// this as it is.
    #[serde(default)]
    pub dismissed_at: Option<String>,
    /// The steps they chose to skip, in [`ONBOARDING_STEPS`] order: shown
    /// as skipped rather than to do, and not counted against finishing.
    #[serde(default)]
    pub skipped: Vec<String>,
    /// When they last changed it; null when they never have.
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// A change to it: only what is sent changes. `dismissed` true dismisses
/// it now (a second dismissal keeps the first time), false brings it back
/// to opening by itself. `skipped` replaces the skipped steps.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingChange {
    #[serde(default)]
    pub dismissed: Option<bool>,
    #[serde(default)]
    pub skipped: Option<Vec<String>>,
}

/// `onboarding`: `user`'s own state of the guide in the workspace
/// `workspace` (a slug). Returns `Outcome<Onboarding>`: the defaults (not
/// dismissed, nothing skipped) when they never changed it, `not_found`
/// when they are not one of its members. People only.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingArgs {
    pub user: User,
    pub workspace: String,
}

/// `set_onboarding`: changes `user`'s own state of the guide in
/// `workspace`. Returns `Outcome<Onboarding>`: as kept, or `invalid` for a
/// step the guide does not have.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOnboardingArgs {
    pub user: User,
    pub workspace: String,
    #[serde(default)]
    pub change: OnboardingChange,
}

// --- Sounds and desktop notifications --------------------------------------
//
// What a person hears when chat moves, kept with their account so a phone,
// a laptop and the desktop app all sound the same. Which sound plays when
// is the web app's rule (apps/web/app/lib/chat-sounds.ts); identity keeps
// the choices. Do not disturb is not here: it is the person's presence
// (`dnd_until`, services/notify), which also silences pop-ups and pushes.
// Mirrors `SoundSettings` in packages/contracts/src/identity.ts.

/// The sets of sounds a person can choose from.
pub const SOUND_SETS: [&str; 2] = ["soft", "bright"];
/// The cues a person can turn on and off. `call` is reserved and has no setting.
pub const SOUND_CUES: [&str; 4] = ["message", "direct", "mention", "sent"];
/// Cues that no longer play: `agent_done`, from g1t's retired hosted
/// agents. Saved settings that name one still read, without it, and a
/// change that names one leaves it out rather than failing.
pub const RETIRED_SOUND_CUES: [&str; 1] = ["agent_done"];
/// Before anyone changes them: every cue but the tick as you send.
pub const SOUND_CUES_OFF_BY_DEFAULT: [&str; 1] = ["sent"];
pub const DEFAULT_SOUND_SET: &str = "soft";
pub const DEFAULT_SOUND_VOLUME: u8 = 60;

/// A person's sound settings, as kept and as answered. Wire fields are
/// snake_case, as the site's JSON is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoundSettings {
    /// Whether anything plays at all.
    pub sounds_enabled: bool,
    /// One of [`SOUND_SETS`].
    pub sound_set: String,
    /// 0 to 100.
    pub sound_volume: u8,
    /// Each cue on or off, by name; a cue left out is on, except `sent`.
    #[serde(default)]
    pub sound_cues: std::collections::BTreeMap<String, bool>,
    /// Whether an open tab shows a system notification for a message to
    /// you while its window is not in front.
    pub desktop_toasts: bool,
}

impl Default for SoundSettings {
    fn default() -> Self {
        SoundSettings {
            sounds_enabled: true,
            sound_set: DEFAULT_SOUND_SET.to_owned(),
            sound_volume: DEFAULT_SOUND_VOLUME,
            sound_cues: SOUND_CUES.iter().map(|cue| ((*cue).to_owned(), !SOUND_CUES_OFF_BY_DEFAULT.contains(cue))).collect(),
            desktop_toasts: false,
        }
    }
}

/// A change to them: only what is sent changes; `sound_cues` merges by cue.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoundSettingsChange {
    #[serde(default)]
    pub sounds_enabled: Option<bool>,
    #[serde(default)]
    pub sound_set: Option<String>,
    #[serde(default)]
    pub sound_volume: Option<i64>,
    #[serde(default)]
    pub sound_cues: Option<std::collections::BTreeMap<String, bool>>,
    #[serde(default)]
    pub desktop_toasts: Option<bool>,
}

/// `sound_settings`: `user`'s own, or the defaults when they never changed
/// them. Returns `SoundSettings`. People only.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSettingsArgs {
    pub user: User,
}

/// `set_sound_settings`: changes `user`'s own. Returns
/// `Outcome<SoundSettings>`: the settings as kept, or `invalid` for a set
/// or cue g1t does not have, or a volume outside 0 to 100.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSoundSettingsArgs {
    pub user: User,
    #[serde(default)]
    pub change: SoundSettingsChange,
}

/// `directory`: every account or every workspace, as their public pages
/// show them, a page at a time in name order. For services that index
/// them, such as search; nothing private is in it. Returns
/// `DirectoryPage`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DirectoryArgs {
    /// `user` or `workspace`.
    pub kind: String,
    /// Names after this one.
    #[serde(default)]
    pub after: Option<String>,
    pub limit: u32,
}

/// One account or workspace in the directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    /// The account's or workspace's id.
    pub id: String,
    /// A username or a workspace's slug.
    pub slug: String,
    /// A person's display name or a workspace's name.
    pub name: Option<String>,
    /// A person's bio or a workspace's description.
    pub bio: Option<String>,
    pub avatar: Option<String>,
    /// RFC 3339.
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DirectoryPage {
    pub entries: Vec<DirectoryEntry>,
    /// Where the next page starts; null on the last.
    pub next: Option<String>,
}

// --- Invites ---------------------------------------------------------------
//
// An invitation into a workspace or onto a repository, sent to an address
// without an account, carries an invite code: registering with it applies
// the invitation once the address is confirmed. Anyone may register
// without one. See services/identity/src/invites.rs.
//
// Any person may also invite a friend to g1t by email ("Invite a friend",
// `create_invite`): word of mouth, never a gate. Each person has
// `INVITES_PER_USER` of those for good; one revoked or expired before it
// was used comes back, one used is spent. See
// services/identity/src/invites/friends.rs.

/// How long an invite works, unless identity's `INVITE_TTL_DAYS` var says
/// otherwise.
pub const INVITE_TTL_DAYS: u64 = 30;

/// How many friends one person may invite to g1t, unless identity's
/// `INVITES_PER_USER` var says otherwise. Staff may grant more.
pub const INVITES_PER_USER: u32 = 20;

/// Where an invite stands. Only a pending invite can be used. A pending
/// invite can be revoked, and so can one awaiting confirmation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Pending,
    /// Used to make an account that has not confirmed its email address
    /// yet. The code is spent; the workspace (or repository) it gives is
    /// joined when the address is confirmed, unless it is revoked first.
    AwaitingConfirmation,
    /// Used to make an account that has confirmed its address, for a
    /// workspace it has not yet joined or declined: the workspace
    /// invitation waits for the person's answer (`accept_invitation`).
    AwaitingAnswer,
    Redeemed,
    /// Its person declined the workspace it invited them to.
    Declined,
    Expired,
    Revoked,
}

/// What using an invite does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteKind {
    /// Makes a new account, and joins `workspace` when one is set.
    Account,
    /// An existing account joins `workspace`. Never makes an account.
    Workspace,
}

/// Whose invites an invite used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteCharge {
    /// Its inviter's own: an invite to g1t made with Invite a friend.
    User,
    /// A workspace's, granted by staff before registration opened. Read
    /// only: none are made any more.
    Workspace,
    /// Nobody's: an invitation into a workspace or onto a repository, or
    /// one staff made.
    #[default]
    None,
}

/// One invite, as the person who made it sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    /// The code, such as `g1t-k7m2-q9xd-…`: returned once when the invite
    /// is made, and afterwards to whoever made it while it is pending.
    /// Null otherwise.
    pub code: Option<String>,
    /// The code's first group, such as `g1t-k7m2`, to recognise it by.
    pub hint: String,
    /// Only an account with this address can use it. Null: anyone with
    /// the code.
    pub email: Option<String>,
    pub kind: InviteKind,
    /// The workspace it joins, by slug.
    pub workspace: Option<String>,
    pub status: InviteStatus,
    /// Whose invites it used: `user` for an invite to g1t from Invite a
    /// friend, which counts against its inviter's.
    #[serde(default)]
    pub charged_to: InviteCharge,
    /// Who made it, by username. Null when g1t staff did.
    pub invited_by: Option<String>,
    /// The account that used it, by username.
    pub redeemed_by: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub expires_at: String,
    /// RFC 3339.
    pub redeemed_at: Option<String>,
    /// RFC 3339.
    pub revoked_at: Option<String>,
    /// The account a workspace invitation is for, by username: someone
    /// invited by username, or the account the invite made.
    #[serde(default)]
    pub invitee: Option<String>,
    /// The role `workspace` is joined with. Null when it names none.
    #[serde(default)]
    pub role: Option<crate::Role>,
    /// The staff member who minted it. Only in staff views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staff: Option<String>,
}

/// How many friends a person may invite to g1t, and how many they have.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowance {
    /// [`INVITES_PER_USER`] (or identity's var) plus what staff granted.
    pub limit: u32,
    /// Pending and used invites; revoked and expired ones never used are
    /// not counted.
    pub used: u32,
    pub remaining: u32,
}

impl Allowance {
    pub fn new(limit: u32, used: u32) -> Allowance {
        Allowance { limit, used, remaining: limit.saturating_sub(used) }
    }

    pub fn exhausted(&self) -> bool {
        self.remaining == 0
    }
}

/// `list_invites` (takes `UserArgs`): the invites to g1t a person made,
/// newest first, and how many they have left. Returns `InvitesOverview`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvitesOverview {
    pub allowance: Allowance,
    pub invites: Vec<Invite>,
}

/// `create_invite`: a person invites a friend to g1t by email. Anyone may
/// sign up without one; the invite is a note from a friend, with a link
/// that opens sign-up with the address filled in and, from the email,
/// confirmed. People only, never an agent or a workspace's token, and not
/// before their own address is confirmed. Uses one of the person's
/// invites. Refused with `Conflict` when the address has a g1t account or
/// the person already has a pending invite for it (neither costs one), and
/// `Limit` when none are left. Returns `Outcome<Invite>`, with the code.
///
/// `revoke_invite` (takes `RemoveArgs`): its maker revokes a pending
/// invite (or a workspace's owner one made for the workspace); one that
/// was not used comes back. Returns `Outcome<Invite>`.
///
/// `resend_invite` (takes `RemoveArgs`): its maker sends a pending invite
/// to g1t again, the same email to the same address. Returns
/// `Outcome<Invite>`; one that is not pending answers `Conflict`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateInviteArgs {
    pub user: User,
    pub email: String,
    /// A note from whoever invites, quoted in the email. Up to
    /// [`MAX_INVITE_MESSAGE`] characters; longer is cut, blank is none.
    #[serde(default)]
    pub message: Option<String>,
    /// Also invite them to this workspace, by slug: one the person owns,
    /// on a paid plan (a free one is refused with `PaymentRequired`). Once
    /// the account is confirmed it gets a workspace invitation to accept or
    /// decline, and no workspace of its own is made for it.
    #[serde(default)]
    pub join: Option<String>,
    /// The role `join` invites them with; member when absent. Ignored
    /// without `join`.
    #[serde(default)]
    pub join_role: Option<crate::Role>,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `check_invite`: what an invite code is for, before using it. Returns
/// `Outcome<InvitePreview>`; a code that is unknown, used, revoked or
/// expired gets the same answer, so codes cannot be probed. With
/// `any_status`, a real code that can no longer be used is described
/// instead (its `status` says why), so the page can say whom to ask for a
/// new one; an unknown code still gets the one answer.
#[derive(Debug, Serialize, Deserialize)]
pub struct InviteCodeArgs {
    pub code: String,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
    /// Who is looking, if signed in: sets `InvitePreview::for_viewer`.
    #[serde(default)]
    pub viewer: Option<User>,
    #[serde(default)]
    pub any_status: bool,
    /// The `proof` from the invite email's link, if the page was opened
    /// from it: sets `InvitePreview::email_proven`.
    #[serde(default)]
    pub email_proof: Option<String>,
}

/// Someone shown on an invite.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteFrom {
    pub username: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
}

/// A repository an invite code was sent with: using the code accepts the
/// invitation to collaborate on it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteRepository {
    /// `workspace/repo`.
    pub name: String,
    /// The role it gives, such as `write`.
    pub role: String,
}

/// What a valid invite code is for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    pub kind: InviteKind,
    /// Pending, unless `any_status` asked about a code that is spent.
    pub status: InviteStatus,
    /// Null when g1t staff sent it.
    pub invited_by: Option<InviteFrom>,
    pub workspace: Option<ProfileWorkspace>,
    /// The repository it accepts an invitation to, if it was sent with one.
    pub repository: Option<InviteRepository>,
    /// The address it is for, partly hidden, such as `a•••@example.com`.
    pub email: Option<String>,
    /// The address in full, while it is pending: whoever holds the code
    /// was sent it there. Fills in and locks the sign-up form.
    pub address: Option<String>,
    /// Whether the address it is for has a g1t account already, so the
    /// page asks them to sign in rather than sign up.
    pub has_account: bool,
    /// With a viewer: whether the invite is theirs (it is for one of their
    /// confirmed addresses, or they used it). Null without a viewer or,
    /// for a pending invite, when it is for anyone with the code.
    pub for_viewer: Option<bool>,
    /// RFC 3339.
    pub expires_at: String,
    /// Whether `email_proof` was this pending invite's own, from the email
    /// it was sent in: the account made with it starts with `address`
    /// confirmed. False without a proof, with a wrong one, and for an
    /// invite bound to no address.
    #[serde(default)]
    pub email_proven: bool,
}

/// `accept_invite`: a signed-in person uses a workspace invite made for
/// their confirmed address, and joins the workspace, or an invite sent with
/// a repository invitation, and accepts it. Returns `Outcome<String>`: the
/// workspace's slug, or `workspace/repo`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AcceptInviteArgs {
    pub user: User,
    pub code: String,
}

/// `invite_member`: an owner invites an email address into a workspace.
/// It always makes an invite bound to that address and emails it, so the
/// answer never says whether the address has an account. Without one, the
/// invite registers and joins in one step. Returns `Outcome<Invite>`, with
/// the code.
#[derive(Debug, Serialize, Deserialize)]
pub struct InviteMemberArgs {
    pub actor: User,
    pub slug: String,
    /// An email address. Give this or `username`.
    #[serde(default)]
    pub email: String,
    /// A g1t username: that account gets a workspace invitation to accept
    /// or decline, in its inbox and by email. Nobody joins without saying
    /// yes.
    #[serde(default)]
    pub username: Option<String>,
    /// The role they join with; member when absent.
    #[serde(default)]
    pub role: Option<crate::Role>,
    /// A note from whoever invites, quoted in the invitation email. Up to
    /// [`MAX_INVITE_MESSAGE`] characters; longer is cut, blank is none.
    #[serde(default)]
    pub message: Option<String>,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// The most characters an invitation's note keeps.
pub const MAX_INVITE_MESSAGE: usize = 500;

/// A workspace invitation waiting for its person's answer, as they see it.
/// `list_invitations` (takes `UserArgs`) returns `Vec<WorkspaceInvitation>`,
/// newest first: pending ones only, never expired, revoked or answered.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInvitation {
    pub id: String,
    pub workspace: ProfileWorkspace,
    /// The role accepting joins with.
    pub role: crate::Role,
    /// Null when g1t staff sent it.
    pub invited_by: Option<InviteFrom>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub expires_at: String,
}

/// `accept_invitation`: the person it is for joins the workspace with the
/// role it names. Returns `Outcome<String>`, the workspace's slug.
///
/// `decline_invitation`: they say no; whoever sent it is told in their
/// inbox. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct InvitationArgs {
    pub user: User,
    pub id: String,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `find_people`: accounts whose username starts with `query`, or whose
/// name contains it, for picking someone to invite. Only what a profile
/// shows: a username, a name and an avatar, never an email address.
/// Returns `Vec<InviteFrom>`, at most `limit` (10 at most, 8 when absent).
#[derive(Debug, Serialize, Deserialize)]
pub struct FindPeopleArgs {
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `workspace_invites` (takes `ListMembersArgs`): a workspace's invites,
/// newest first. Owners only. Returns `Outcome<Vec<Invite>>`.
///
/// `revoke_workspace_invite`: owners only. Returns `Outcome<Invite>`.
///
/// `resend_workspace_invite`: owners only. Sends a pending invitation
/// again, by email to the address it is bound to or the invited account's
/// confirmed address, and again in that account's inbox. The invitation
/// itself is unchanged: same code, same day it stops working. Returns
/// `Outcome<Invite>`; one that is not pending answers `409`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceInviteArgs {
    pub actor: User,
    pub slug: String,
    pub id: String,
}

// --- Invites, staff only ---

/// The most rows one staff listing of invites returns.
pub const ADMIN_INVITES_LIMIT: usize = 500;

/// `admin_invites`: every invite, newest first, at most
/// [`ADMIN_INVITES_LIMIT`], optionally only those whose code starts with
/// `query`, or whose email, inviter or redeemer contains it, and with
/// `to_g1t` only invites to g1t from Invite a friend. Returns
/// `Vec<Invite>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminInvitesArgs {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub to_g1t: bool,
}

/// `admin_grant_invites`: gives a person (by username) `amount` more
/// invites to g1t; a negative amount takes some back. Kept with `note` and
/// the staff member. Returns `Outcome<Allowance>`: theirs afterwards.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminGrantInvitesArgs {
    pub username: String,
    pub amount: i32,
    #[serde(default)]
    pub note: String,
    pub staff: String,
}

/// The most invites one grant gives or takes back.
pub const MAX_INVITE_GRANT: i32 = 1000;

/// `admin_revoke_invite`: revokes any pending invite. Returns
/// `Outcome<Invite>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRevokeInviteArgs {
    pub id: String,
    pub staff: String,
}

// --- Private preview and the waitlist ---
//
// Whether anyone may make an account (`open`) or only someone with an
// invite (`invite`, g1t.sh's private preview) is a switch staff flip in
// sudo (`admin_set_registration`), kept in identity's database; until
// anyone has, identity's `REGISTRATION_MODE` var says, and unset is open,
// as a self-hosted g1t has it. Without an
// invite, people ask for access: one waitlist entry per address, which
// staff approve (an invite emailed to the address) or dismiss in sudo.
// Staff hear about new requests by email (`WAITLIST_NOTIFY_EMAIL`). See
// services/identity/src/waitlist.rs.

/// Whether anyone may make an account, or only someone with an invite.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    #[default]
    Open,
    Invite,
}

impl RegistrationMode {
    /// `invite` (any case, trimmed) is invite-only; anything else is open.
    pub fn parse(text: Option<&str>) -> RegistrationMode {
        match text.map(|text| text.trim().to_ascii_lowercase()).as_deref() {
            Some("invite") => RegistrationMode::Invite,
            _ => RegistrationMode::Open,
        }
    }
}

// `registration` takes `{}` and returns `RegistrationMode`.

/// Registration as staff see it: the mode in force, and who set it.
/// Returned by `admin_registration` (takes `{}`) and
/// `admin_set_registration`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSetting {
    pub mode: RegistrationMode,
    /// What `REGISTRATION_MODE` says: the mode while nobody has set one.
    pub default_mode: RegistrationMode,
    /// The staff member who set it; None while the default is in force.
    pub set_by: Option<String>,
    /// RFC 3339.
    pub set_at: Option<String>,
}

/// `admin_set_registration`: staff open registration or close it to
/// invites only, at once and without a deploy (the site asks again within
/// a minute). Recorded in sudo's audit log. Returns `RegistrationSetting`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSetRegistrationArgs {
    pub mode: RegistrationMode,
    /// The staff member, by email.
    pub staff: String,
}

/// `request_access`: someone without an invite asks for one. Kept on the
/// waitlist, one entry per address; asking again updates it. Answers the
/// same way whether or not the address is already on it, or has an
/// account. Returns `Outcome<bool>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RequestAccessArgs {
    pub email: String,
    /// What they will build, if they said.
    #[serde(default)]
    pub about: String,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
}

/// The most characters `RequestAccessArgs::about` keeps.
pub const MAX_WAITLIST_ABOUT: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitlistStatus {
    Waiting,
    Invited,
    Dismissed,
}

impl WaitlistStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WaitlistStatus::Waiting => "waiting",
            WaitlistStatus::Invited => "invited",
            WaitlistStatus::Dismissed => "dismissed",
        }
    }
}

/// Someone who asked for access.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistEntry {
    pub id: String,
    pub email: String,
    pub about: Option<String>,
    pub status: WaitlistStatus,
    pub invite_id: Option<String>,
    pub decided_by: Option<String>,
    /// RFC 3339.
    pub decided_at: Option<String>,
    /// What staff wrote when approving; it went in the invite email.
    #[serde(default)]
    pub note: Option<String>,
    /// The account made with the invite, once it was used.
    #[serde(default)]
    pub joined_as: Option<String>,
    /// When they first asked. RFC 3339.
    pub created_at: String,
    /// When they last asked. RFC 3339.
    pub updated_at: String,
}

/// `admin_waitlist`: the waitlist, oldest waiting first for `waiting`,
/// otherwise newest first, at most [`ADMIN_INVITES_LIMIT`]. Returns
/// `Vec<WaitlistEntry>`.
///
/// `admin_waitlist_pending` takes `{}` and returns the number of requests
/// still waiting, for sudo's navigation.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminWaitlistArgs {
    /// Part of an email address or of what they said.
    #[serde(default)]
    pub query: Option<String>,
    /// Null: every status.
    #[serde(default)]
    pub status: Option<WaitlistStatus>,
}

/// `admin_decide_waitlist`: approving makes an invite to g1t bound to the
/// address, charged to nobody, and emails it, with `note` if given;
/// dismissing only marks the entry, and tells nobody. Returns
/// `Outcome<WaitlistEntry>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminDecideWaitlistArgs {
    pub id: String,
    pub approve: bool,
    /// The staff member, by email.
    pub staff: String,
    /// A line for the invite email, up to [`MAX_WAITLIST_NOTE`] characters.
    #[serde(default)]
    pub note: Option<String>,
}

/// The most characters an approval's note keeps.
pub const MAX_WAITLIST_NOTE: usize = 500;

// --- Suspension and blocked email domains, staff only ---
//
// See services/identity/src/suspension.rs. A suspended account cannot sign
// in, and its sessions and tokens stop working at once; a suspended
// workspace's own tokens stop working, and sudo also puts a hold on its
// compute (billing), which stops its runs, deploys, new self-hosted
// runners and telemetry. Both are undone the same way. A blocked email
// domain makes no new accounts and confirms no new addresses.

/// Why and since when staff suspended an account or a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suspension {
    pub reason: String,
    /// RFC 3339.
    pub at: String,
    /// The staff member, by email.
    pub by: String,
}

/// `admin_suspend_user` (`name` a username) and `admin_suspend_workspace`
/// (`name` a slug): `suspend` true suspends with `reason` (required),
/// false lifts it. Returns `Outcome<Option<Suspension>>`: what stands now.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminSuspendArgs {
    pub name: String,
    pub suspend: bool,
    #[serde(default)]
    pub reason: String,
    pub staff: String,
}

/// An email domain no new account may sign up with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedDomain {
    /// Lowercased, such as `spam.example`. Its subdomains are blocked too.
    pub domain: String,
    pub reason: String,
    pub blocked_by: String,
    /// RFC 3339.
    pub created_at: String,
}

/// `admin_blocked_domains` takes `{}` and returns `Vec<BlockedDomain>`.
///
/// `admin_block_domain`: `block` true blocks `domain` with `reason`,
/// false unblocks it. Returns `Outcome<Vec<BlockedDomain>>`, the list now.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminBlockDomainArgs {
    pub domain: String,
    pub block: bool,
    #[serde(default)]
    pub reason: String,
    pub staff: String,
}

// --- Shared invite links ---
//
// Before registration opened, staff handed groups shared invite links.
// None are made or used any more; staff still see which one an account
// was made with.

/// The shared invite link an account was made with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedInviteSource {
    pub id: String,
    pub label: String,
}

#[cfg(test)]
mod deletion_tests {
    use super::{WorkspaceDeletion, protected_names};

    #[test]
    fn only_billing_or_protection_stands_in_the_way() {
        let clear = WorkspaceDeletion { repositories: 2, projects: 1, members: 3, ..WorkspaceDeletion::default() };
        assert!(!clear.blocked());
        assert_eq!(clear.reason("acme"), None);
        let owing = WorkspaceDeletion { billing: Some("Pay first.".into()), ..WorkspaceDeletion::default() };
        assert!(owing.blocked());
        assert_eq!(owing.reason("acme").as_deref(), Some("Pay first."));
        let protected = WorkspaceDeletion { billing: Some("Pay first.".into()), protected: true, ..WorkspaceDeletion::default() };
        assert!(protected.blocked());
        assert_eq!(protected.reason("flagon-io").as_deref(), Some("flagon-io is protected and can never be deleted."));
    }

    #[test]
    fn flagon_is_protected_whatever_the_variable_says() {
        assert_eq!(protected_names(None), ["flagon-io"]);
        assert_eq!(protected_names(Some("")), ["flagon-io"]);
        assert_eq!(protected_names(Some(" , ")), ["flagon-io"]);
        assert_eq!(protected_names(Some("Flagon-IO, acme ,wsp_1")), ["flagon-io", "acme", "wsp_1"]);
    }
}
