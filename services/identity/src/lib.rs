//! The identity service: accounts, sessions, SSH keys and access tokens.
//!
//! Reached only through service bindings; see `g1t_contracts::identity` for
//! the methods and their arguments.

mod access;
mod admin;
mod avatars;
mod crypto;
mod deletion;
mod device;
mod directory;
mod email;
mod emails;
mod github;
mod invites;
mod oauth;
mod profiles;
mod rename;
mod run_credentials;
mod security;
mod teams;
mod throttle;
mod tokens;
mod workspaces;

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, claimable_namespace, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use tokens::TOKEN_PREFIX;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

const SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const VERIFY_TTL_SECONDS: u64 = 24 * 60 * 60;
const RESET_TTL_SECONDS: u64 = 60 * 60;
const MIN_PASSWORD_LENGTH: usize = 10;
const PASSWORD_TOO_SHORT: &str = "Use a password of at least 10 characters.";

/// A user as selected from the database; `verified` arrives as 0 or 1.
#[derive(Deserialize)]
struct Account {
    id: String,
    username: String,
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
}

impl From<KeyRow> for SshKey {
    fn from(row: KeyRow) -> Self {
        SshKey {
            id: row.id,
            title: row.title,
            fingerprint: row.fingerprint,
            created_at: row.created_at,
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
        let memberships = self.memberships(&user.id).await?;
        // Access to a workspace is used only within its policy; see security.rs.
        user.workspaces = self.within_policy(&user.id, memberships).await?;
        // Roles on single repositories, under the same policy (access.rs).
        let grants = self.grants_of(&user.id).await?;
        user.grants = self.grants_within_policy(&user.id, grants).await?;
        Ok(Some(user))
    }

    /// Runs a query that resolves credentials to at most one user.
    async fn find_user(&self, sql: &str, param: &str) -> Result<Viewer> {
        let user = self.find_public_user(sql, param).await?;
        self.with_workspaces(user).await
    }

    /// Stores a one-time token of `kind` for the user and returns it.
    async fn issue_email_token(&self, user_id: &str, kind: &str, ttl: u64) -> Result<String> {
        let token = crypto::random_hex(32);
        self.db
            .prepare(format!(
                "INSERT INTO email_tokens (id, user_id, kind, expires_at)
                 VALUES (?, ?, ?, {})",
                sql_after(ttl)
            ))
            .bind(&[
                crypto::sha256_hex(&token).into(),
                user_id.into(),
                kind.into(),
            ])?
            .run()
            .await?;
        Ok(token)
    }

    /// Consumes a token of `kind`, returning its owner if it was valid.
    async fn redeem_email_token(&self, token: &str, kind: &str) -> Result<Option<TokenOwner>> {
        let id = crypto::sha256_hex(token);
        let owner = self
            .db
            .prepare(format!(
                "SELECT users.id, users.username, email_tokens.email_id FROM email_tokens
                 JOIN users ON users.id = email_tokens.user_id
                 WHERE email_tokens.id = ? AND email_tokens.kind = ?
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

    async fn send_verification(&self, user: &User, email: &str) -> Result<()> {
        let token = self
            .issue_email_token(&user.id, "verify", VERIFY_TTL_SECONDS)
            .await?;
        email::send_verification(&self.env, email, &user.username, &token).await
    }

    async fn resend_verification(&self, a: UserArgs) -> Result<Outcome<bool>> {
        if !self.allow(throttle::CONFIRM_ACCOUNT, &a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Too many confirmation emails this hour. Check your inbox, or try again later."));
        }
        self.resend_primary(&a.user).await
    }

    async fn verify_email(&self, a: EmailTokenArgs) -> Result<Outcome<User>> {
        let Some(owner) = self.redeem_email_token(&a.token, "verify").await? else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "This confirmation link is not valid or has expired.",
            ));
        };
        if let Outcome::Fail(failure) = self.confirm_address(&owner.id, owner.email_id.as_deref()).await? {
            return Ok(Outcome::Fail(failure));
        }
        // Whether the account is confirmed: whether its primary is.
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
                "SELECT id, username, password_hash, email_verified_at IS NOT NULL AS verified FROM users WHERE {column} = ?"
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

    async fn user_for_password(&self, login: &str, password: &str) -> Result<Viewer> {
        let user = self.checked_password(login, password, None).await?.ok();
        self.with_workspaces(user).await
    }

    async fn register(&self, a: RegisterArgs) -> Result<Outcome<SignedIn>> {
        let username = a.username.trim().to_lowercase();
        let claimable = claimable_namespace(&username).is_some();
        let email = a.email.trim().to_lowercase();
        let invalid = |message: &str| Ok(Outcome::fail(FailureCode::Invalid, message));
        let invite_code = a.invite_code.as_deref().map(str::trim).filter(|code| !code.is_empty());
        // The invite first: without one, nothing else on the form matters.
        if self.invites_required() && invite_code.is_none() {
            return Ok(Outcome::fail(FailureCode::Forbidden, invites::MISSING));
        }
        if !claimable {
            return invalid(
                "Usernames use lowercase letters, digits and single hyphens, up to 39 characters, and cannot be a reserved word.",
            );
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
                email: &email,
                password_hash: &password_hash,
                verified: false,
                invite_code,
                client: a.client.as_deref(),
            })
            .await?
        {
            Outcome::Ok(user) => user,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // The account exists either way; the email can be sent again later.
        // An invite sent to this address confirmed it already (invites.rs).
        if !user.verified
            && let Err(error) = self.send_verification(&user, &email).await
        {
            worker::console_error!("verification email failed: {error}");
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

    async fn start_session(&self, user: User) -> Result<Outcome<SignedIn>> {
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
                "SELECT users.id, users.username, users.email_verified_at IS NOT NULL AS verified,
                   users.avatar
                 FROM sessions JOIN users ON users.id = sessions.user_id
                 WHERE sessions.id = ? AND sessions.expires_at > {SQL_NOW}"
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
             WHERE fingerprint = ?",
            &a.fingerprint,
        )
        .await
    }

    async fn user_by_username(&self, a: UsernameArgs) -> Result<Viewer> {
        self.find_public_user(
            "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE username = ?",
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
                "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE username = ?",
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

    async fn list_ssh_keys(&self, a: UserArgs) -> Result<Vec<SshKey>> {
        let rows = self
            .db
            .prepare("SELECT id, title, fingerprint, created_at FROM ssh_keys WHERE user_id = ? ORDER BY id")
            .bind(&[a.user.id.into()])?
            .all()
            .await?
            .results::<KeyRow>()?;
        Ok(rows.into_iter().map(SshKey::from).collect())
    }

    async fn add_ssh_key(&self, a: AddSshKeyArgs) -> Result<Outcome<SshKey>> {
        let Some(key) = crypto::parse_ssh_key(&a.public_key) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "That is not a valid OpenSSH public key.",
            ));
        };
        let taken = self
            .db
            .prepare("SELECT id FROM ssh_keys WHERE fingerprint = ?")
            .bind(&[key.fingerprint.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if taken.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That key is already registered.",
            ));
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
        };
        self.db
            .prepare(
                "INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                row.id.as_str().into(),
                a.user.id.into(),
                row.title.as_str().into(),
                key.public_key.into(),
                row.fingerprint.as_str().into(),
                row.created_at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(row.into()))
    }

    /// Deletes a row the user owns from `table`.
    async fn remove(&self, table: &str, a: RemoveArgs) -> Result<()> {
        self.db
            .prepare(format!("DELETE FROM {table} WHERE id = ? AND user_id = ?"))
            .bind(&[a.id.into(), a.user.id.into()])?
            .run()
            .await?;
        Ok(())
    }
}

/// Every 15 minutes: staff hear about waitlist requests that arrived while
/// the last summary's window was still open, so none waits on a later one;
/// and deleted workspaces past their restore window are purged
/// (deletion.rs).
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
        "create_workspace_token" => reply(&identity.create_workspace_token(args(body)?).await?),
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
        "request_password_reset" => reply(&identity.request_password_reset(args(body)?).await?),
        "reset_password" => reply(&identity.reset_password(args(body)?).await?),
        // A person's email addresses; see emails.rs and security.rs.
        "list_emails" => reply(&identity.list_emails(args(body)?).await?),
        "add_email" => reply(&identity.add_email(args(body)?).await?),
        "remove_email" => reply(&identity.remove_email(args(body)?).await?),
        "resend_email_verification" => reply(&identity.resend_email_verification(args(body)?).await?),
        "update_email_settings" => reply(&identity.update_email_settings(args(body)?).await?),
        "reauthenticate" => reply(&identity.reauthenticate(args(body)?).await?),
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
        "list_ssh_keys" => reply(&identity.list_ssh_keys(args(body)?).await?),
        "add_ssh_key" => reply(&identity.add_ssh_key(args(body)?).await?),
        "remove_ssh_key" => reply(&identity.remove("ssh_keys", args(body)?).await?),
        "list_access_tokens" => reply(&identity.list_access_tokens(args(body)?).await?),
        "create_access_token" => reply(&identity.create_access_token(args(body)?).await?),
        "update_access_token" => reply(&identity.update_access_token(args(body)?).await?),
        "create_agent_token" => reply(&identity.create_agent_token(args(body)?).await?),
        "agent_scope" => reply(&identity.agent_scope(args(body)?).await?),
        "create_run_credential" => reply(&identity.create_run_credential(args(body)?).await?),
        "bind_run_credentials" => reply(&identity.bind_run_credentials(args(body)?).await?),
        "revoke_run_credentials" => reply(&identity.revoke_run_credentials(args(body)?).await?),
        "remove_access_token" => reply(&identity.remove("access_tokens", args(body)?).await?),
        // Invites and the waitlist; see invites.rs.
        "registration" => reply(&identity.registration_mode()),
        "list_invites" => reply(&identity.list_invites(args(body)?).await?),
        "create_invite" => reply(&identity.create_invite(args(body)?).await?),
        "revoke_invite" => reply(&identity.revoke_invite(args(body)?).await?),
        "check_invite" => reply(&identity.check_invite(args(body)?).await?),
        "accept_invite" => reply(&identity.accept_invite(args(body)?).await?),
        "invite_member" => reply(&identity.invite_member(args(body)?).await?),
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
        "forget_repo_access" => reply(&identity.forget_repo_access(args(body)?).await?),
        // Teams (teams.rs).
        "list_teams" => reply(&identity.list_teams(args(body)?).await?),
        "get_team" => reply(&identity.get_team(args(body)?).await?),
        "create_team" => reply(&identity.create_team(args(body)?).await?),
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
        // Deleted workspaces, restored or purged by staff; see deletion.rs.
        "admin_deleted_workspaces" => reply(&identity.admin_deleted_workspaces().await?),
        "admin_restore_workspace" => reply(&identity.admin_restore_workspace(args(body)?).await?),
        "admin_purge_workspace" => reply(&identity.admin_purge_workspace(args(body)?).await?),
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
            assert_eq!(claimable_namespace(username), None, "{username}");
        }
        assert_eq!(claimable_namespace("ana").as_deref(), Some("ana"));
    }
}
