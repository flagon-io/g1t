//! Signing in with GitHub, through g1t's GitHub App's user authorization:
//! the OAuth web flow with PKCE (S256).
//!
//! The site sends the browser to GitHub with a state it also keeps in a
//! short-lived cookie; this service keeps the state's hash and the PKCE
//! verifier, each usable once and for ten minutes. On the way back the site
//! checks the cookie against the state GitHub returns, and this service
//! redeems the state, exchanges the code, and reads the person's GitHub
//! account and verified emails.
//!
//! A GitHub account is known by its numeric id, never its login, which its
//! owner can change. One with no g1t account yet makes one; one whose
//! verified email belongs to an existing g1t account is never linked to it
//! silently: the person signs in to that account first. The app's user
//! tokens expire, so the refresh token is kept, sealed under IDENTITY_KEY,
//! and used when the access token is about to run out. Tokens are opaque
//! strings of any length.
//!
//! Configured with the vars GITHUB_APP_CLIENT_ID and the secret
//! GITHUB_APP_CLIENT_SECRET; without both, `github_enabled` is false and
//! everything else here says GitHub is not set up.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::github::*;
use g1t_contracts::identity::{SignedIn, UserArgs};
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, User, claimable_namespace, is_reserved_name, is_valid_namespace, new_id};
use g1t_kit::now_ms;
use g1t_secrets::Sealer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use worker::{Fetch, Headers, Method, Request, RequestInit, Result, Url};

use crate::{Identity, crypto};

const STATE_TTL_SECONDS: u64 = 10 * 60;
const PENDING_TTL_SECONDS: u64 = 30 * 60;
/// An access token this close to expiring is refreshed before use.
const REFRESH_MARGIN_MS: u64 = 5 * 60 * 1000;
const AUTHORIZE_URL: &str = "https://github.com/login/oauth/authorize";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API: &str = "https://api.github.com";
const NOT_SET_UP: &str = "Signing in with GitHub is not set up on this g1t.";
const TRY_AGAIN: &str = "GitHub did not complete the sign-in. Try again.";

/// The app's OAuth client, when this g1t has one.
struct Client {
    id: String,
    secret: String,
}

fn client(env: &worker::Env) -> Option<Client> {
    let id = env.var("GITHUB_APP_CLIENT_ID").ok()?.to_string();
    let secret = env.secret("GITHUB_APP_CLIENT_SECRET").ok()?.to_string();
    (!id.trim().is_empty() && !secret.trim().is_empty()).then(|| Client {
        id: id.trim().to_owned(),
        secret: secret.trim().to_owned(),
    })
}

// --- Pure parts, tested below ----------------------------------------------

/// A PKCE code verifier: 32 random bytes, base64url, 43 characters.
pub fn new_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The S256 challenge for a verifier (RFC 7636).
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    Url::parse_with_params(
        AUTHORIZE_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("allow_signup", "true"),
        ],
    )
    .map(|url| url.to_string())
    .unwrap_or_default()
}

/// One of `GET /user/emails`.
#[derive(Clone, Debug, Deserialize)]
pub struct GithubEmail {
    pub email: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub verified: bool,
}

/// The verified addresses, lowercased, the primary first. Unverified ones
/// prove nothing, and GitHub's private relay addresses belong to no inbox
/// g1t could write to.
pub fn verified_emails(emails: &[GithubEmail]) -> Vec<String> {
    let mut kept: Vec<(bool, String)> = emails
        .iter()
        .filter(|email| email.verified)
        .map(|email| (email.primary, email.email.trim().to_lowercase()))
        .filter(|(_, email)| email.contains('@') && !email.ends_with("@users.noreply.github.com"))
        .collect();
    // Primary first; otherwise as GitHub listed them.
    kept.sort_by_key(|(primary, _)| !primary);
    let mut out: Vec<String> = Vec::new();
    for (_, email) in kept {
        if !out.contains(&email) {
            out.push(email);
        }
    }
    out
}

/// A username made from a GitHub login: lowercased, with anything g1t does
/// not allow turned into single hyphens. A login that is a reserved name,
/// such as `g1t`, is suggested with `-gh` after it, so signing up still
/// goes ahead under a name of its own.
pub fn suggest_username(login: &str) -> String {
    let mut out = String::new();
    for character in login.trim().to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(39).collect();
    let out = out.trim_end_matches('-');
    if is_reserved_name(out) { format!("{out}-gh") } else { out.to_owned() }
}

/// What a return from GitHub should do.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Sign in to the account the GitHub account is linked to.
    SignIn(String),
    /// Link it to the signed-in account that asked.
    Link(String),
    /// Refused, with why.
    Refuse(&'static str),
    /// An account has one of its verified emails: sign in to it to link.
    NeedsLink,
    /// A new account with this username.
    Create(String),
    /// A new account, once the person picks a username; this one suggested.
    NeedsUsername(String),
}

/// Everything the decision depends on, as read from GitHub and the database.
#[derive(Debug, Default)]
pub struct Facts<'a> {
    pub purpose: Option<GithubPurpose>,
    /// The account that asked to link, for `link`.
    pub asking: Option<&'a str>,
    /// Whether the asking account already has another GitHub account.
    pub asking_has_other: bool,
    /// The account this GitHub account is linked to already.
    pub linked_to: Option<&'a str>,
    pub has_verified_email: bool,
    /// Whether an existing account has one of its verified emails.
    pub email_taken: bool,
    /// The suggested username, and whether it can be registered.
    pub suggestion: String,
    pub suggestion_free: bool,
    /// g1t is invite-only and no invite code came with the sign-in: a new
    /// account waits for one.
    pub invite_missing: bool,
}

pub fn decide(facts: &Facts) -> Decision {
    if facts.purpose == Some(GithubPurpose::Link) {
        let Some(asking) = facts.asking else {
            return Decision::Refuse("Sign in to g1t first, then link GitHub.");
        };
        return match facts.linked_to {
            Some(linked) if linked == asking => Decision::Link(asking.to_owned()),
            Some(_) => Decision::Refuse("That GitHub account is linked to another g1t account."),
            None if facts.asking_has_other => {
                Decision::Refuse("Your account is linked to another GitHub account. Unlink it first.")
            }
            None => Decision::Link(asking.to_owned()),
        };
    }
    if let Some(linked) = facts.linked_to {
        return Decision::SignIn(linked.to_owned());
    }
    if !facts.has_verified_email {
        return Decision::Refuse(
            "Your GitHub account has no verified email address g1t can use. Verify one on GitHub, or create an account with your email.",
        );
    }
    // Never linked silently: whoever controls a GitHub account with the
    // same address is not thereby the owner of the g1t account.
    if facts.email_taken {
        return Decision::NeedsLink;
    }
    if facts.suggestion_free && !facts.invite_missing {
        Decision::Create(facts.suggestion.clone())
    } else {
        Decision::NeedsUsername(facts.suggestion.clone())
    }
}

/// A person's GitHub user tokens, as kept sealed. Times are milliseconds.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub access_expires_at: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub refresh_expires_at: Option<u64>,
}

/// Reads GitHub's token answer, at `now`. `None` if it holds no token.
pub fn tokens_from(answer: &Value, now: u64) -> Option<Tokens> {
    let access_token = answer["access_token"].as_str().filter(|token| !token.is_empty())?.to_owned();
    let after = |field: &str| answer[field].as_u64().map(|seconds| now + seconds * 1000);
    Some(Tokens {
        access_token,
        access_expires_at: after("expires_in"),
        refresh_token: answer["refresh_token"].as_str().filter(|token| !token.is_empty()).map(str::to_owned),
        refresh_expires_at: after("refresh_token_expires_in"),
    })
}

impl Tokens {
    pub fn fresh(&self, now: u64) -> bool {
        self.access_expires_at.is_none_or(|at| at > now + REFRESH_MARGIN_MS)
    }

    pub fn refreshable(&self, now: u64) -> bool {
        self.refresh_token.is_some() && self.refresh_expires_at.is_none_or(|at| at > now)
    }
}

// --- GitHub over HTTP --------------------------------------------------------

struct Answer {
    status: u16,
    body: Value,
}

async fn send(method: Method, url: &str, bearer: Option<&str>, body: Option<Value>) -> Result<Answer> {
    let headers = Headers::new();
    headers.set("user-agent", "g1t (+https://g1t.sh)")?;
    headers.set("accept", "application/json")?;
    if url.starts_with(API) {
        headers.set("accept", "application/vnd.github+json")?;
        headers.set("x-github-api-version", "2022-11-28")?;
    }
    if let Some(token) = bearer {
        headers.set("authorization", &format!("Bearer {token}"))?;
    }
    let mut init = RequestInit::new();
    if let Some(body) = &body {
        headers.set("content-type", "application/json")?;
        init.with_body(Some(body.to_string().into()));
    }
    init.with_method(method).with_headers(headers);
    let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
    let text = response.text().await.unwrap_or_default();
    Ok(Answer {
        status: response.status_code(),
        body: serde_json::from_str(&text).unwrap_or(Value::Null),
    })
}

/// Trades a code, or a refresh token, for tokens.
async fn token_request(client: &Client, grant: Value) -> Result<Option<Tokens>> {
    let mut body = serde_json::json!({ "client_id": client.id, "client_secret": client.secret });
    if let (Some(body), Some(grant)) = (body.as_object_mut(), grant.as_object()) {
        body.extend(grant.clone());
    }
    let answer = send(Method::Post, TOKEN_URL, None, Some(body)).await?;
    if answer.status != 200 || answer.body.get("error").is_some() {
        // GitHub answers 200 with an `error`; its description names no secret.
        worker::console_log!(
            "github token request refused: {}",
            answer.body["error"].as_str().unwrap_or("status")
        );
        return Ok(None);
    }
    Ok(tokens_from(&answer.body, now_ms()))
}

/// Who a user token belongs to, and their verified emails.
struct GithubUser {
    id: u64,
    login: String,
    emails: Vec<String>,
}

const INVITE_FOR_ANOTHER_ADDRESS: &str = "Your invite was sent to an address your GitHub account has not verified. Verify that address on GitHub and try again, or go back to the invite and create your account with your email and a password.";

/// Moves `bound` to the front of a GitHub account's verified addresses, so
/// a new account is made with it. False if GitHub has not verified it.
fn put_first(emails: &mut Vec<String>, bound: &str) -> bool {
    let Some(at) = emails.iter().position(|email| email.eq_ignore_ascii_case(bound.trim())) else {
        return false;
    };
    let email = emails.remove(at);
    emails.insert(0, email);
    true
}

async fn read_user(token: &str) -> Result<Option<GithubUser>> {
    let user = send(Method::Get, &format!("{API}/user"), Some(token), None).await?;
    let (Some(id), Some(login)) = (user.body["id"].as_u64(), user.body["login"].as_str()) else {
        return Ok(None);
    };
    let listed = send(Method::Get, &format!("{API}/user/emails"), Some(token), None).await?;
    let emails: Vec<GithubEmail> = serde_json::from_value(listed.body).unwrap_or_default();
    Ok(Some(GithubUser {
        id,
        login: login.to_owned(),
        emails: verified_emails(&emails),
    }))
}

// --- Rows --------------------------------------------------------------------

#[derive(Deserialize)]
struct StateRow {
    verifier: String,
    purpose: String,
    user_id: Option<String>,
    redirect_uri: String,
    next: String,
    #[serde(default)]
    invite_code: Option<String>,
}

#[derive(Deserialize)]
struct PendingRow {
    id: String,
    github_id: u64,
    login: String,
    email: String,
    kind: String,
    suggestion: Option<String>,
    tokens: Option<String>,
    next: String,
    #[serde(default)]
    invite_code: Option<String>,
}

#[derive(Deserialize)]
struct AccountRow {
    user_id: String,
    github_id: u64,
    login: String,
    tokens: Option<String>,
    created_at: String,
}

/// What a token is sealed to: the account row it belongs to.
fn bound(user_id: &str) -> String {
    format!("github:{user_id}")
}

impl Identity {
    fn sealer(&self) -> Option<Sealer> {
        Sealer::new(&self.env.secret("IDENTITY_KEY").ok()?.to_string())
    }

    fn seal_tokens(&self, tokens: &Tokens, bound_to: &str) -> Option<String> {
        Some(self.sealer()?.seal(&serde_json::to_string(tokens).ok()?, bound_to))
    }

    fn open_tokens(&self, sealed: Option<&str>, bound_to: &str) -> Option<Tokens> {
        let plain = self.sealer()?.open(sealed?, bound_to)?;
        serde_json::from_str(&plain).ok()
    }

    pub fn github_enabled(&self) -> bool {
        client(&self.env).is_some()
    }

    pub async fn github_start(&self, a: GithubStartArgs) -> Result<Outcome<GithubStart>> {
        let Some(client) = client(&self.env) else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_SET_UP));
        };
        let redirect = Url::parse(&a.redirect_uri).ok();
        if !redirect.is_some_and(|url| url.scheme() == "https" || url.host_str() == Some("localhost")) {
            return Ok(Outcome::fail(FailureCode::Invalid, "The callback must be an https address."));
        }
        let user_id = match a.purpose {
            GithubPurpose::Link => match &a.user {
                Some(user) => Some(user.id.clone()),
                None => return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to g1t first.")),
            },
            GithubPurpose::SignIn => None,
        };
        let state = crypto::random_hex(32);
        let verifier = new_verifier();
        self.db
            .prepare(format!(
                "INSERT INTO github_states (id, verifier, purpose, user_id, redirect_uri, next, invite_code, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, {})",
                sql_after(STATE_TTL_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&state).into(),
                verifier.as_str().into(),
                a.purpose.as_str().into(),
                user_id.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                a.redirect_uri.as_str().into(),
                a.next.as_str().into(),
                a.invite_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|code| !code.is_empty())
                    .map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
            ])?
            .run()
            .await?;
        // Old states that were never used go now and then.
        self.db
            .prepare(format!("DELETE FROM github_states WHERE expires_at < {SQL_NOW}"))
            .run()
            .await?;
        Ok(Outcome::Ok(GithubStart {
            authorize_url: authorize_url(&client.id, &a.redirect_uri, &state, &pkce_challenge(&verifier)),
            state,
        }))
    }

    async fn account_by_github(&self, github_id: u64) -> Result<Option<AccountRow>> {
        self.db
            .prepare("SELECT * FROM github_accounts WHERE github_id = ?")
            .bind(&[(github_id as f64).into()])?
            .first::<AccountRow>(None)
            .await
    }

    async fn account_of(&self, user_id: &str) -> Result<Option<AccountRow>> {
        self.db
            .prepare("SELECT * FROM github_accounts WHERE user_id = ?")
            .bind(&[user_id.into()])?
            .first::<AccountRow>(None)
            .await
    }

    /// Whether `username` could be registered now.
    async fn username_free(&self, username: &str) -> Result<bool> {
        if !is_valid_namespace(username) {
            return Ok(false);
        }
        let taken = self
            .db
            .prepare("SELECT username FROM users WHERE username = ?1 UNION ALL SELECT slug FROM workspaces WHERE slug = ?1")
            .bind(&[username.into()])?
            .first::<Value>(None)
            .await?;
        Ok(taken.is_none() && !self.slug_held(username).await? && !self.slug_deleted(username).await?)
    }

    /// Whether an account has confirmed one of these addresses, any of its
    /// addresses, not only its primary (emails.rs). An address someone
    /// added and never confirmed does not count: GitHub has confirmed it,
    /// so a new account made with it wins it (first to confirm keeps it).
    async fn email_taken(&self, emails: &[String]) -> Result<bool> {
        for email in emails {
            if self.user_with_verified_email(email).await?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Links a GitHub account to a user, keeping its tokens.
    async fn link(&self, user_id: &str, github_id: u64, login: &str, tokens: Option<&Tokens>) -> Result<()> {
        let sealed = tokens.and_then(|tokens| self.seal_tokens(tokens, &bound(user_id)));
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO github_accounts (user_id, github_id, login, tokens, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (user_id) DO UPDATE SET login = excluded.login,
                   tokens = COALESCE(excluded.tokens, github_accounts.tokens), updated_at = excluded.updated_at",
            )
            .bind(&[
                user_id.into(),
                (github_id as f64).into(),
                login.into(),
                sealed.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    async fn user_by_id(&self, user_id: &str) -> Result<Option<User>> {
        self.find_user(
            "SELECT id, username, email_verified_at IS NOT NULL AS verified, avatar FROM users WHERE id = ?",
            user_id,
        )
        .await
    }

    /// Keeps a GitHub sign-in that has to wait on the person.
    async fn hold(
        &self,
        user: &GithubUser,
        kind: &str,
        suggestion: Option<&str>,
        tokens: &Tokens,
        next: &str,
        invite_code: Option<&str>,
    ) -> Result<String> {
        let pending = crypto::random_hex(32);
        let id = crypto::sha256_hex(&pending);
        let sealed = self.seal_tokens(tokens, &id);
        self.db
            .prepare(format!(
                "INSERT INTO github_pending (id, github_id, login, email, kind, suggestion, tokens, next, invite_code, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, {})",
                sql_after(PENDING_TTL_SECONDS)
            ))
            .bind(&[
                id.as_str().into(),
                (user.id as f64).into(),
                user.login.as_str().into(),
                user.emails.first().map(String::as_str).unwrap_or_default().into(),
                kind.into(),
                suggestion.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                sealed.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                next.into(),
                invite_code.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
            ])?
            .run()
            .await?;
        Ok(pending)
    }

    async fn pending_row(&self, pending: &str) -> Result<Option<PendingRow>> {
        self.db
            .prepare(format!("SELECT * FROM github_pending WHERE id = ? AND expires_at > {SQL_NOW}"))
            .bind(&[crypto::sha256_hex(pending).into()])?
            .first::<PendingRow>(None)
            .await
    }

    async fn drop_pending(&self, id: &str) -> Result<()> {
        self.db.prepare("DELETE FROM github_pending WHERE id = ?").bind(&[id.into()])?.run().await?;
        self.db
            .prepare(format!("DELETE FROM github_pending WHERE expires_at < {SQL_NOW}"))
            .run()
            .await?;
        Ok(())
    }

    /// Makes an account from a GitHub sign-in: its email is GitHub's
    /// verified primary, confirmed already, and it has no password.
    async fn create_from_github(
        &self,
        username: &str,
        email: &str,
        github_id: u64,
        login: &str,
        tokens: Option<&Tokens>,
        invite_code: Option<&str>,
    ) -> Result<Outcome<User>> {
        // Made where every account is made, so the invite is checked and
        // spent in one place, with registration's rules (invites.rs).
        let user = match self
            .create_account(crate::invites::NewAccount {
                username,
                email,
                password_hash: "",
                verified: true,
                invite_code,
                client: None,
            })
            .await?
        {
            Outcome::Ok(user) => user,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        self.link(&user.id, github_id, login, tokens).await?;
        self.announce_user(username, Some(&user.id)).await;
        Ok(Outcome::Ok(user))
    }

    /// Whether new accounts need an invite code: REGISTRATION_MODE, read
    /// by invites.rs. Unset means they do.
    fn github_invites_required(&self) -> bool {
        self.invites_required()
    }

    pub async fn github_finish(&self, a: GithubFinishArgs) -> Result<Outcome<GithubFinished>> {
        let Some(client) = client(&self.env) else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_SET_UP));
        };
        // Single use: the state is gone whatever happens next.
        let state = self
            .db
            .prepare(format!(
                "DELETE FROM github_states WHERE id = ? AND expires_at > {SQL_NOW}
                 RETURNING verifier, purpose, user_id, redirect_uri, next, invite_code"
            ))
            .bind(&[crypto::sha256_hex(&a.state).into()])?
            .first::<StateRow>(None)
            .await?;
        let Some(state) = state else {
            return Ok(Outcome::fail(FailureCode::Invalid, "This sign-in link has expired. Start again."));
        };
        let grant = serde_json::json!({
            "code": a.code,
            "redirect_uri": state.redirect_uri,
            "code_verifier": state.verifier,
        });
        let Some(tokens) = token_request(&client, grant).await? else {
            return Ok(Outcome::fail(FailureCode::Invalid, TRY_AGAIN));
        };
        let Some(mut github) = read_user(&tokens.access_token).await? else {
            return Ok(Outcome::fail(FailureCode::Invalid, TRY_AGAIN));
        };
        // An invite sent to one address makes the account with that one,
        // when GitHub has confirmed it too; otherwise the invite is not
        // this GitHub account's to use.
        let bound = match state.invite_code.as_deref() {
            Some(code) => self.bound_email_of(code).await?,
            None => None,
        };
        let bound_elsewhere = bound.as_deref().is_some_and(|bound| !put_first(&mut github.emails, bound));
        let purpose = if state.purpose == "link" { GithubPurpose::Link } else { GithubPurpose::SignIn };
        let linked = self.account_by_github(github.id).await?;
        let asking_has_other = match &state.user_id {
            Some(user_id) => self.account_of(user_id).await?.is_some_and(|row| row.github_id != github.id),
            None => false,
        };
        let suggestion = suggest_username(&github.login);
        let facts = Facts {
            purpose: Some(purpose),
            asking: state.user_id.as_deref(),
            asking_has_other,
            linked_to: linked.as_ref().map(|row| row.user_id.as_str()),
            has_verified_email: !github.emails.is_empty(),
            email_taken: linked.is_none() && self.email_taken(&github.emails).await?,
            suggestion_free: linked.is_none() && self.username_free(&suggestion).await?,
            suggestion: suggestion.clone(),
            invite_missing: self.github_invites_required() && state.invite_code.is_none(),
        };
        let next = state.next;
        let decision = decide(&facts);
        if bound_elsewhere && matches!(decision, Decision::Create(_) | Decision::NeedsUsername(_)) {
            return Ok(Outcome::fail(FailureCode::Conflict, INVITE_FOR_ANOTHER_ADDRESS));
        }
        Ok(match decision {
            Decision::Refuse(reason) => Outcome::fail(FailureCode::Conflict, reason),
            Decision::Link(user_id) => {
                self.link(&user_id, github.id, &github.login, Some(&tokens)).await?;
                if let Some(user) = self.user_by_id(&user_id).await? {
                    self.audit_github(&user, "github.linked", format!("Linked GitHub account @{}", github.login)).await;
                }
                Outcome::Ok(GithubFinished::Linked { login: github.login, next })
            }
            Decision::SignIn(user_id) => {
                self.link(&user_id, github.id, &github.login, Some(&tokens)).await?;
                let Some(user) = self.user_by_id(&user_id).await? else {
                    return Ok(Outcome::fail(FailureCode::NotFound, TRY_AGAIN));
                };
                self.audit_github(&user, "github.sign_in", format!("Signed in with GitHub (@{})", github.login)).await;
                self.signed_in(user, false, next).await?
            }
            Decision::NeedsLink => {
                let pending = self.hold(&github, "link", None, &tokens, &next, None).await?;
                Outcome::Ok(GithubFinished::NeedsLink { pending, login: github.login, next })
            }
            Decision::Create(username) => {
                let email = github.emails[0].clone();
                let invite = state.invite_code.as_deref();
                match self.create_from_github(&username, &email, github.id, &github.login, Some(&tokens), invite).await? {
                    Outcome::Ok(user) => self.signed_in(user, true, next).await?,
                    // A code that did not pass: the person can enter another.
                    Outcome::Fail(_) => {
                        let pending = self.hold(&github, "username", Some(&username), &tokens, &next, None).await?;
                        Outcome::Ok(GithubFinished::NeedsUsername {
                            pending,
                            login: github.login,
                            suggestion: username,
                            next,
                            invite_required: self.github_invites_required(),
                        })
                    }
                }
            }
            Decision::NeedsUsername(suggestion) => {
                let invite = state.invite_code.as_deref();
                let pending = self.hold(&github, "username", Some(&suggestion), &tokens, &next, invite).await?;
                Outcome::Ok(GithubFinished::NeedsUsername {
                    pending,
                    login: github.login,
                    suggestion,
                    next,
                    invite_required: self.github_invites_required() && invite.is_none(),
                })
            }
        })
    }

    async fn signed_in(&self, user: User, created: bool, next: String) -> Result<Outcome<GithubFinished>> {
        Ok(match self.start_session(user).await? {
            Outcome::Ok(signed_in) => Outcome::Ok(GithubFinished::SignedIn { signed_in, created, next }),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    pub async fn github_pending(&self, a: GithubPendingArgs) -> Result<Outcome<GithubPending>> {
        let Some(row) = self.pending_row(&a.pending).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "This GitHub sign-in has expired. Start again."));
        };
        Ok(Outcome::Ok(GithubPending {
            invite_required: row.kind == "username" && self.github_invites_required() && row.invite_code.is_none(),
            login: row.login,
            kind: row.kind,
            suggestion: row.suggestion,
            next: row.next,
        }))
    }

    pub async fn github_sign_up(&self, a: GithubSignUpArgs) -> Result<Outcome<SignedIn>> {
        let Some(row) = self.pending_row(&a.pending).await?.filter(|row| row.kind == "username") else {
            return Ok(Outcome::fail(FailureCode::NotFound, "This GitHub sign-in has expired. Start again."));
        };
        let Some(username) = claimable_namespace(&a.username) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Usernames use lowercase letters, digits and single hyphens, up to 39 characters, and cannot be a reserved word.",
            ));
        };
        if !self.username_free(&username).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "That username is taken. Choose another."));
        }
        // Checked again: either could have changed while the person chose.
        if self.account_by_github(row.github_id).await?.is_some() || self.email_taken(std::slice::from_ref(&row.email)).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "An account already uses this GitHub account or email. Sign in instead."));
        }
        let tokens = self.open_tokens(row.tokens.as_deref(), &row.id);
        let given = a.invite_code.as_deref().map(str::trim).filter(|code| !code.is_empty());
        let invite = given.or(row.invite_code.as_deref());
        let user = match self
            .create_from_github(&username, &row.email, row.github_id, &row.login, tokens.as_ref(), invite)
            .await?
        {
            Outcome::Ok(user) => user,
            Outcome::Fail(refused) => return Ok(Outcome::Fail(refused)),
        };
        self.drop_pending(&row.id).await?;
        self.start_session(user).await
    }

    /// Links a held GitHub sign-in to the account the person then signed in
    /// to: they have proved both.
    pub async fn github_claim(&self, a: GithubClaimArgs) -> Result<Outcome<GithubAccount>> {
        let Some(row) = self.pending_row(&a.pending).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "This GitHub sign-in has expired. Start again."));
        };
        if let Some(linked) = self.account_by_github(row.github_id).await?
            && linked.user_id != a.user.id
        {
            return Ok(Outcome::fail(FailureCode::Conflict, "That GitHub account is linked to another g1t account."));
        }
        if self.account_of(&a.user.id).await?.is_some_and(|linked| linked.github_id != row.github_id) {
            return Ok(Outcome::fail(FailureCode::Conflict, "Your account is linked to another GitHub account. Unlink it first."));
        }
        let tokens = self.open_tokens(row.tokens.as_deref(), &row.id);
        self.link(&a.user.id, row.github_id, &row.login, tokens.as_ref()).await?;
        self.drop_pending(&row.id).await?;
        self.audit_github(&a.user, "github.linked", format!("Linked GitHub account @{}", row.login)).await;
        Ok(Outcome::Ok(GithubAccount {
            github_id: row.github_id,
            login: row.login,
            linked_at: rfc3339(now_ms()),
            authorized: tokens.is_some(),
        }))
    }

    async fn has_password(&self, user_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS yes FROM users WHERE id = ? AND password_hash LIKE 'pbkdf2$%'")
            .bind(&[user_id.into()])?
            .first::<Value>(None)
            .await?
            .is_some())
    }

    pub async fn github_account(&self, a: UserArgs) -> Result<GithubAccountView> {
        let row = self.account_of(&a.user.id).await?;
        Ok(GithubAccountView {
            enabled: self.github_enabled(),
            account: row.map(|row| GithubAccount {
                authorized: self.open_tokens(row.tokens.as_deref(), &bound(&row.user_id)).is_some(),
                github_id: row.github_id,
                login: row.login,
                linked_at: row.created_at,
            }),
            has_password: self.has_password(&a.user.id).await?,
        })
    }

    pub async fn github_unlink(&self, a: UserArgs) -> Result<Outcome<bool>> {
        let Some(row) = self.account_of(&a.user.id).await? else {
            return Ok(Outcome::Ok(false));
        };
        if !self.has_password(&a.user.id).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "GitHub is the only way you sign in. Set a password first: sign out and use Forgot your password.",
            ));
        }
        self.db
            .prepare("DELETE FROM github_accounts WHERE user_id = ?")
            .bind(&[a.user.id.as_str().into()])?
            .run()
            .await?;
        // Best effort: also end g1t's authorization on GitHub's side.
        if let (Some(client), Some(tokens)) = (client(&self.env), self.open_tokens(row.tokens.as_deref(), &bound(&row.user_id))) {
            let _ = revoke_grant(&client, &tokens.access_token).await;
        }
        self.audit_github(&a.user, "github.unlinked", format!("Unlinked GitHub account @{}", row.login)).await;
        Ok(Outcome::Ok(true))
    }

    /// A working user token for the person, refreshed when it is about to
    /// expire. For the integrations service, to list installations.
    pub async fn github_user_token(&self, a: GithubUserTokenArgs) -> Result<Outcome<String>> {
        const RELINK: &str = "Link your GitHub account again in your settings: g1t's access to it has ended.";
        let Some(row) = self.account_of(&a.user_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Link your GitHub account first."));
        };
        let Some(tokens) = self.open_tokens(row.tokens.as_deref(), &bound(&row.user_id)) else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, RELINK));
        };
        let now = now_ms();
        if tokens.fresh(now) {
            return Ok(Outcome::Ok(tokens.access_token));
        }
        let (Some(client), true) = (client(&self.env), tokens.refreshable(now)) else {
            self.forget_tokens(&row.user_id).await?;
            return Ok(Outcome::fail(FailureCode::Unauthenticated, RELINK));
        };
        let grant = serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": tokens.refresh_token,
        });
        let Some(refreshed) = token_request(&client, grant).await? else {
            self.forget_tokens(&row.user_id).await?;
            return Ok(Outcome::fail(FailureCode::Unauthenticated, RELINK));
        };
        let sealed = self.seal_tokens(&refreshed, &bound(&row.user_id));
        self.db
            .prepare(format!("UPDATE github_accounts SET tokens = ?, updated_at = {SQL_NOW} WHERE user_id = ?"))
            .bind(&[
                sealed.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                row.user_id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(refreshed.access_token))
    }

    async fn forget_tokens(&self, user_id: &str) -> Result<()> {
        self.db
            .prepare("UPDATE github_accounts SET tokens = NULL WHERE user_id = ?")
            .bind(&[user_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// The person revoked g1t's authorization on GitHub: its tokens go.
    /// The link stays, so they can still sign in with GitHub.
    pub async fn github_revoked(&self, a: GithubRevokedArgs) -> Result<u32> {
        let changed = self
            .db
            .prepare("UPDATE github_accounts SET tokens = NULL WHERE github_id = ? RETURNING user_id")
            .bind(&[(a.github_id as f64).into()])?
            .all()
            .await?
            .results::<Value>()?;
        Ok(changed.len() as u32)
    }

    /// The g1t usernames of linked GitHub accounts, by GitHub id, for
    /// showing who wrote what was imported.
    pub async fn github_usernames(&self, a: GithubUsernamesArgs) -> Result<std::collections::HashMap<String, String>> {
        #[derive(Deserialize)]
        struct Named {
            github_id: u64,
            username: String,
        }
        let ids: Vec<u64> = a.github_ids.into_iter().take(100).collect();
        let mut names = std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(names);
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let bind: Vec<worker::wasm_bindgen::JsValue> = ids.iter().map(|id| (*id as f64).into()).collect();
        let rows = self
            .db
            .prepare(format!(
                "SELECT github_accounts.github_id, users.username FROM github_accounts
                 JOIN users ON users.id = github_accounts.user_id WHERE github_id IN ({marks})"
            ))
            .bind(&bind)?
            .all()
            .await?
            .results::<Named>()?;
        for row in rows {
            names.insert(row.github_id.to_string(), row.username);
        }
        Ok(names)
    }

    /// Recorded in the audit log of every workspace the person belongs to,
    /// which is where their workspaces' owners look.
    async fn audit_github(&self, user: &User, action: &str, message: String) {
        let (Ok(events), Ok(memberships)) = (self.env.service("EVENTS"), self.memberships(&user.id).await) else {
            return;
        };
        let entries: Vec<NewAuditEntry> = memberships
            .into_iter()
            .map(|membership| NewAuditEntry {
                actor: AuditActor::of(user),
                action: action.to_owned(),
                surface: Surface::Web,
                target: AuditTarget {
                    workspace: membership.slug,
                    ..AuditTarget::default()
                },
                outcome: AuditOutcome::Allowed,
                rule: "github".to_owned(),
                result: Some("ok".to_owned()),
                message: Some(message.clone()),
                request_id: new_id("req", now_ms()),
            })
            .collect();
        if entries.is_empty() {
            return;
        }
        let recorded: Result<u32> = g1t_kit::call(&events, "audit_record", &RecordAuditArgs { entries }).await;
        if let Err(error) = recorded {
            worker::console_error!("{action} not recorded: {error}");
        }
    }
}

/// `DELETE /applications/{client_id}/grant`, with the client's own
/// credentials.
async fn revoke_grant(client: &Client, access_token: &str) -> Result<()> {
    let headers = Headers::new();
    headers.set("user-agent", "g1t (+https://g1t.sh)")?;
    headers.set("accept", "application/vnd.github+json")?;
    headers.set("content-type", "application/json")?;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", client.id, client.secret));
    headers.set("authorization", &format!("Basic {basic}"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Delete)
        .with_headers(headers)
        .with_body(Some(serde_json::json!({ "access_token": access_token }).to_string().into()));
    let url = format!("{API}/applications/{}/grant", client.id);
    Fetch::Request(Request::new_with_init(&url, &init)?).send().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_rfc_7636s() {
        // RFC 7636, appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let verifier = new_verifier();
        assert_eq!(verifier.len(), 43);
        assert_ne!(verifier, new_verifier());
    }

    #[test]
    fn the_authorize_url_carries_state_and_challenge() {
        let url = authorize_url("Iv23liZS94alfjIUn1eW", "https://g1t.sh/auth/github/callback", "abc", "xyz");
        let parsed = Url::parse(&url).unwrap();
        let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(parsed.host_str(), Some("github.com"));
        assert_eq!(query["redirect_uri"], "https://g1t.sh/auth/github/callback");
        assert_eq!(query["state"], "abc");
        assert_eq!(query["code_challenge"], "xyz");
        assert_eq!(query["code_challenge_method"], "S256");
    }

    fn email(address: &str, primary: bool, verified: bool) -> GithubEmail {
        GithubEmail {
            email: address.to_owned(),
            primary,
            verified,
        }
    }

    #[test]
    fn only_verified_emails_count_primary_first() {
        let emails = [
            email("unverified@example.com", false, false),
            email("Work@Example.com", false, true),
            email("1+me@users.noreply.github.com", false, true),
            email("me@example.com", true, true),
        ];
        assert_eq!(verified_emails(&emails), vec!["me@example.com", "work@example.com"]);
        assert!(verified_emails(&[email("primary@example.com", true, false)]).is_empty());
    }

    #[test]
    fn usernames_come_from_logins() {
        assert_eq!(suggest_username("Octo-Cat"), "octo-cat");
        assert_eq!(suggest_username("a_b..c"), "a-b-c");
        assert_eq!(suggest_username("-x-"), "x");
        assert_eq!(suggest_username(&"a".repeat(50)).len(), 39);
    }

    #[test]
    fn a_login_named_like_g1t_gets_a_name_of_its_own() {
        assert_eq!(suggest_username("g1t"), "g1t-gh");
        assert_eq!(suggest_username("G1T"), "g1t-gh");
        assert_eq!(suggest_username("g1t-agent"), "g1t-agent-gh");
        assert_eq!(suggest_username("G1t_Agent"), "g1t-agent-gh");
        assert_eq!(suggest_username("api"), "api-gh");
        assert!(is_valid_namespace(&suggest_username("g1t")));
        assert_eq!(suggest_username("g1t-fan"), "g1t-fan");
        // So signing up goes ahead, rather than failing on the login.
        let facts = Facts { suggestion: suggest_username("g1t"), ..facts() };
        assert_eq!(decide(&facts), Decision::Create("g1t-gh".to_owned()));
    }

    #[test]
    fn a_chosen_username_cannot_be_g1ts() {
        // What github_sign_up takes from the form.
        for name in ["g1t", " G1T ", "g1t-agent", "G1T-AGENT"] {
            assert_eq!(claimable_namespace(name), None, "{name}");
        }
        assert_eq!(claimable_namespace(" Octo-Cat ").as_deref(), Some("octo-cat"));
    }

    fn facts() -> Facts<'static> {
        Facts {
            purpose: Some(GithubPurpose::SignIn),
            has_verified_email: true,
            suggestion: "octocat".to_owned(),
            suggestion_free: true,
            ..Facts::default()
        }
    }

    #[test]
    fn a_linked_account_signs_in() {
        let facts = Facts { linked_to: Some("usr_1"), email_taken: true, ..facts() };
        assert_eq!(decide(&facts), Decision::SignIn("usr_1".to_owned()));
    }

    #[test]
    fn a_matching_email_is_never_linked_silently() {
        let facts = Facts { email_taken: true, ..facts() };
        assert_eq!(decide(&facts), Decision::NeedsLink);
    }

    #[test]
    fn a_new_person_gets_their_login_or_chooses() {
        assert_eq!(decide(&facts()), Decision::Create("octocat".to_owned()));
        let taken = Facts { suggestion_free: false, ..facts() };
        assert_eq!(decide(&taken), Decision::NeedsUsername("octocat".to_owned()));
        let no_email = Facts { has_verified_email: false, ..facts() };
        assert!(matches!(decide(&no_email), Decision::Refuse(_)));
    }

    #[test]
    fn an_invite_for_one_address_makes_the_account_with_it() {
        let mut emails = vec!["ada@work.example".to_owned(), "ada@home.example".to_owned()];
        assert!(put_first(&mut emails, "Ada@Home.example"));
        assert_eq!(emails, ["ada@home.example", "ada@work.example"]);
        assert!(!put_first(&mut emails, "eve@example.com"));
        assert_eq!(emails, ["ada@home.example", "ada@work.example"]);
    }

    #[test]
    fn an_invite_only_g1t_waits_for_a_code() {
        let waiting = Facts { invite_missing: true, ..facts() };
        assert_eq!(decide(&waiting), Decision::NeedsUsername("octocat".to_owned()));
        // Existing accounts sign in and link without one.
        let linked = Facts { invite_missing: true, linked_to: Some("usr_1"), ..facts() };
        assert_eq!(decide(&linked), Decision::SignIn("usr_1".to_owned()));
        let matching = Facts { invite_missing: true, email_taken: true, ..facts() };
        assert_eq!(decide(&matching), Decision::NeedsLink);
    }

    #[test]
    fn linking_is_for_the_account_that_asked() {
        let link = Facts { purpose: Some(GithubPurpose::Link), asking: Some("usr_1"), ..facts() };
        assert_eq!(decide(&link), Decision::Link("usr_1".to_owned()));
        let elsewhere = Facts { linked_to: Some("usr_2"), ..link };
        assert!(matches!(decide(&elsewhere), Decision::Refuse(_)));
        let other = Facts { purpose: Some(GithubPurpose::Link), asking: Some("usr_1"), asking_has_other: true, ..facts() };
        assert!(matches!(decide(&other), Decision::Refuse(_)));
        let nobody = Facts { purpose: Some(GithubPurpose::Link), ..facts() };
        assert!(matches!(decide(&nobody), Decision::Refuse(_)));
    }

    #[test]
    fn tokens_expire_and_refresh() {
        let answer = serde_json::json!({
            "access_token": format!("ghu_{}", "a".repeat(516)),
            "expires_in": 28800,
            "refresh_token": "ghr_x",
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        });
        let tokens = tokens_from(&answer, 1_000).unwrap();
        assert_eq!(tokens.access_token.len(), 520);
        assert_eq!(tokens.access_expires_at, Some(1_000 + 28_800_000));
        assert!(tokens.fresh(1_000));
        assert!(!tokens.fresh(1_000 + 28_800_000 - 60_000));
        assert!(tokens.refreshable(1_000 + 28_800_000));
        assert!(tokens_from(&serde_json::json!({ "error": "bad_verification_code" }), 0).is_none());
        // Tokens that never expire, as when expiry is turned off on the app.
        let lasting = tokens_from(&serde_json::json!({ "access_token": "gho_x" }), 0).unwrap();
        assert!(lasting.fresh(u64::MAX / 2));
        assert!(!lasting.refreshable(0));
    }

    #[test]
    fn a_long_token_survives_sealing() {
        let sealer = Sealer::new("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f").unwrap();
        let tokens = Tokens {
            access_token: format!("ghs_{}", "z".repeat(516)),
            access_expires_at: None,
            refresh_token: None,
            refresh_expires_at: None,
        };
        let sealed = sealer.seal(&serde_json::to_string(&tokens).unwrap(), &bound("usr_1"));
        let opened: Tokens = serde_json::from_str(&sealer.open(&sealed, &bound("usr_1")).unwrap()).unwrap();
        assert_eq!(opened, tokens);
        assert!(sealer.open(&sealed, &bound("usr_2")).is_none());
    }
}
