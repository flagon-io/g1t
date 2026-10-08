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
    /// Its scopes, as `resource:level`. Null: full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// Made before tokens had scopes: full access until someone narrows it.
    #[serde(default)]
    pub legacy: bool,
    /// RFC 3339. Null: it does not expire.
    #[serde(default)]
    pub expires_at: Option<String>,
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
/// not know are left out. Also `accounts`: the accounts behind user ids,
/// each with its username and avatar (`HashMap<String, accounts::EmailOwner>`).
#[derive(Debug, Serialize, Deserialize)]
pub struct UsernamesArgs {
    pub ids: Vec<String>,
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
}

/// `revoke_job_tokens`: ends a workflow job's tokens at once, when the job
/// finishes or is cancelled. Only job tokens are touched. Returns `bool`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeJobTokensArgs {
    pub job_id: String,
}

/// `update_access_token`: changes what one of a person's tokens may do.
/// The token itself is unchanged. Returns `Outcome<AccessToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAccessTokenArgs {
    pub user: User,
    pub id: String,
    /// Null: full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
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
/// While registration is invite-only (`REGISTRATION_MODE=invite`), every
/// new account needs `invite_code`: an unused, unexpired invite, and, when
/// the invite names an email, that address. See [`CreateInviteArgs`].
#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterArgs {
    pub username: String,
    pub email: String,
    pub password: String,
    /// An invite code such as `g1t-k7m2-q9xd-4hpw-…`. Ignored while
    /// registration is open.
    #[serde(default)]
    pub invite_code: Option<String>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub username: String,
    pub role: crate::Role,
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
    /// The username of the owner who deleted it.
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

/// `create_workspace_token`: owners only. The token belongs to the
/// workspace, acts as it, and keeps working when the member who made it
/// leaves. Returns `Outcome<CreatedAccessToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateWorkspaceTokenArgs {
    pub actor: User,
    pub slug: String,
    pub name: String,
    /// Its scopes; null for full access.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// When set, the token stops working after this many seconds. It is
    /// listed with the workspace's tokens either way. Null: no expiry.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
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


/// What an agent's token may do: these operations, in this repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentScope {
    pub repo: crate::repos::RepoPath,
    /// API and MCP operation names, such as `create_issue`.
    pub operations: Vec<String>,
    /// Set on a run credential: the run it belongs to, and what it may do
    /// with git. See [`crate::credentials`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<crate::credentials::RunBinding>,
}

/// `create_agent_token`: a token for a g1t agent working on someone's
/// behalf. It acts as `g1t`, a member of the repository's workspace,
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

/// The id g1t's agent acts under. Only ever stored, never shown: it keeps
/// the agent's work apart from g1t's own ([`crate::system::ID`]) where
/// that matters, such as whether its approval counts.
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

/// What anyone may see about a person.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub username: String,
    /// The name they go by, if they gave one.
    pub name: Option<String>,
    /// One or two lines about them, at most [`MAX_PROFILE_BIO`] characters.
    pub bio: Option<String>,
    pub location: Option<String>,
    /// An `https://` address.
    pub website: Option<String>,
    pub pronouns: Option<String>,
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
// While registration is invite-only, every new account (with a password or
// through GitHub) needs an invite code. Each person may have
// `INVITES_PER_USER` invites out at a time; staff grant more to a person or
// to a workspace, whose owners share them. Inviting an email with no
// account into a workspace makes an invite bound to that address, which
// registers and joins in one step. See services/identity/src/invites.rs.

/// Whether anyone may make an account, or only someone with an invite. Set
/// by identity's `REGISTRATION_MODE` var; anything but `open`, including
/// leaving it unset, is `invite`, so a missing setting never opens sign-up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    #[default]
    Invite,
    Open,
}

impl RegistrationMode {
    pub fn parse(text: Option<&str>) -> RegistrationMode {
        match text.map(|text| text.trim().to_ascii_lowercase()).as_deref() {
            Some("open") => RegistrationMode::Open,
            _ => RegistrationMode::Invite,
        }
    }
}

/// How many invites a person may have out at once, unless identity's
/// `INVITES_PER_USER` var says otherwise.
pub const INVITES_PER_USER: u32 = 5;

/// How long an invite works, unless identity's `INVITE_TTL_DAYS` var says
/// otherwise.
pub const INVITE_TTL_DAYS: u64 = 30;

/// Where an invite stands. Only a pending invite can be used or revoked.
/// An expired or revoked invite that was never used gives its inviter the
/// invite back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Pending,
    Redeemed,
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

/// Whose allowance an invite uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteCharge {
    /// Its inviter's own.
    User,
    /// The workspace's, granted by staff and shared by its owners.
    Workspace,
    /// Nobody's: staff minted it, or it invites an existing account.
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
    /// The staff member who minted it. Only in staff views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staff: Option<String>,
}

/// How many invites someone may have out, and how many they have.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowance {
    /// Null: no limit.
    pub limit: Option<u32>,
    /// Pending and used invites; revoked and expired ones are not counted.
    pub used: u32,
    /// Null: no limit.
    pub remaining: Option<u32>,
}

impl Allowance {
    pub fn new(limit: Option<u32>, used: u32) -> Allowance {
        Allowance {
            limit,
            used,
            remaining: limit.map(|limit| limit.saturating_sub(used)),
        }
    }

    pub fn exhausted(&self) -> bool {
        self.remaining == Some(0)
    }
}

/// A workspace's shared invites, for one of its owners.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceAllowance {
    pub slug: String,
    pub allowance: Allowance,
}

/// `list_invites` (takes `UserArgs`): a person's invites, newest first,
/// and what they have left. Returns `InvitesOverview`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvitesOverview {
    pub mode: RegistrationMode,
    pub allowance: Allowance,
    /// Workspaces the person owns that staff granted invites to.
    pub workspaces: Vec<WorkspaceAllowance>,
    pub invites: Vec<Invite>,
}

/// `create_invite`: a person makes an invite, optionally for one email
/// address. People only; never an agent or a workspace's token, and not
/// before their email is confirmed. Uses one of the person's invites, or,
/// with `workspace`, one of the invites staff granted that workspace (its
/// owners only). Emails the address when one is given. Returns
/// `Outcome<Invite>`, with the code.
///
/// `revoke_invite` (takes `RemoveArgs`): its maker revokes a pending
/// invite; a workspace's owners may revoke one made for the workspace.
/// The invite comes back to whoever it was charged to. Returns
/// `Outcome<Invite>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateInviteArgs {
    pub user: User,
    #[serde(default)]
    pub email: Option<String>,
    /// Use this workspace's granted invites, by slug.
    #[serde(default)]
    pub workspace: Option<String>,
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
/// invite registers and joins in one step, and uses one of the workspace's
/// granted invites or else one of the owner's own. With one, it costs
/// nothing. Returns `Outcome<Invite>`, with the code.
#[derive(Debug, Serialize, Deserialize)]
pub struct InviteMemberArgs {
    pub actor: User,
    pub slug: String,
    pub email: String,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `workspace_invites` (takes `ListMembersArgs`): a workspace's invites,
/// newest first. Owners only. Returns `Outcome<Vec<Invite>>`.
///
/// `revoke_workspace_invite`: owners only. Returns `Outcome<Invite>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceInviteArgs {
    pub actor: User,
    pub slug: String,
    pub id: String,
}

/// `request_access`: someone without an invite asks for one. Kept on the
/// waitlist, one entry per address. Answers the same way whether or not
/// the address is already on it. Returns `Outcome<bool>`.
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

// `registration` takes `{}` and returns `RegistrationMode`.

// --- Invites, staff only ---

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

/// `admin_waitlist`: the waitlist, newest first, at most
/// [`ADMIN_INVITES_LIMIT`]. Returns `Vec<WaitlistEntry>`.
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

/// The most rows one staff listing of invites or the waitlist returns.
pub const ADMIN_INVITES_LIMIT: usize = 500;

/// `admin_decide_waitlist`: approving mints an invite bound to the
/// address, charged to nobody, and emails it, with `note` if given;
/// dismissing only marks the entry. Returns `Outcome<WaitlistEntry>`.
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

/// `admin_invites`: every invite, newest first, at most
/// [`ADMIN_INVITES_LIMIT`], optionally only those whose code starts with
/// `query`, or whose email, inviter or redeemer contains it. Returns
/// `Vec<Invite>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminInvitesArgs {
    #[serde(default)]
    pub query: Option<String>,
}

/// `admin_revoke_invite`: revokes any pending invite. Returns
/// `Outcome<Invite>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRevokeInviteArgs {
    pub id: String,
    pub staff: String,
}

/// `admin_mint_invite`: staff make an invite that uses nobody's
/// allowance, optionally bound to (and emailed to) an address. Returns
/// `Outcome<Invite>`, with the code.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminMintInviteArgs {
    #[serde(default)]
    pub email: Option<String>,
    pub staff: String,
}

/// Who staff grant invites to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantTarget {
    User,
    Workspace,
}

impl GrantTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantTarget::User => "user",
            GrantTarget::Workspace => "workspace",
        }
    }
}

/// `admin_grant_invites`: gives a person (by username) or a workspace (by
/// slug) `amount` more invites; a negative amount takes some back. Returns
/// `Outcome<Allowance>`: theirs afterwards.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminGrantInvitesArgs {
    pub target: GrantTarget,
    pub name: String,
    pub amount: i32,
    #[serde(default)]
    pub note: String,
    pub staff: String,
}

/// The most invites one grant gives or takes back.
pub const MAX_INVITE_GRANT: i32 = 1000;

/// Invites staff granted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteGrant {
    pub amount: i32,
    pub note: Option<String>,
    pub granted_by: String,
    /// RFC 3339.
    pub created_at: String,
}

/// Someone a person invited, and whom they invited in turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteTreeNode {
    pub username: String,
    /// When they used the invite. RFC 3339.
    pub joined_at: String,
    pub invited: Vec<InviteTreeNode>,
}

/// `admin_invite_tree` (takes `UsernameArgs`): where a person came from
/// and whom they brought, for tracing abuse. Returns `Option<InviteTree>`.
///
/// `admin_workspace_invites` (takes `SlugArgs`): a workspace's granted
/// invites, grants and invites. Returns `Option<InviteTree>` with
/// `username` the slug and no `invited_by`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteTree {
    pub username: String,
    /// Who invited them, then who invited that person, and so on. Empty
    /// for an account made without an invite.
    pub invited_by: Vec<String>,
    /// The staff member who minted their invite, when staff did.
    pub staff: Option<String>,
    pub allowance: Allowance,
    pub grants: Vec<InviteGrant>,
    /// Their invites, newest first.
    pub invites: Vec<Invite>,
    /// Whom they invited, three levels down.
    pub invited: Vec<InviteTreeNode>,
}

#[cfg(test)]
mod deletion_tests {
    use super::{WorkspaceDeletion, protected_names};

    #[test]
    fn only_billing_or_protection_stands_in_the_way() {
        let clear = WorkspaceDeletion {
            repositories: 2,
            projects: 1,
            members: 3,
            ..WorkspaceDeletion::default()
        };
        assert!(!clear.blocked());
        assert_eq!(clear.reason("acme"), None);
        let owing = WorkspaceDeletion {
            billing: Some("Pay first.".into()),
            ..WorkspaceDeletion::default()
        };
        assert!(owing.blocked());
        assert_eq!(owing.reason("acme").as_deref(), Some("Pay first."));
        let protected = WorkspaceDeletion {
            billing: Some("Pay first.".into()),
            protected: true,
            ..WorkspaceDeletion::default()
        };
        assert!(protected.blocked());
        assert_eq!(
            protected.reason("flagon-io").as_deref(),
            Some("flagon-io is protected and can never be deleted.")
        );
    }

    #[test]
    fn flagon_is_protected_whatever_the_variable_says() {
        assert_eq!(protected_names(None), ["flagon-io"]);
        assert_eq!(protected_names(Some("")), ["flagon-io"]);
        assert_eq!(protected_names(Some(" , ")), ["flagon-io"]);
        assert_eq!(
            protected_names(Some("Flagon-IO, acme ,wsp_1")),
            ["flagon-io", "acme", "wsp_1"]
        );
    }
}
