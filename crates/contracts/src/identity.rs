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
    /// Milliseconds since the epoch.
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessToken {
    pub id: String,
    pub name: String,
    pub created_at: u64,
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
