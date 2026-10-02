//! The identity service: accounts, sessions, SSH keys and access tokens.
//!
//! Reached only through service bindings; see `g1t_contracts::identity` for
//! the methods and their arguments.

mod crypto;

use g1t_contracts::identity::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, is_valid_namespace, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Request, Response, Result, event};

const SESSION_TTL_SECONDS: u32 = 30 * 24 * 60 * 60;
const TOKEN_PREFIX: &str = "g1t_";
const MIN_PASSWORD_LENGTH: usize = 10;

#[derive(Deserialize)]
struct UserRow {
    id: String,
    username: String,
    password_hash: String,
}

#[derive(Deserialize)]
struct KeyRow {
    id: String,
    title: String,
    fingerprint: String,
    created_at: u64,
}

impl From<KeyRow> for SshKey {
    fn from(row: KeyRow) -> Self {
        SshKey {
            id: row.id,
            title: row.title,
            fingerprint: row.fingerprint,
            created_at: row.created_at * 1000,
        }
    }
}

#[derive(Deserialize)]
struct TokenRow {
    id: String,
    name: String,
    created_at: u64,
}

impl From<TokenRow> for AccessToken {
    fn from(row: TokenRow) -> Self {
        AccessToken {
            id: row.id,
            name: row.name,
            created_at: row.created_at * 1000,
        }
    }
}

struct Identity {
    db: D1Database,
}

impl Identity {
    /// Runs a query that returns at most one user.
    async fn find_user(&self, sql: &str, param: &str) -> Result<Viewer> {
        self.db
            .prepare(sql)
            .bind(&[JsValue::from(param)])?
            .first::<User>(None)
            .await
    }

    async fn user_for_password(&self, username: &str, password: &str) -> Result<Viewer> {
        let row = self
            .db
            .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
            .bind(&[JsValue::from(username.to_lowercase())])?
            .first::<UserRow>(None)
            .await?;
        Ok(row
            .filter(|row| crypto::verify_password(password, &row.password_hash))
            .map(|row| User {
                id: row.id,
                username: row.username,
            }))
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
            return invalid("Use a password of at least 10 characters.");
        }
        let taken = self
            .db
            .prepare("SELECT username FROM users WHERE username = ? OR email = ?")
            .bind(&[username.as_str().into(), email.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if taken.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That username or email is already registered.",
            ));
        }
        let user = User {
            id: new_id("usr", now_ms()),
            username,
        };
        self.db
            .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)")
            .bind(&[
                user.id.as_str().into(),
                user.username.as_str().into(),
                email.into(),
                crypto::hash_password(&a.password).into(),
            ])?
            .run()
            .await?;
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
            .prepare(
                "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)",
            )
            .bind(&[
                crypto::sha256_hex(&session_token).into(),
                user.id.as_str().into(),
                SESSION_TTL_SECONDS.into(),
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
            "SELECT users.id, users.username FROM sessions
             JOIN users ON users.id = sessions.user_id
             WHERE sessions.id = ? AND sessions.expires_at > unixepoch()",
            &crypto::sha256_hex(&a.session_token),
        )
        .await
    }

    async fn user_for_access_token(&self, token: &str) -> Result<Viewer> {
        if !token.starts_with(TOKEN_PREFIX) {
            return Ok(None);
        }
        self.find_user(
            "SELECT users.id, users.username FROM access_tokens
             JOIN users ON users.id = access_tokens.user_id
             WHERE token_hash = ?",
            &crypto::sha256_hex(token),
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
            "SELECT users.id, users.username FROM ssh_keys
             JOIN users ON users.id = ssh_keys.user_id
             WHERE fingerprint = ?",
            &a.fingerprint,
        )
        .await
    }

    async fn user_by_username(&self, a: UsernameArgs) -> Result<Viewer> {
        self.find_user(
            "SELECT id, username FROM users WHERE username = ?",
            &a.username.to_lowercase(),
        )
        .await
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
            created_at: now / 1000,
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
                (row.created_at as f64).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(row.into()))
    }

    async fn list_access_tokens(&self, a: UserArgs) -> Result<Vec<AccessToken>> {
        let rows = self
            .db
            .prepare("SELECT id, name, created_at FROM access_tokens WHERE user_id = ? ORDER BY id")
            .bind(&[a.user.id.into()])?
            .all()
            .await?
            .results::<TokenRow>()?;
        Ok(rows.into_iter().map(AccessToken::from).collect())
    }

    async fn create_access_token(&self, a: CreateAccessTokenArgs) -> Result<CreatedAccessToken> {
        let token = format!("{TOKEN_PREFIX}{}", crypto::random_hex(20));
        let now = now_ms();
        let name = match a.name.trim() {
            "" => "Access token",
            name => name,
        };
        let row = TokenRow {
            id: new_id("tok", now),
            name: name.to_owned(),
            created_at: now / 1000,
        };
        self.db
            .prepare(
                "INSERT INTO access_tokens (id, user_id, name, token_hash, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&[
                row.id.as_str().into(),
                a.user.id.into(),
                row.name.as_str().into(),
                crypto::sha256_hex(&token).into(),
                (row.created_at as f64).into(),
            ])?
            .run()
            .await?;
        Ok(CreatedAccessToken {
            token,
            info: row.into(),
        })
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
    let identity = Identity { db: env.d1("DB")? };

    match method.as_str() {
        "register" => reply(&identity.register(args(body)?).await?),
        "sign_in" => reply(&identity.sign_in(args(body)?).await?),
        "sign_out" => reply(&identity.sign_out(args(body)?).await?),
        "user_for_session" => reply(&identity.user_for_session(args(body)?).await?),
        "user_for_git_credentials" => reply(&identity.user_for_git_credentials(args(body)?).await?),
        "user_for_access_token" => {
            let a: TokenArgs = args(body)?;
            reply(&identity.user_for_access_token(&a.token).await?)
        }
        "user_for_ssh_key" => reply(&identity.user_for_ssh_key(args(body)?).await?),
        "user_by_username" => reply(&identity.user_by_username(args(body)?).await?),
        "list_ssh_keys" => reply(&identity.list_ssh_keys(args(body)?).await?),
        "add_ssh_key" => reply(&identity.add_ssh_key(args(body)?).await?),
        "remove_ssh_key" => reply(&identity.remove("ssh_keys", args(body)?).await?),
        "list_access_tokens" => reply(&identity.list_access_tokens(args(body)?).await?),
        "create_access_token" => reply(&identity.create_access_token(args(body)?).await?),
        "remove_access_token" => reply(&identity.remove("access_tokens", args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}
