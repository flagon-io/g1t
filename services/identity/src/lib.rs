//! The identity service: accounts, sessions, SSH keys and access tokens.
//!
//! Reached only through service bindings; see `g1t_contracts::identity` for
//! the methods and their arguments.

mod admin;
mod avatars;
mod crypto;
mod device;
mod email;
mod oauth;
mod profiles;
mod rename;
mod run_credentials;
mod tokens;
mod workspaces;

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, is_valid_namespace, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use tokens::TOKEN_PREFIX;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Request, Response, Result, event};

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
    email: Option<String>,
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
        user.workspaces = self.memberships(&user.id).await?;
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
                "SELECT users.id, users.username, users.email FROM email_tokens
                 JOIN users ON users.id = email_tokens.user_id
                 WHERE email_tokens.id = ? AND email_tokens.kind = ?
                   AND email_tokens.expires_at > {SQL_NOW}"
            ))
            .bind(&[id.as_str().into(), kind.into()])?
            .first::<TokenOwner>(None)
            .await?;
        if let Some(owner) = &owner {
            // Every outstanding token of this kind dies with the one used.
            self.db
                .prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?")
                .bind(&[owner.id.as_str().into(), kind.into()])?
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
        let row = self
            .db
            .prepare(
                "SELECT id, username, email FROM users WHERE id = ? AND email_verified_at IS NULL",
            )
            .bind(&[a.user.id.as_str().into()])?
            .first::<TokenOwner>(None)
            .await?;
        let Some(TokenOwner {
            email: Some(email), ..
        }) = row
        else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This account's email is already confirmed.",
            ));
        };
        self.send_verification(&a.user, &email).await?;
        Ok(Outcome::Ok(true))
    }

    async fn verify_email(&self, a: EmailTokenArgs) -> Result<Outcome<User>> {
        let Some(owner) = self.redeem_email_token(&a.token, "verify").await? else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "This confirmation link is not valid or has expired.",
            ));
        };
        self.db
            .prepare(format!(
                "UPDATE users SET email_verified_at = {SQL_NOW} WHERE id = ?"
            ))
            .bind(&[owner.id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(User {
            id: owner.id,
            username: owner.username,
            verified: true,
            ..User::default()
        }))
    }

    async fn request_password_reset(&self, a: EmailArgs) -> Result<bool> {
        let row = self
            .db
            .prepare("SELECT id, username, email FROM users WHERE email = ?")
            .bind(&[a.email.trim().to_lowercase().into()])?
            .first::<TokenOwner>(None)
            .await?;
        if let Some(TokenOwner {
            id,
            username,
            email: Some(email),
        }) = row
        {
            let token = self
                .issue_email_token(&id, "reset", RESET_TTL_SECONDS)
                .await?;
            email::send_password_reset(&self.env, &email, &username, &token).await?;
        }
        // The same answer either way, so addresses cannot be probed.
        Ok(true)
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
        // Following an emailed link also proves the address.
        self.db
            .prepare(format!(
                "UPDATE users SET password_hash = ?,
                   email_verified_at = COALESCE(email_verified_at, {SQL_NOW})
                 WHERE id = ?"
            ))
            .bind(&[
                crypto::hash_password(&a.password).into(),
                owner.id.as_str().into(),
            ])?
            .run()
            .await?;
        // Anyone signed in with the old password is signed out.
        self.db
            .prepare("DELETE FROM sessions WHERE user_id = ?")
            .bind(&[owner.id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(User {
            id: owner.id,
            username: owner.username,
            verified: true,
            ..User::default()
        }))
    }

    async fn user_for_password(&self, username: &str, password: &str) -> Result<Viewer> {
        let row = self
            .db
            .prepare("SELECT id, username, password_hash, email_verified_at IS NOT NULL AS verified FROM users WHERE username = ?")
            .bind(&[JsValue::from(username.to_lowercase())])?
            .first::<UserRow>(None)
            .await?;
        let user = row
            .filter(|row| crypto::verify_password(password, &row.password_hash))
            .map(|row| User {
                id: row.id,
                username: row.username,
                verified: row.verified != 0,
                ..User::default()
            });
        self.with_workspaces(user).await
    }

    async fn register(&self, a: RegisterArgs) -> Result<Outcome<SignedIn>> {
        let username = a.username.trim().to_lowercase();
        let email = a.email.trim().to_lowercase();
        let invalid = |message: &str| Ok(Outcome::fail(FailureCode::Invalid, message));
        if !is_valid_namespace(&username) {
            return invalid(
                "Usernames use lowercase letters, digits and single hyphens, up to 39 characters.",
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
            .prepare(
                "SELECT username FROM users WHERE username = ? OR email = ?
                 UNION ALL SELECT slug FROM workspaces WHERE slug = ?",
            )
            .bind(&[
                username.as_str().into(),
                email.as_str().into(),
                username.as_str().into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?;
        // A renamed workspace's old slug stays reserved for it a while.
        if taken.is_some() || self.slug_held(&username).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That username or email is already registered.",
            ));
        }
        let user = User {
            id: new_id("usr", now_ms()),
            username,
            ..User::default()
        };
        self.db
            .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)")
            .bind(&[
                user.id.as_str().into(),
                user.username.as_str().into(),
                email.as_str().into(),
                crypto::hash_password(&a.password).into(),
            ])?
            .run()
            .await?;
        // The account exists either way; the email can be sent again later.
        if let Err(error) = self.send_verification(&user, &email).await {
            worker::console_error!("verification email failed: {error}");
        }
        self.start_session(user).await
    }

    async fn sign_in(&self, a: SignInArgs) -> Result<Outcome<SignedIn>> {
        let Some(user) = self.user_for_password(&a.username, &a.password).await? else {
            return Ok(Outcome::fail(
                FailureCode::Unauthenticated,
                "Incorrect username or password.",
            ));
        };
        self.start_session(user).await
    }

    async fn start_session(&self, user: User) -> Result<Outcome<SignedIn>> {
        let session_token = crypto::random_hex(32);
        self.db
            .prepare(format!(
                "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, {})",
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

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: serde_json::Value = request.json().await?;
    let identity = Identity {
        db: env.d1("DB")?,
        env,
    };

    match method.as_str() {
        "register" => reply(&identity.register(args(body)?).await?),
        "sign_in" => reply(&identity.sign_in(args(body)?).await?),
        "create_workspace" => reply(&identity.create_workspace(args(body)?).await?),
        "get_workspace" => reply(&identity.get_workspace(args(body)?).await?),
        "list_members" => reply(&identity.list_members(args(body)?).await?),
        "add_member" => reply(&identity.add_member(args(body)?).await?),
        "remove_member" => reply(&identity.remove_member(args(body)?).await?),
        "update_workspace" => reply(&identity.update_workspace(args(body)?).await?),
        "rename_workspace" => reply(&identity.rename_workspace(args(body)?).await?),
        "check_workspace_rename" => reply(&identity.check_workspace_rename(args(body)?).await?),
        "resolve_slug" => reply(&identity.resolve_slug(args(body)?).await?),
        "set_workspace_avatar" => reply(&identity.set_workspace_avatar(args(body)?).await?),
        "set_user_avatar" => reply(&identity.set_user_avatar(args(body)?).await?),
        "list_workspace_tokens" => reply(&identity.list_workspace_tokens(args(body)?).await?),
        "create_workspace_token" => reply(&identity.create_workspace_token(args(body)?).await?),
        "remove_workspace_token" => reply(&identity.remove_workspace_token(args(body)?).await?),
        "oauth_authorize" => reply(&identity.oauth_authorize(args(body)?).await?),
        "oauth_exchange" => reply(&identity.oauth_exchange(args(body)?).await?),
        "oauth_refresh" => reply(&identity.oauth_refresh(args(body)?).await?),
        "list_oauth_grants" => reply(&identity.list_oauth_grants(args(body)?).await?),
        "revoke_oauth_grant" => reply(&identity.revoke_oauth_grant(args(body)?).await?),
        "device_start" => reply(&identity.device_start(args(body)?).await?),
        "device_lookup" => reply(&identity.device_lookup(args(body)?).await?),
        "device_resolve" => reply(&identity.device_resolve(args(body)?).await?),
        "device_claim" => reply(&identity.device_claim(args(body)?).await?),
        "resend_verification" => reply(&identity.resend_verification(args(body)?).await?),
        "verify_email" => reply(&identity.verify_email(args(body)?).await?),
        "request_password_reset" => reply(&identity.request_password_reset(args(body)?).await?),
        "reset_password" => reply(&identity.reset_password(args(body)?).await?),
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
        "profile" => reply(&identity.profile(args(body)?).await?),
        "update_profile" => reply(&identity.update_profile(args(body)?).await?),
        "profile_workspaces" => reply(&identity.profile_workspaces(args(body)?).await?),
        "list_ssh_keys" => reply(&identity.list_ssh_keys(args(body)?).await?),
        "add_ssh_key" => reply(&identity.add_ssh_key(args(body)?).await?),
        "remove_ssh_key" => reply(&identity.remove("ssh_keys", args(body)?).await?),
        "list_access_tokens" => reply(&identity.list_access_tokens(args(body)?).await?),
        "create_access_token" => reply(&identity.create_access_token(args(body)?).await?),
        "create_agent_token" => reply(&identity.create_agent_token(args(body)?).await?),
        "agent_scope" => reply(&identity.agent_scope(args(body)?).await?),
        "create_run_credential" => reply(&identity.create_run_credential(args(body)?).await?),
        "bind_run_credentials" => reply(&identity.bind_run_credentials(args(body)?).await?),
        "revoke_run_credentials" => reply(&identity.revoke_run_credentials(args(body)?).await?),
        "remove_access_token" => reply(&identity.remove("access_tokens", args(body)?).await?),
        // Staff only: sudo.g1t.sh, over its service binding. See admin.rs.
        "notify_owners" => reply(&identity.notify_owners(args(body)?).await?),
        "admin_workspaces" => reply(&identity.admin_workspaces(args(body)?).await?),
        "admin_workspace" => reply(&identity.admin_workspace(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}
