//! The identity service: accounts, sessions, SSH keys and access tokens.
//!
//! Reached only through service bindings; see `g1t_contracts::identity` for
//! the methods and their arguments.

mod access;
mod account_deletion;
mod admin;
mod aliases;
mod avatars;
mod crypto;
mod deletion;
mod deploy_keys;
mod device;
mod directory;
mod dock;
mod email;
mod emails;
mod github;
mod invites;
mod members;
mod oauth;
mod paid;
mod people;
mod profiles;
mod rename;
mod job_tokens;
mod run_credentials;
mod security;
mod shared_invites;
mod teams;
mod throttle;
mod token_reach;
mod tokens;
mod two_factor;
mod workspaces;

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, claimable_username, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use tokens::TOKEN_PREFIX;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

const SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const RESET_TTL_SECONDS: u64 = 60 * 60;
const MIN_PASSWORD_LENGTH: usize = 10;
const PASSWORD_TOO_SHORT: &str = "Use a password of at least 10 characters.";

/// A user as selected from the database; `verified` arrives as 0 or 1.
/// What a username may be, as registration and GitHub sign-up say when one is refused.
pub(crate) const USERNAME_RULES: &str =
    "Usernames use letters of either case, digits and single hyphens, up to 39 characters, not starting or ending with a hyphen, and cannot be a reserved word.";

#[derive(Deserialize)]
struct Account {
    id: String,
    username: String,
    /// Selected where the person is shown: their username as they wrote it.
    #[serde(default)]
    display_username: Option<String>,
    verified: u8,
    /// Selected only where the person is being shown to themselves.
    #[serde(default)]
    avatar: Option<String>,
}

impl From<Account> for User {
    fn from(row: Account) -> Self {
        User {
            id: row.id,
            username: row.username,
            display_username: row.display_username,
            verified: row.verified != 0,
            avatar: row.avatar,
            ..User::default()
        }
    }
}

#[derive(Deserialize)]
struct UserRow {
    id: String,
    username: String,
    password_hash: String,
    verified: u8,
}

/// The owner of an emailed token.
#[derive(Deserialize)]
struct TokenOwner {
    id: String,
    username: String,
    /// The address a link was sent to; null on links from before accounts
    /// had several, which are for the primary.
    #[serde(default)]
    email_id: Option<String>,
}

#[derive(Deserialize)]
struct KeyRow {
    id: String,
    title: String,
    fingerprint: String,
    created_at: String,
    #[serde(default)]
    last_used_at: Option<String>,
}

impl From<KeyRow> for SshKey {
    fn from(row: KeyRow) -> Self {
        SshKey {
            id: row.id,
            title: row.title,
            fingerprint: row.fingerprint,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
        }
    }
}

struct Identity {
    db: D1Database,
    env: Env,
}

impl Identity {
    /// Runs a query that returns at most one user, for showing to others:
    /// without their workspaces.
    async fn find_public_user(&self, sql: &str, param: &str) -> Result<Viewer> {
        Ok(self
            .db
            .prepare(sql)
            .bind(&[JsValue::from(param)])?
            .first::<Account>(None)
            .await?
            .map(User::from))
    }

    /// Attaches the workspaces a user belongs to, so that any service can
    /// authorize them without asking again.
    async fn with_workspaces(&self, user: Viewer) -> Result<Viewer> {
        let Some(mut user) = user else {
            return Ok(None);
        };
        let memberships = self.memberships_and_policies(&user.id).await?;
        // Roles on single repositories, under the same policy (access.rs).
        let grants = self.grants_of(&user.id).await?;
        // Access to a workspace is used only within its policy; see security.rs.
        let within = self.within_policy(&user.id, memberships, grants).await?;
        user.workspaces = within.memberships;
        user.grants = within.grants;
        user.held = within.held;
        Ok(Some(user))
    }

    /// Runs a query that resolves credentials to at most one user.
    async fn find_user(&self, sql: &str, param: &str) -> Result<Viewer> {
        let user = self.find_public_user(sql, param).await?;
        self.with_workspaces(user).await
    }

    /// Consumes a token of `kind`, returning its owner if it was valid.
    async fn redeem_email_token(&self, token: &str, kind: &str) -> Result<Option<TokenOwner>> {
        let id = crypto::sha256_hex(token);
        let owner = self
            .db
            .prepare(format!(
                "SELECT users.id, users.username, email_tokens.email_id FROM email_tokens
                 JOIN users ON users.id = email_tokens.user_id
                 WHERE email_tokens.id = ? AND email_tokens.kind = ? AND users.deleted_at IS NULL
                   AND email_tokens.expires_at > {SQL_NOW}"
            ))
            .bind(&[id.as_str().into(), kind.into()])?
            .first::<TokenOwner>(None)
            .await?;
        if let Some(owner) = &owner {
            // Every outstanding token of this kind dies with the one used:
            // every reset link, and every confirmation link for the same
            // address (another address's links still work).
            self.db
                .prepare(
                    "DELETE FROM email_tokens WHERE user_id = ?1 AND kind = ?2
                       AND (?2 = 'reset' OR email_id IS ?3)",
                )
                .bind(&[
                    owner.id.as_str().into(),
                    kind.into(),
                    owner.email_id.as_deref().map_or(JsValue::NULL, Into::into),
                ])?
                .run()
                .await?;
        }
        Ok(owner)
    }

    async fn resend_verification(&self, a: UserArgs) -> Result<Outcome<bool>> {
        if !self.allow(throttle::CONFIRM_ACCOUNT, &a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Too many confirmation emails this hour. Check your inbox, or try again later."));
        }
        self.resend_primary(&a.user).await
    }

    /// The link in a confirmation email, followed: signed in or not. It
    /// ends the code sent with it (emails.rs).
    async fn verify_email(&self, a: EmailTokenArgs) -> Result<Outcome<g1t_contracts::accounts::EmailConfirmed>> {
        let Some(owner) = self.redeem_email_token(&a.token, "verify").await? else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "This confirmation link is not valid or has expired.",
            ));
        };
        self.confirm_address(&owner.id, owner.email_id.as_deref()).await
    }

    /// Any confirmed address of an account can ask for a reset; so can the
    /// unconfirmed address a new account signed up with. See emails.rs.
    async fn request_password_reset(&self, a: EmailArgs) -> Result<bool> {
        let allowed = self.allow(throttle::RESET_EMAIL, &a.email).await?
            && match a.client.as_deref() {
                Some(client) => self.allow(throttle::RESET_CLIENT, client).await?,
                None => true,
            };
        if allowed && let Some(target) = self.reset_target(&a.email).await? {
            // A failure from here on happens only for a real account, so it
            // is logged, never answered: the reply below stays the same.
            if let Err(error) = self.send_reset(&target).await {
                worker::console_error!("password reset for a known address failed: {error}");
            }
        }
        // The same answer either way, so addresses cannot be probed.
        Ok(true)
    }

    /// Saves a reset link for `target` and mails it, telling the account's
    /// other addresses.
    async fn send_reset(&self, target: &emails::ResetTarget) -> Result<()> {
        {
            let token = crypto::random_hex(32);
            self.db
                .prepare(format!(
                    "INSERT INTO email_tokens (id, user_id, kind, expires_at, email_id)
                     VALUES (?, ?, 'reset', {}, ?)",
                    sql_after(RESET_TTL_SECONDS)
                ))
                .bind(&[
                    crypto::sha256_hex(&token).into(),
                    target.user_id.as_str().into(),
                    target.email_id.as_str().into(),
                ])?
                .run()
                .await?;
            email::send_password_reset(&self.env, &target.display, &target.username, &token).await?;
            // The primary and the backup hear of it when it went elsewhere.
            let elsewhere = self.notice_recipients(&target.user_id, false).await?;
            for address in elsewhere.iter().filter(|address| !address.eq_ignore_ascii_case(&target.display)) {
                let change = format!("A password reset was asked for through {}", target.display);
                if let Err(error) = email::send_security_notice(&self.env, address, &target.username, &change).await {
                    worker::console_error!("security notice failed: {error}");
                }
            }
        }
        Ok(())
    }

    async fn reset_password(&self, a: ResetPasswordArgs) -> Result<Outcome<User>> {
        if a.password.chars().count() < MIN_PASSWORD_LENGTH {
            return Ok(Outcome::fail(FailureCode::Invalid, PASSWORD_TOO_SHORT));
        }
        let Some(owner) = self.redeem_email_token(&a.token, "reset").await? else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "This reset link is not valid or has expired.",
            ));
        };
        self.db
            .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
            .bind(&[
                crypto::hash_password(&a.password).into(),
                owner.id.as_str().into(),
            ])?
            .run()
            .await?;
        // Following an emailed link also proves the address it went to
        // (unless another account confirmed it first).
        let _ = self.confirm_address(&owner.id, owner.email_id.as_deref()).await?;
        // Anyone signed in with the old password is signed out, and nobody
        // stays locked out by the wrong guesses before it.
        self.db
            .prepare("DELETE FROM sessions WHERE user_id = ?")
            .bind(&[owner.id.as_str().into()])?
            .run()
            .await?;
        self.clear(&throttle::key(throttle::PASSWORD_ACCOUNT, &owner.id)).await?;
        self.log_security(&owner.id, "password_changed", None, None).await;
        self.tell_primary_and_backup(&owner.id, &owner.username, "Your password was changed").await;
        let verified = self
            .find_public_user(
                "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ?",
                &owner.id,
            )
            .await?
            .is_some_and(|user| user.verified);
        Ok(Outcome::Ok(User {
            id: owner.id,
            username: owner.username,
            verified,
            ..User::default()
        }))
    }

    /// The account a login names: a username, or any confirmed address.
    async fn password_row(&self, login: &str) -> Result<Option<UserRow>> {
        let login = login.trim().to_lowercase();
        let (column, value) = if login.contains('@') {
            match self.user_with_verified_email(&login).await? {
                Some(id) => ("id", id),
                None => return Ok(None),
            }
        } else {
            ("username", login)
        };
        self.db
            .prepare(format!(
                "SELECT id, username, password_hash, email_verified_at IS NOT NULL AS verified FROM users
                 WHERE {column} = ? AND deleted_at IS NULL"
            ))
            .bind(&[JsValue::from(value)])?
            .first::<UserRow>(None)
            .await
    }

    /// Checks a password for a login, throttled (see throttle.rs). The
    /// refusal is one of two messages, the same for every account.
    async fn checked_password(
        &self,
        login: &str,
        password: &str,
        client: Option<&str>,
    ) -> Result<std::result::Result<User, &'static str>> {
        let row = self.password_row(login).await?;
        let subject = row.as_ref().map_or_else(|| login.trim().to_lowercase(), |row| row.id.clone());
        let (account_key, client_key) = Identity::password_keys(&subject, client);
        if self.password_locked(&account_key, client_key.as_deref()).await? {
            return Ok(Err(throttle::THROTTLED));
        }
        let owner = row.as_ref().map(|row| (row.id.clone(), row.username.clone()));
        match row.filter(|row| !row.password_hash.is_empty() && crypto::verify_password(password, &row.password_hash)) {
            Some(row) => {
                self.clear(&account_key).await?;
                Ok(Ok(User {
                    id: row.id,
                    username: row.username,
                    verified: row.verified != 0,
                    ..User::default()
                }))
            }
            None => {
                let owner = owner.as_ref().map(|(id, name)| (id.as_str(), name.as_str()));
                self.password_failed(&account_key, client_key.as_deref(), owner).await?;
                Ok(Err("Incorrect username or password."))
            }
        }
    }

    /// Git over HTTPS with the account's password. With two-factor
    /// authentication on, a password alone is never enough: use an access
    /// token (two_factor.rs).
    async fn user_for_password(&self, login: &str, password: &str) -> Result<Viewer> {
        let user = self.checked_password(login, password, None).await?.ok();
        if let Some(user) = &user
            && self.two_factor_enabled(&user.id).await?
        {
            return Ok(None);
        }
        self.with_workspaces(user).await
    }

    async fn register(&self, a: RegisterArgs) -> Result<Outcome<SignedIn>> {
        // Kept as typed for showing; found, linked and mentioned lowercased.
        let chosen = claimable_username(&a.username);
        let username = chosen.as_ref().map_or_else(|| a.username.trim().to_lowercase(), |name| name.canonical.clone());
        let claimable = chosen.is_some();
        let email = a.email.trim().to_lowercase();
        let invalid = |message: &str| Ok(Outcome::fail(FailureCode::Invalid, message));
        let invite_code = a.invite_code.as_deref().map(str::trim).filter(|code| !code.is_empty());
        // The invite first: without one, nothing else on the form matters.
        if self.invites_required() && invite_code.is_none() {
            return Ok(Outcome::fail(FailureCode::Forbidden, invites::MISSING));
        }
        if !claimable {
            return invalid(USERNAME_RULES);
        }
        let well_formed_email = email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
            && !email.contains(char::is_whitespace);
        if !well_formed_email {
            return invalid("Enter a valid email address.");
        }
        if a.password.chars().count() < MIN_PASSWORD_LENGTH {
            return invalid(PASSWORD_TOO_SHORT);
        }
        let taken = self
            .db
            // Usernames and workspaces share one namespace, so that a name
            // means the same thing wherever it appears.
            // An address is taken once an account has confirmed it; an
            // unconfirmed one goes to whoever confirms it first (emails.rs).
            .prepare(
                "SELECT username FROM users WHERE username = ?
                 UNION ALL SELECT email FROM user_emails WHERE email = ? AND verified_at IS NOT NULL
                 UNION ALL SELECT slug FROM workspaces WHERE slug = ?",
            )
            .bind(&[
                username.as_str().into(),
                email.as_str().into(),
                username.as_str().into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        // A renamed workspace's old slug stays reserved for it a while, and
        // a deleted workspace's for good.
        if taken.is_some() || self.slug_held(&username).await? || self.slug_deleted(&username).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That username or email is already registered.",
            ));
        }
        let password_hash = crypto::hash_password(&a.password);
        let user = match self
            .create_account(invites::NewAccount {
                username: &username,
                display_username: chosen.as_ref().and_then(|name| name.display_if_cased()),
                email: &email,
                password_hash: &password_hash,
                verified: false,
                invite_code,
                email_proof: a.email_proof.as_deref(),
                client: a.client.as_deref(),
            })
            .await?
        {
            Outcome::Ok(user) => user,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // The account exists either way; the email can be sent again from
        // the confirmation page. It carries a code and a link (emails.rs).
        if !user.verified
            && let Err(error) = self.send_primary_confirmation(&user.id, &user.username).await
        {
            worker::console_error!("confirmation email failed: {error}");
        }
        self.start_session(user).await
    }

    async fn sign_in(&self, a: SignInArgs) -> Result<Outcome<SignedIn>> {
        let user = match self.checked_password(&a.username, &a.password, a.client.as_deref()).await? {
            Ok(user) => user,
            Err(message) => return Ok(Outcome::fail(FailureCode::Unauthenticated, message)),
        };
        let user = self.with_workspaces(Some(user)).await?.unwrap_or_default();
        self.start_session(user).await
    }

    /// Starts a session for someone who just proved their password (or
    /// GitHub account). With two-factor authentication on, it starts none:
    /// it returns a challenge for `two_factor_sign_in` (two_factor.rs).
    async fn start_session(&self, user: User) -> Result<Outcome<SignedIn>> {
        if self.two_factor_enabled(&user.id).await? {
            let challenge = self.issue_challenge(&user.id).await?;
            return Ok(Outcome::Ok(SignedIn {
                user: User { workspaces: Vec::new(), grants: Vec::new(), held: Vec::new(), ..user },
                session_token: String::new(),
                two_factor_challenge: Some(challenge),
            }));
        }
        self.session_for(user).await
    }

    /// A new session for `user`, who has proved who they are in full.
    async fn session_for(&self, user: User) -> Result<Outcome<SignedIn>> {
        // Whichever way it was proved, a deleted account starts none
        // (account_deletion.rs).
        if !self.account_live(&user.id).await? {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Incorrect username or password."));
        }
        let session_token = crypto::random_hex(32);
        self.db
            .prepare(format!(
                // Signing in is proof it is the person: see security.rs.
                "INSERT INTO sessions (id, user_id, expires_at, authenticated_at) VALUES (?, ?, {}, {SQL_NOW})",
                sql_after(SESSION_TTL_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&session_token).into(),
                user.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(SignedIn {
            user,
            session_token,
            two_factor_challenge: None,
        }))
    }

    async fn sign_out(&self, a: SessionArgs) -> Result<()> {
        self.db
            .prepare("DELETE FROM sessions WHERE id = ?")
            .bind(&[crypto::sha256_hex(&a.session_token).into()])?
            .run()
            .await?;
        Ok(())
    }

    async fn user_for_session(&self, a: SessionArgs) -> Result<Viewer> {
        self.find_user(
            &format!(
                "SELECT users.id, users.username, users.display_username, users.email_verified_at IS NOT NULL AS verified,
                   users.avatar
                 FROM sessions JOIN users ON users.id = sessions.user_id
                 WHERE sessions.id = ? AND sessions.expires_at > {SQL_NOW} AND users.deleted_at IS NULL"
            ),
            &crypto::sha256_hex(&a.session_token),
        )
        .await
    }

    async fn user_for_git_credentials(&self, a: GitCredentialsArgs) -> Result<Viewer> {
        // Like GitHub, a token alone identifies its user.
        if a.secret.starts_with(TOKEN_PREFIX) {
            self.user_for_access_token(&a.secret).await
        } else {
            self.user_for_password(&a.username, &a.secret).await
        }
    }

    async fn user_for_ssh_key(&self, a: FingerprintArgs) -> Result<Viewer> {
        self.find_user(
            "SELECT users.id, users.username, users.email_verified_at IS NOT NULL AS verified FROM ssh_keys
             JOIN users ON users.id = ssh_keys.user_id
             WHERE fingerprint = ? AND users.deleted_at IS NULL",
            &a.fingerprint,
        )
        .await
    }

    async fn user_by_username(&self, a: UsernameArgs) -> Result<Viewer> {
        self.find_public_user(
            // A deleted account is nobody's to find, mention or add.
            "SELECT id, username, display_username, email_verified_at IS NOT NULL AS verified FROM users WHERE username = ? AND deleted_at IS NULL",
            &a.username.to_lowercase(),
        )
        .await
    }

    /// `notify_by_email`: an inbox item, emailed to the person it is for,
    /// only at a confirmed address and only while they can still read the
    /// repository it is about. Returns whether it was sent.
    async fn notify_by_email(&self, a: g1t_contracts::inbox::NotifyByEmailArgs) -> Result<bool> {
        #[derive(Deserialize)]
        struct Address {
            email: Option<String>,
        }
        let user = self
            .find_user(
                "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE username = ? AND deleted_at IS NULL",
                &a.username.to_lowercase(),
            )
            .await?;
        let Some(user) = user.filter(|user| user.verified) else {
            return Ok(false);
        };
        let readable: Vec<g1t_contracts::repos::Repo> = g1t_kit::call(
            &self.env.service("REPOS")?,
            "readable",
            &g1t_contracts::repos::ReadableArgs {
                ids: vec![a.repo_id.clone()],
                viewer: Some(user.clone()),
            },
        )
        .await?;
        if readable.is_empty() {
            return Ok(false);
        }
        let address = self
            .db
            .prepare("SELECT email FROM users WHERE id = ?")
            .bind(&[user.id.as_str().into()])?
            .first::<Address>(None)
            .await?
            .and_then(|row| row.email)
            .filter(|email| !email.trim().is_empty());
        let Some(address) = address else {
            return Ok(false);
        };
        email::send_notification(&self.env, &address, &a).await?;
        Ok(true)
    }

    async fn usernames(&self, a: UsernamesArgs) -> Result<std::collections::HashMap<String, String>> {
        #[derive(serde::Deserialize)]
        struct Named {
            id: String,
            name: String,
        }
        let ids: Vec<String> = a.ids.into_iter().take(200).collect();
        let mut names = std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(names);
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let bind: Vec<worker::wasm_bindgen::JsValue> = ids.iter().map(|id| id.as_str().into()).collect();
        for sql in [
            format!("SELECT id, username AS name FROM users WHERE id IN ({marks})"),
            format!("SELECT id, slug AS name FROM workspaces WHERE id IN ({marks})"),
        ] {
            for row in self.db.prepare(sql).bind(&bind)?.all().await?.results::<Named>()? {
                names.insert(row.id, row.name);
            }
        }
        Ok(names)
    }

    /// `users_for_audience`: the people behind these ids (at most 50), each
    /// with their workspaces, roles, base permissions and repository
    /// grants, under each workspace's policy, as a signed-in viewer would
    /// have them. For the agents service, which answers only with what
    /// every person who will read the answer may see
    /// (docs.g1t.sh/guides/agent-access/, "What an agent can and can't
    /// know"). Ids of no live account are left out, so the caller can tell
    /// someone it could not resolve. Reached only by service binding.
    async fn users_for_audience(&self, a: UsernamesArgs) -> Result<Vec<User>> {
        let mut found = Vec::new();
        for id in a.ids.iter().take(50) {
            let user = self
                .find_user(
                    "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ? AND deleted_at IS NULL",
                    id,
                )
                .await?;
            if let Some(user) = user {
                found.push(user);
            }
        }
        Ok(found)
    }

    /// `accounts`: the accounts behind these ids (at most 200), each with
    /// its username and avatar, for lists that keep ids, such as who
    /// starred a repository. Ids of no account are left out.
    /// `display_usernames`: each lowercased username's chosen case, for the
    /// API, which shows it beside every username it answers with.
    async fn display_usernames(&self, a: DisplayUsernamesArgs) -> Result<std::collections::HashMap<String, String>> {
        #[derive(serde::Deserialize)]
        struct Row {
            username: String,
            display_username: String,
        }
        let mut names: Vec<String> = a.usernames.iter().map(|name| name.trim().to_lowercase()).filter(|name| !name.is_empty()).collect();
        names.sort();
        names.dedup();
        names.truncate(200);
        let mut found = std::collections::HashMap::new();
        if names.is_empty() {
            return Ok(found);
        }
        let marks = vec!["?"; names.len()].join(", ");
        let bind: Vec<worker::wasm_bindgen::JsValue> = names.iter().map(|name| name.as_str().into()).collect();
        let rows = self
            .db
            .prepare(format!(
                "SELECT username, display_username FROM users WHERE username IN ({marks}) AND display_username IS NOT NULL AND deleted_at IS NULL"
            ))
            .bind(&bind)?
            .all()
            .await?
            .results::<Row>()?;
        for row in rows {
            if row.display_username.eq_ignore_ascii_case(&row.username) && row.display_username != row.username {
                found.insert(row.username, row.display_username);
            }
        }
        Ok(found)
    }

    async fn accounts(&self, a: UsernamesArgs) -> Result<std::collections::HashMap<String, g1t_contracts::accounts::EmailOwner>> {
        #[derive(serde::Deserialize)]
        struct Row {
            id: String,
            username: String,
            avatar: Option<String>,
        }
        let ids: Vec<String> = a.ids.into_iter().take(200).collect();
        let mut found = std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(found);
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let bind: Vec<worker::wasm_bindgen::JsValue> = ids.iter().map(|id| id.as_str().into()).collect();
        let rows = self
            .db
            .prepare(format!("SELECT id, username, avatar FROM users WHERE id IN ({marks})"))
            .bind(&bind)?
            .all()
            .await?
            .results::<Row>()?;
        for row in rows {
            found.insert(row.id.clone(), g1t_contracts::accounts::EmailOwner { id: row.id, username: row.username, avatar: row.avatar });
        }
        Ok(found)
    }

    async fn list_ssh_keys(&self, a: UserArgs) -> Result<Vec<SshKey>> {
        let rows = self
            .db
            .prepare("SELECT id, title, fingerprint, created_at, last_used_at FROM ssh_keys WHERE user_id = ? ORDER BY id")
            .bind(&[a.user.id.into()])?
            .all()
            .await?
            .results::<KeyRow>()?;
        Ok(rows.into_iter().map(SshKey::from).collect())
    }

    /// The account (user id) that registered each key, by fingerprint
    /// (`SHA256:…`). At most 100; unknown keys are left out.
    async fn ssh_key_owners(&self, a: SshKeyOwnersArgs) -> Result<std::collections::HashMap<String, String>> {
        #[derive(serde::Deserialize)]
        struct Row {
            fingerprint: String,
            user_id: String,
        }
        let fingerprints: Vec<&String> = a.fingerprints.iter().take(100).collect();
        if fingerprints.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let marks = vec!["?"; fingerprints.len()].join(", ");
        let binds: Vec<JsValue> = fingerprints.iter().map(|fingerprint| fingerprint.as_str().into()).collect();
        Ok(self
            .db
            .prepare(format!("SELECT fingerprint, user_id FROM ssh_keys WHERE fingerprint IN ({marks})"))
            .bind(&binds)?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| (row.fingerprint, row.user_id))
            .collect())
    }

    async fn add_ssh_key(&self, a: AddSshKeyArgs) -> Result<Outcome<SshKey>> {
        let Some(key) = crypto::parse_ssh_key(&a.public_key) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "That is not a valid OpenSSH public key.",
            ));
        };
        // Someone's SSH key, or a repository's deploy key (deploy_keys.rs).
        if self.key_in_use(&key.fingerprint).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, g1t_contracts::deploy_keys::KEY_IN_USE));
        }
        let now = now_ms();
        let title = [a.title.trim(), key.comment.as_str(), "SSH key"]
            .into_iter()
            .find(|candidate| !candidate.is_empty())
            .unwrap_or_default()
            .to_owned();
        let row = KeyRow {
            id: new_id("key", now),
            title,
            fingerprint: key.fingerprint,
            created_at: rfc3339(now),
            last_used_at: None,
        };
        let inserted = self.db
            .prepare(
                "INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                row.id.as_str().into(),
                a.user.id.as_str().into(),
                row.title.as_str().into(),
                key.public_key.into(),
                row.fingerprint.as_str().into(),
                row.created_at.as_str().into(),
            ])?
            .run()
            .await;
        // Added at the same moment elsewhere: the trigger or the unique
        // index refused it.
        if let Err(error) = inserted {
            if self.key_in_use(&row.fingerprint).await? {
                return Ok(Outcome::fail(FailureCode::Conflict, g1t_contracts::deploy_keys::KEY_IN_USE));
            }
            return Err(error);
        }
        let shown = format!("{} ({})", row.title, row.fingerprint);
        self.log_security(&a.user.id, "ssh_key_added", Some(&shown), None).await;
        self.audit_account(&a.user, "ssh_key.added", &format!("Added SSH key {shown}")).await;
        Ok(Outcome::Ok(row.into()))
    }

    /// Deletes one of the person's SSH keys.
    async fn remove_ssh_key(&self, a: RemoveArgs) -> Result<()> {
        #[derive(Deserialize)]
        struct Removed {
            title: String,
            fingerprint: String,
        }
        let removed = self
            .db
            .prepare("DELETE FROM ssh_keys WHERE id = ? AND user_id = ? RETURNING title, fingerprint")
            .bind(&[a.id.as_str().into(), a.user.id.as_str().into()])?
            .first::<Removed>(None)
            .await?;
        if let Some(removed) = removed {
            let shown = format!("{} ({})", removed.title, removed.fingerprint);
            self.log_security(&a.user.id, "ssh_key_removed", Some(&shown), None).await;
            self.audit_account(&a.user, "ssh_key.removed", &format!("Removed SSH key {shown}")).await;
        }
        Ok(())
    }
}

/// Every 15 minutes: staff hear about waitlist requests that arrived while
/// the last summary's window was still open, so none waits on a later one;
/// and deleted workspaces and accounts past their restore window are purged
/// (deletion.rs, account_deletion.rs).
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let Ok(db) = env.d1("DB") else { return };
    let identity = Identity { db, env };
    if let Err(error) = identity.notify_staff_of_requests().await {
        worker::console_error!("waitlist summary: {error}");
    }
    if let Err(error) = identity.purge_due_workspaces().await {
        worker::console_error!("workspace purge: {error}");
    }
    // And deleted accounts past theirs (account_deletion.rs).
    if let Err(error) = identity.purge_due_accounts().await {
        worker::console_error!("account purge: {error}");
    }
    // Once: creators of repositories made before they got Admin (members.rs).
    if let Err(error) = identity.backfill_creator_grants().await {
        worker::console_error!("creator grants: {error}");
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs).
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    let body: serde_json::Value = request.json().await?;
    let identity = Identity { db, env };

    let answered = match method.as_str() {
        "register" => {
            let outcome = identity.register(args(body)?).await?;
            if let Outcome::Ok(signed_in) = &outcome {
                identity.announce_user(&signed_in.user.username, Some(&signed_in.user.id)).await;
            }
            reply(&outcome)
        }
        "sign_in" => reply(&identity.sign_in(args(body)?).await?),
        "create_workspace" => {
            let outcome = identity.create_workspace(args(body)?).await?;
            if let Outcome::Ok(workspace) = &outcome {
                identity.announce_workspace(&workspace.id, &workspace.slug, None).await;
            }
            reply(&outcome)
        }
        "get_workspace" => reply(&identity.get_workspace(args(body)?).await?),
        "list_members" => reply(&identity.list_members(args(body)?).await?),
        "add_member" => reply(&identity.add_member(args(body)?).await?),
        "remove_member" => reply(&identity.remove_member(args(body)?).await?),
        // Owners, roles, leaving and member privileges; see members.rs.
        "update_member" => reply(&identity.update_member(args(body)?).await?),
        "transfer_ownership" => reply(&identity.transfer_ownership(args(body)?).await?),
        "leave_workspace" => reply(&identity.leave_workspace(args(body)?).await?),
        "set_member_privileges" => reply(&identity.set_member_privileges(args(body)?).await?),
        "set_two_factor_requirement" => reply(&identity.set_two_factor_requirement(args(body)?).await?),
        "grant_creator" => reply(&identity.grant_creator(args(body)?).await?),
        "update_workspace" => {
            let outcome = identity.update_workspace(args(body)?).await?;
            if let Outcome::Ok(workspace) = &outcome {
                identity.announce_workspace(&workspace.id, &workspace.slug, None).await;
            }
            reply(&outcome)
        }
        "rename_workspace" => reply(&identity.rename_workspace(args(body)?).await?),
        "check_workspace_rename" => reply(&identity.check_workspace_rename(args(body)?).await?),
        "resolve_slug" => reply(&identity.resolve_slug(args(body)?).await?),
        "resolve_alias" => reply(&identity.resolve_alias(args(body)?).await?),
        "check_workspace_deletion" => reply(&identity.check_workspace_deletion(args(body)?).await?),
        "delete_workspace" => reply(&identity.delete_workspace(args(body)?).await?),
        "transfer_repo_scopes" => reply(&identity.transfer_repo_scopes(args(body)?).await?),
        "set_workspace_avatar" => {
            let outcome = identity.set_workspace_avatar(args(body)?).await?;
            if let Outcome::Ok(workspace) = &outcome {
                identity.announce_workspace(&workspace.id, &workspace.slug, None).await;
            }
            reply(&outcome)
        }
        "set_user_avatar" => {
            let a: SetUserAvatarArgs = args(body)?;
            let (username, id) = (a.user.username.clone(), a.user.id.clone());
            let outcome = identity.set_user_avatar(a).await?;
            if matches!(outcome, Outcome::Ok(_)) {
                identity.announce_user(&username, Some(&id)).await;
            }
            reply(&outcome)
        }
        "list_workspace_tokens" => reply(&identity.list_workspace_tokens(args(body)?).await?),
        "remove_workspace_token" => reply(&identity.remove_workspace_token(args(body)?).await?),
        // Signing in with GitHub; see github.rs.
        "github_enabled" => reply(&identity.github_enabled()),
        "github_start" => reply(&identity.github_start(args(body)?).await?),
        "github_finish" => reply(&identity.github_finish(args(body)?).await?),
        "github_pending" => reply(&identity.github_pending(args(body)?).await?),
        "github_sign_up" => reply(&identity.github_sign_up(args(body)?).await?),
        "github_claim" => reply(&identity.github_claim(args(body)?).await?),
        "github_account" => reply(&identity.github_account(args(body)?).await?),
        "github_unlink" => reply(&identity.github_unlink(args(body)?).await?),
        "github_user_token" => reply(&identity.github_user_token(args(body)?).await?),
        "github_revoked" => reply(&identity.github_revoked(args(body)?).await?),
        "github_usernames" => reply(&identity.github_usernames(args(body)?).await?),
        "oauth_authorize" => reply(&identity.oauth_authorize(args(body)?).await?),
        "oauth_exchange" => reply(&identity.oauth_exchange(args(body)?).await?),
        "oauth_refresh" => reply(&identity.oauth_refresh(args(body)?).await?),
        "list_oauth_grants" => reply(&identity.list_oauth_grants(args(body)?).await?),
        "revoke_oauth_grant" => reply(&identity.revoke_oauth_grant(args(body)?).await?),
        "update_oauth_grant" => reply(&identity.update_oauth_grant(args(body)?).await?),
        "device_start" => reply(&identity.device_start(args(body)?).await?),
        "device_lookup" => reply(&identity.device_lookup(args(body)?).await?),
        "device_resolve" => reply(&identity.device_resolve(args(body)?).await?),
        "device_claim" => reply(&identity.device_claim(args(body)?).await?),
        "resend_verification" => reply(&identity.resend_verification(args(body)?).await?),
        "verify_email" => reply(&identity.verify_email(args(body)?).await?),
        "confirm_email_code" => reply(&identity.confirm_email_code(args(body)?).await?),
        "change_pending_email" => reply(&identity.change_pending_email(args(body)?).await?),
        "request_password_reset" => reply(&identity.request_password_reset(args(body)?).await?),
        "reset_password" => reply(&identity.reset_password(args(body)?).await?),
        // A person's email addresses; see emails.rs and security.rs.
        "list_emails" => reply(&identity.list_emails(args(body)?).await?),
        "add_email" => reply(&identity.add_email(args(body)?).await?),
        "remove_email" => reply(&identity.remove_email(args(body)?).await?),
        "resend_email_verification" => reply(&identity.resend_email_verification(args(body)?).await?),
        "update_email_settings" => reply(&identity.update_email_settings(args(body)?).await?),
        "reauthenticate" => reply(&identity.reauthenticate(args(body)?).await?),
        // Two-factor authentication; see two_factor.rs.
        "two_factor_status" => reply(&identity.two_factor_status(args(body)?).await?),
        "two_factor_start" => reply(&identity.two_factor_start(args(body)?).await?),
        "two_factor_enable" => reply(&identity.two_factor_enable(args(body)?).await?),
        "two_factor_disable" => reply(&identity.two_factor_disable(args(body)?).await?),
        "two_factor_recovery_codes" => reply(&identity.two_factor_recovery_codes(args(body)?).await?),
        "two_factor_sign_in" => reply(&identity.two_factor_sign_in(args(body)?).await?),
        "security_log" => reply(&identity.security_log(args(body)?).await?),
        "email_owners" => reply(&identity.email_owners(args(body)?).await?),
        "commit_identity" => reply(&identity.commit_identity(args(body)?).await?),
        "push_email_guard" => reply(&identity.push_email_guard(args(body)?).await?),
        "admin_user" => reply(&identity.admin_user(args(body)?).await?),
        "admin_remove_email" => reply(&identity.admin_remove_email(args(body)?).await?),
        "sign_out" => reply(&identity.sign_out(args(body)?).await?),
        "user_for_session" => reply(&identity.user_for_session(args(body)?).await?),
        "user_for_git_credentials" => reply(&identity.user_for_git_credentials(args(body)?).await?),
        "user_for_access_token" => {
            let a: TokenArgs = args(body)?;
            reply(&identity.user_for_access_token(&a.token).await?)
        }
        "user_for_ssh_key" => reply(&identity.user_for_ssh_key(args(body)?).await?),
        "user_by_username" => reply(&identity.user_by_username(args(body)?).await?),
        "usernames" => reply(&identity.usernames(args(body)?).await?),
        // The API: each username's chosen case, shown beside it.
        "display_usernames" => reply(&identity.display_usernames(args(body)?).await?),
        "accounts" => reply(&identity.accounts(args(body)?).await?),
        "users_for_audience" => reply(&identity.users_for_audience(args(body)?).await?),
        "notify_by_email" => reply(&identity.notify_by_email(args(body)?).await?),
        "profile" => reply(&identity.profile(args(body)?).await?),
        "update_profile" => {
            let outcome = identity.update_profile(args(body)?).await?;
            if let Outcome::Ok(profile) = &outcome {
                identity.announce_user(&profile.username, None).await;
            }
            reply(&outcome)
        }
        "directory" => reply(&identity.directory(args(body)?).await?),
        "profile_workspaces" => reply(&identity.profile_workspaces(args(body)?).await?),
        // Each person's dock pins, per workspace; see dock.rs.
        "dock_pins" => reply(&identity.dock_pins(args(body)?).await?),
        "set_dock_pins" => reply(&identity.set_dock_pins(args(body)?).await?),
        "list_ssh_keys" => reply(&identity.list_ssh_keys(args(body)?).await?),
        // Services only: who registered each key, for verifying commit
        // signatures (repos' signatures.rs).
        "ssh_key_owners" => reply(&identity.ssh_key_owners(args(body)?).await?),
        "add_ssh_key" => reply(&identity.add_ssh_key(args(body)?).await?),
        "remove_ssh_key" => reply(&identity.remove_ssh_key(args(body)?).await?),
        // A repository's deploy keys, and who an SSH key signs in as; see
        // deploy_keys.rs.
        "list_deploy_keys" => reply(&identity.list_deploy_keys(args(body)?).await?),
        "get_deploy_key" => reply(&identity.get_deploy_key(args(body)?).await?),
        "add_deploy_key" => reply(&identity.add_deploy_key(args(body)?).await?),
        "remove_deploy_key" => reply(&identity.remove_deploy_key(args(body)?).await?),
        "principal_for_ssh_key" => reply(&identity.principal_for_ssh_key(args(body)?).await?),
        "list_access_tokens" => reply(&identity.list_access_tokens(args(body)?).await?),
        "create_access_token" => reply(&identity.create_access_token(args(body)?).await?),
        // Making and changing a person's or a workspace's token, and
        // workspaces' rules for tokens; see token_reach.rs.
        "create_token" => reply(&identity.create_token(args(body)?).await?),
        "update_token" => reply(&identity.update_token(args(body)?).await?),
        "get_token_policy" => reply(&identity.get_token_policy(args(body)?).await?),
        "set_token_policy" => reply(&identity.set_token_policy(args(body)?).await?),
        "list_member_tokens" => reply(&identity.list_member_tokens(args(body)?).await?),
        "review_token_request" => reply(&identity.review_token_request(args(body)?).await?),
        "revoke_member_token" => reply(&identity.revoke_member_token(args(body)?).await?),
        "create_agent_token" => reply(&identity.create_agent_token(args(body)?).await?),
        "agent_scope" => reply(&identity.agent_scope(args(body)?).await?),
        "create_run_credential" => reply(&identity.create_run_credential(args(body)?).await?),
        "bind_run_credentials" => reply(&identity.bind_run_credentials(args(body)?).await?),
        "revoke_run_credentials" => reply(&identity.revoke_run_credentials(args(body)?).await?),
        "create_job_token" => reply(&identity.create_job_token(args(body)?).await?),
        "revoke_job_tokens" => reply(&identity.revoke_job_tokens(args(body)?).await?),
        "remove_access_token" => reply(&identity.remove_access_token(args(body)?).await?),
        // Invites and the waitlist; see invites.rs.
        "registration" => reply(&identity.registration_mode()),
        "list_invites" => reply(&identity.list_invites(args(body)?).await?),
        "create_invite" => reply(&identity.create_invite(args(body)?).await?),
        "revoke_invite" => reply(&identity.revoke_invite(args(body)?).await?),
        "check_invite" => reply(&identity.check_invite(args(body)?).await?),
        "accept_invite" => reply(&identity.accept_invite(args(body)?).await?),
        "invite_member" => reply(&identity.invite_member(args(body)?).await?),
        "list_invitations" => reply(&identity.list_invitations(args(body)?).await?),
        "accept_invitation" => reply(&identity.accept_invitation(args(body)?).await?),
        "decline_invitation" => reply(&identity.decline_invitation(args(body)?).await?),
        "find_people" => reply(&identity.find_people(args(body)?).await?),
        "workspace_invites" => reply(&identity.workspace_invites(args(body)?).await?),
        "revoke_workspace_invite" => reply(&identity.revoke_workspace_invite(args(body)?).await?),
        "request_access" => reply(&identity.request_access(args(body)?).await?),
        // Who has access to a repository; see access.rs.
        "repo_access" => reply(&identity.repo_access(args(body)?).await?),
        "add_collaborator" => reply(&identity.add_collaborator(args(body)?).await?),
        "set_collaborator_role" => reply(&identity.set_collaborator_role(args(body)?).await?),
        "remove_collaborator" => reply(&identity.remove_collaborator(args(body)?).await?),
        "collaborator_permission" => reply(&identity.collaborator_permission(args(body)?).await?),
        "my_repo_invitations" => reply(&identity.my_repo_invitations(args(body)?).await?),
        "respond_repo_invitation" => reply(&identity.respond_repo_invitation(args(body)?).await?),
        "revoke_repo_invitation" => reply(&identity.revoke_repo_invitation(args(body)?).await?),
        "set_base_permission" => reply(&identity.set_base_permission(args(body)?).await?),
        // Where a workspace keeps its repositories' git data (EU residency).
        "workspace_residency" => reply(&identity.workspace_residency(args(body)?).await?),
        "set_workspace_residency" => reply(&identity.set_workspace_residency(args(body)?).await?),
        "outside_collaborators" => reply(&identity.outside_collaborators(args(body)?).await?),
        "forget_repo_access" => {
            let a: g1t_contracts::access::ForgetRepoAccessArgs = args(body)?;
            // A purged repository's deploy keys go with its access.
            identity.forget_deploy_keys(&a.repo_id).await?;
            reply(&identity.forget_repo_access(a).await?)
        }
        // Teams (teams.rs).
        "list_teams" => reply(&identity.list_teams(args(body)?).await?),
        "get_team" => reply(&identity.get_team(args(body)?).await?),
        "create_team" => reply(&identity.create_team(args(body)?).await?),
        "set_team_creation" => reply(&identity.set_team_creation(args(body)?).await?),
        "update_team" => reply(&identity.update_team(args(body)?).await?),
        "delete_team" => reply(&identity.delete_team(args(body)?).await?),
        "team_members" => reply(&identity.team_members(args(body)?).await?),
        "set_team_member" => reply(&identity.set_team_member(args(body)?).await?),
        "remove_team_member" => reply(&identity.remove_team_member(args(body)?).await?),
        "child_teams" => reply(&identity.child_teams(args(body)?).await?),
        "team_repos" => reply(&identity.team_repos(args(body)?).await?),
        "set_team_repo" => reply(&identity.set_team_repo(args(body)?).await?),
        "remove_team_repo" => reply(&identity.remove_team_repo(args(body)?).await?),
        "user_teams" => reply(&identity.user_teams(args(body)?).await?),
        "team_memberships" => reply(&identity.team_memberships(args(body)?).await?),
        "resolve_teams" => reply(&identity.resolve_teams(args(body)?).await?),
        // Agents on teams (teams.rs), and the people directory (people.rs).
        "team_agents" => reply(&identity.team_agents(args(body)?).await?),
        "set_team_agent" => reply(&identity.set_team_agent(args(body)?).await?),
        "remove_team_agent" => reply(&identity.remove_team_agent(args(body)?).await?),
        "agent_teams" => reply(&identity.agent_teams(args(body)?).await?),
        "team_agent_index" => reply(&identity.team_agent_index(args(body)?).await?),
        "adopt_agent_teams" => reply(&identity.adopt_agent_teams(args(body)?).await?),
        "people_directory" => reply(&identity.people_directory(args(body)?).await?),
        "set_member_profile" => reply(&identity.set_member_profile(args(body)?).await?),
        "resolve_owners" => reply(&identity.resolve_owners(args(body)?).await?),
        // Staff only: sudo.g1t.sh, over its service binding. See admin.rs.
        "notify_owners" => reply(&identity.notify_owners(args(body)?).await?),
        "admin_workspaces" => reply(&identity.admin_workspaces(args(body)?).await?),
        "admin_workspace" => reply(&identity.admin_workspace(args(body)?).await?),
        "admin_waitlist" => reply(&identity.admin_waitlist(args(body)?).await?),
        "admin_decide_waitlist" => reply(&identity.admin_decide_waitlist(args(body)?).await?),
        "admin_waitlist_pending" => reply(&identity.admin_waitlist_pending().await?),
        "admin_invites" => reply(&identity.admin_invites(args(body)?).await?),
        "admin_revoke_invite" => reply(&identity.admin_revoke_invite(args(body)?).await?),
        "admin_mint_invite" => reply(&identity.admin_mint_invite(args(body)?).await?),
        "admin_grant_invites" => reply(&identity.admin_grant_invites(args(body)?).await?),
        "admin_invite_tree" => reply(&identity.admin_invite_tree(args(body)?).await?),
        "admin_workspace_invites" => reply(&identity.admin_workspace_invites(args(body)?).await?),
        // Shared invite links for a group; see shared_invites.rs.
        "admin_shared_invites" => reply(&identity.admin_shared_invites().await?),
        "admin_create_shared_invite" => reply(&identity.admin_create_shared_invite(args(body)?).await?),
        "admin_revoke_shared_invite" => reply(&identity.admin_revoke_shared_invite(args(body)?).await?),
        // Deleted workspaces, restored or purged by staff; see deletion.rs.
        "admin_deleted_workspaces" => reply(&identity.admin_deleted_workspaces().await?),
        "admin_restore_workspace" => reply(&identity.admin_restore_workspace(args(body)?).await?),
        "admin_purge_workspace" => reply(&identity.admin_purge_workspace(args(body)?).await?),
        // Deleting accounts (account_deletion.rs): the person from the
        // site, staff from sudo. There is no API route for it.
        "check_account_deletion" => reply(&identity.check_account_deletion(args(body)?).await?),
        "delete_account" => reply(&identity.delete_account(args(body)?).await?),
        "admin_delete_account" => reply(&identity.admin_delete_account(args(body)?).await?),
        "admin_deleted_accounts" => reply(&identity.admin_deleted_accounts().await?),
        "admin_restore_account" => reply(&identity.admin_restore_account(args(body)?).await?),
        "admin_purge_account" => reply(&identity.admin_purge_account(args(body)?).await?),
        // Workspace aliases, set by staff only; see aliases.rs.
        "admin_aliases" => reply(&identity.admin_aliases().await?),
        "admin_set_alias" => reply(&identity.admin_set_alias(args(body)?).await?),
        "admin_remove_alias" => reply(&identity.admin_remove_alias(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    };
    served.finish(answered)
}

#[cfg(test)]
mod register_tests {
    use super::*;

    #[test]
    fn nobody_registers_as_g1t() {
        // What register checks the username with, whatever its case.
        for username in ["g1t", "G1T", "g1t-agent", "G1t-Agent"] {
            assert!(claimable_username(username).is_none(), "{username}");
        }
        assert_eq!(claimable_username("ana").map(|name| name.canonical).as_deref(), Some("ana"));
    }

    #[test]
    fn a_username_keeps_the_case_it_was_chosen_in() {
        let name = claimable_username("Ana-Lopez").unwrap();
        assert_eq!(name.canonical, "ana-lopez");
        assert_eq!(name.display_if_cased(), Some("Ana-Lopez"));
        assert!(USERNAME_RULES.contains("either case"));
    }
}
