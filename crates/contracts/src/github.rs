//! GitHub: signing in with a GitHub account, and bringing repositories
//! across through g1t's GitHub App. Mirrors `packages/contracts/src/github.ts`.
//!
//! One GitHub App does both. Its user authorization (OAuth web flow, with
//! PKCE) signs people in and lets g1t list what they installed it on; its
//! installations give g1t access to the repositories they chose. The app
//! is optional: with none configured every method here says so, and the
//! site shows no GitHub buttons.
//!
//! The identity service (`POST /rpc/<method>`) keeps linked accounts and
//! their user tokens:
//!
//! - `github_enabled` (no arguments) returns `bool`.
//! - `github_start` takes `GithubStartArgs`, returns `Outcome<GithubStart>`.
//! - `github_finish` takes `GithubFinishArgs`, returns `Outcome<GithubFinished>`.
//! - `github_pending` takes `GithubPendingArgs`, returns `Outcome<GithubPending>`.
//! - `github_sign_up` takes `GithubSignUpArgs`, returns `Outcome<SignedIn>`.
//! - `github_claim` takes `GithubClaimArgs`, returns `Outcome<GithubAccount>`.
//! - `github_account` takes `UserArgs`, returns `GithubAccountView`.
//! - `github_unlink` takes `UserArgs`, returns `Outcome<bool>`.
//! - `github_user_token` takes `GithubUserTokenArgs`, returns `Outcome<String>`.
//! - `github_revoked` takes `GithubRevokedArgs`, returns `u32`.
//! - `github_usernames` takes `GithubUsernamesArgs`, returns a map.
//!
//! The integrations service keeps installations and linked repositories,
//! and receives the app's webhook at `https://api.g1t.sh/hooks/github`:
//!
//! - `github_status` takes `GithubStatusArgs`, returns `Outcome<GithubAppStatus>`.
//! - `github_add_installation` takes `GithubInstallationArgs`, returns
//!   `Outcome<GithubInstallation>`.
//! - `github_remove_installation` takes `GithubInstallationArgs`, returns
//!   `Outcome<bool>`.
//! - `github_visible_installations` takes `GithubVisibleArgs`, returns
//!   `Outcome<Vec<GithubVisibleInstallation>>`.
//! - `github_repositories` takes `GithubRepositoriesArgs`, returns
//!   `Outcome<GithubRepositories>`.
//! - `github_import` takes `GithubImportArgs`, returns `Outcome<GithubRepoLink>`.
//! - `github_link` takes `GithubLinkArgs`, returns `Option<GithubRepoLink>`.
//! - `github_unlink_repo` takes `GithubUnlinkRepoArgs`, returns `Outcome<bool>`.
//! - `github_sync` takes `GithubUnlinkRepoArgs`, returns `Outcome<GithubRepoLink>`.
//! - `github_receive` takes `GithubReceiveArgs`, returns `integrations::Received`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::User;
use crate::identity::SignedIn;

/// Why someone is sent to GitHub.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GithubPurpose {
    /// Sign in, or create an account.
    SignIn,
    /// Link GitHub to the signed-in account.
    Link,
}

impl GithubPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            GithubPurpose::SignIn => "sign_in",
            GithubPurpose::Link => "link",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStartArgs {
    pub purpose: GithubPurpose,
    /// The signed-in person, for `link`.
    #[serde(default)]
    pub user: Option<User>,
    /// Exactly the callback registered on the app, such as
    /// `https://g1t.sh/auth/github/callback`.
    pub redirect_uri: String,
    /// A same-site path to return to afterwards.
    #[serde(default)]
    pub next: String,
    /// An invite code, from `/register?invite=…`, carried through GitHub
    /// for a new account while g1t is invite-only.
    #[serde(default)]
    pub invite_code: Option<String>,
}

/// Where to send the browser, and the state to bind to it in a cookie.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStart {
    pub authorize_url: String,
    pub state: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubFinishArgs {
    pub state: String,
    pub code: String,
}

/// How a return from GitHub ended.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubFinished {
    /// Signed in to the account the GitHub account is linked to, or to a
    /// new one made with it.
    SignedIn {
        #[serde(rename = "signedIn")]
        signed_in: SignedIn,
        created: bool,
        next: String,
    },
    /// Linked to the account that asked.
    Linked { login: String, next: String },
    /// An account with one of its verified emails exists: the person signs
    /// in to it, and `github_claim` then links it.
    NeedsLink { pending: String, login: String, next: String },
    /// A new account, but the GitHub login cannot be its username.
    /// A new account, but the GitHub login cannot be its username, or g1t
    /// is invite-only and no invite code came with the sign-in.
    NeedsUsername {
        pending: String,
        login: String,
        suggestion: String,
        next: String,
        #[serde(rename = "inviteRequired")]
        invite_required: bool,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubPendingArgs {
    pub pending: String,
}

/// A GitHub sign-in waiting on a username or on signing in to link.
#[derive(Debug, Serialize, Deserialize)]
pub struct GithubPending {
    pub login: String,
    /// `link` or `username`.
    pub kind: String,
    pub suggestion: Option<String>,
    pub next: String,
    /// Whether the person must give an invite code to create the account.
    #[serde(rename = "inviteRequired", default)]
    pub invite_required: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubSignUpArgs {
    pub pending: String,
    pub username: String,
    /// Needed while g1t is invite-only, unless one came with the sign-in.
    #[serde(rename = "inviteCode", default)]
    pub invite_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubClaimArgs {
    pub pending: String,
    pub user: User,
}

/// A linked GitHub account. The numeric id is what identifies it; the
/// login is for showing, and is refreshed at each sign-in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub github_id: u64,
    pub login: String,
    /// RFC 3339.
    pub linked_at: String,
    /// Whether g1t holds a working user token, needed to list installations.
    pub authorized: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountView {
    /// Whether this g1t has a GitHub App configured for sign-in.
    pub enabled: bool,
    pub account: Option<GithubAccount>,
    /// Whether the account has a password, so GitHub is not its only way in.
    pub has_password: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUserTokenArgs {
    pub user_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRevokedArgs {
    pub github_id: u64,
}

/// `github_usernames`: the g1t usernames of linked GitHub accounts. Returns
/// a map from GitHub id, as a string, to username.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUsernamesArgs {
    pub github_ids: Vec<u64>,
}

// --- The app's installations and repositories (integrations) -------------

/// How a GitHub repository comes to g1t.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GithubMode {
    /// Copied once. The g1t repository is then its own.
    Import,
    /// g1t follows GitHub: every push there is fetched here.
    Mirror,
    /// GitHub follows g1t: every push here is pushed there.
    Push,
}

impl GithubMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GithubMode::Import => "import",
            GithubMode::Mirror => "mirror",
            GithubMode::Push => "push",
        }
    }

    pub fn parse(text: &str) -> GithubMode {
        match text {
            "mirror" => GithubMode::Mirror,
            "push" => GithubMode::Push,
            _ => GithubMode::Import,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallation {
    pub id: u64,
    pub workspace: String,
    /// The GitHub user or organization it is installed on.
    pub account: String,
    /// `User` or `Organization`.
    pub account_type: String,
    /// `all` or `selected` repositories.
    pub repository_selection: String,
    pub suspended: bool,
    /// Where to change which repositories it can see.
    pub settings_url: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatusArgs {
    pub viewer: User,
    pub workspace: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppStatus {
    /// Whether this g1t has a GitHub App configured for repositories.
    pub configured: bool,
    /// `https://github.com/apps/<slug>/installations/new`.
    pub install_url: Option<String>,
    /// Whether the viewer has linked GitHub with a working user token.
    pub linked: bool,
    pub installations: Vec<GithubInstallation>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallationArgs {
    pub actor: User,
    pub workspace: String,
    pub installation_id: u64,
}

/// `github_visible_installations`: the app's installations the person's
/// own GitHub account can see, for claiming one that was installed on
/// GitHub directly rather than from g1t.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubVisibleArgs {
    pub actor: User,
}

/// An installation of the app, as the person's GitHub account sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubVisibleInstallation {
    pub id: u64,
    /// The GitHub user or organization it is installed on.
    pub account: String,
    /// `User` or `Organization`.
    pub account_type: String,
    /// `all` or `selected` repositories.
    pub repository_selection: String,
    pub suspended: bool,
    pub settings_url: String,
    /// The person's workspaces it is recorded in already.
    pub recorded_in: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoriesArgs {
    pub actor: User,
    pub workspace: String,
    pub installation_id: u64,
    #[serde(default)]
    pub page: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub id: u64,
    /// `owner/name`.
    pub full_name: String,
    pub name: String,
    pub private: bool,
    pub description: Option<String>,
    pub default_branch: String,
    /// The g1t repository already linked to it, as `workspace/name`.
    pub linked_to: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositories {
    pub repositories: Vec<GithubRepository>,
    pub total: u32,
    pub page: u32,
    pub per_page: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubImportArgs {
    pub actor: User,
    pub workspace: String,
    pub installation_id: u64,
    pub github_repo_id: u64,
    /// The g1t repository's name; the GitHub one's when left out.
    #[serde(default)]
    pub name: Option<String>,
    pub mode: GithubMode,
    /// Private on g1t; as on GitHub when left out.
    #[serde(default)]
    pub private: Option<bool>,
    /// Also copy issues, with their labels, milestone and state.
    #[serde(default)]
    pub issues: bool,
}

/// A g1t repository's tie to a GitHub repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoLink {
    pub repo_id: String,
    /// `workspace/name` on g1t.
    pub repo: String,
    pub installation_id: u64,
    pub github_repo_id: u64,
    /// `owner/name` on GitHub.
    pub full_name: String,
    pub mode: GithubMode,
    /// RFC 3339; the last time refs were copied either way.
    pub synced_at: Option<String>,
    pub last_error: Option<String>,
    /// Issues copied so far, when they were asked for.
    pub issues_imported: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubLinkArgs {
    pub repo_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUnlinkRepoArgs {
    pub actor: User,
    pub repo_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubReceiveArgs {
    /// Header names in lowercase.
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_visible_installation_reads_as_the_site_expects() {
        let item = GithubVisibleInstallation {
            id: 7,
            account: "flagon-io".into(),
            account_type: "Organization".into(),
            repository_selection: "all".into(),
            suspended: false,
            settings_url: "https://github.com/organizations/flagon-io/settings/installations/7".into(),
            recorded_in: vec!["flagon-io".into()],
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["accountType"], "Organization");
        assert_eq!(json["repositorySelection"], "all");
        assert_eq!(json["recordedIn"][0], "flagon-io");
        assert_eq!(serde_json::from_value::<GithubVisibleInstallation>(json).unwrap(), item);
    }
}
