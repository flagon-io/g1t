//! A person's email addresses: adding, confirming, choosing the primary and
//! the backup, removing, keeping them private, and finding whose an address
//! is.
//!
//! `user_emails` holds every address. `users.primary_email_id` names the
//! primary, and `users.email` and `users.email_verified_at` are kept as a
//! copy of it (other code reads them, and "the account is confirmed" means
//! its primary is). Every change to the primary here writes all three.
//!
//! A confirmed address belongs to one account: a unique index on confirmed
//! rows makes sure of it. Unconfirmed rows may repeat across accounts; the
//! first account to follow its confirmation link keeps the address, in one
//! transaction that confirms its row only if nobody else's is confirmed,
//! and then drops everyone else's unconfirmed row for it. An account whose
//! primary was dropped that way (it never confirmed it) is left without one
//! until it confirms another address, which becomes primary on its own.
//!
//! Sensitive changes (adding, removing, primary, backup) need proof that it
//! is the person (`security.rs`), are written to their security log, are
//! announced as `user.email_*` events, and are told to every confirmed
//! address, the removed one included.
//!
//! A confirmation email carries a six-digit code and a link, either one
//! enough. Both live in one `email_tokens` row, bound to the account and
//! the address: the link's token as its id (a SHA-256), the code as an
//! HMAC under IDENTITY_KEY ([`crypto::code_hash`]). Using either deletes
//! the row, so the other stops working too, and sending another email for
//! the address deletes the rows before it. Both work for
//! [`CONFIRM_TTL_SECONDS`]. Wrong codes are throttled per account and per
//! client (throttle.rs).
//!
//! An account with no confirmed primary is pending: the site, the API and
//! git let it do nothing but confirm its address, change it, or sign out.
//! The invite it signed up with was spent then, and what it gives (its
//! workspace) is applied in the same transaction that confirms the address
//! (invites.rs, `apply_invite_statements`).

use std::collections::HashMap;

use g1t_contracts::account_deletion::{GHOST_ID, GHOST_USERNAME};
use g1t_contracts::accounts::*;
use g1t_contracts::events::UserEmailChanged;
use g1t_contracts::identity::{UserArgs, UsernameArgs};
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::email::Confirming;
use crate::invites::AwaitingJoin;
use crate::security::{PEOPLE_ONLY, is_person};
use crate::throttle::{self, CODE_ACCOUNT, CODE_CLIENT, CODE_THROTTLED, CONFIRM_ACCOUNT};
use crate::{Identity, crypto, email};

/// The one answer to a code that does not confirm anything: wrong, used,
/// expired, or for an address no longer on the account.
pub const WRONG_CODE: &str = "That code is not right, or it has expired. Check the latest email from g1t, or send a new code.";

/// The answer when a confirmation email was sent less than a minute ago.
pub const SENT_RECENTLY: &str = "We sent an email less than a minute ago. Check your inbox, then try again.";

/// One row of `user_emails`.
#[derive(Clone, Debug, Deserialize)]
pub struct EmailRow {
    pub id: String,
    pub email: String,
    pub display: String,
    pub verified_at: Option<String>,
    pub sent_at: Option<String>,
    pub created_at: String,
}

/// What `users` says about a person's addresses.
#[derive(Debug, Deserialize)]
struct AccountRow {
    id: String,
    username: String,
    primary_email_id: Option<String>,
    backup_email_id: Option<String>,
    private_email: u8,
    block_private_pushes: u8,
    #[serde(default)]
    created_at: String,
}

const ACCOUNT_COLUMNS: &str =
    "id, username, primary_email_id, backup_email_id, private_email, block_private_pushes, created_at";

/// The order addresses are shown in: the primary, confirmed ones, the rest;
/// oldest first within each.
fn sorted(mut rows: Vec<EmailRow>, primary: Option<&str>) -> Vec<EmailRow> {
    rows.sort_by(|a, b| {
        let rank = |row: &EmailRow| (Some(row.id.as_str()) != primary, row.verified_at.is_none());
        rank(a).cmp(&rank(b)).then_with(|| a.created_at.cmp(&b.created_at)).then_with(|| a.id.cmp(&b.id))
    });
    rows
}

fn states(rows: &[EmailRow], primary: Option<&str>) -> Vec<EmailState> {
    rows.iter()
        .map(|row| EmailState {
            email: row.email.clone(),
            verified: row.verified_at.is_some(),
            primary: Some(row.id.as_str()) == primary,
        })
        .collect()
}

/// The address commits g1t makes for a person carry: their noreply address
/// while they keep their address private or have no confirmed primary.
fn commit_email(private: bool, primary: Option<&EmailRow>, noreply: &str) -> String {
    match primary {
        Some(row) if !private && row.verified_at.is_some() => row.email.clone(),
        _ => noreply.to_owned(),
    }
}

fn view(account: &AccountRow, rows: Vec<EmailRow>) -> AccountEmails {
    let primary = account.primary_email_id.as_deref();
    let rows = sorted(rows, primary);
    let noreply = noreply_address(&account.id, &account.username);
    let private = account.private_email != 0;
    let commit = commit_email(private, rows.iter().find(|row| Some(row.id.as_str()) == primary), &noreply);
    AccountEmails {
        emails: rows
            .into_iter()
            .map(|row| AccountEmail {
                primary: Some(row.id.as_str()) == primary,
                backup: Some(row.id.as_str()) == account.backup_email_id.as_deref(),
                verified: row.verified_at.is_some(),
                email: row.display,
                created_at: row.created_at,
                verified_at: row.verified_at,
            })
            .collect(),
        private_email: private,
        block_private_pushes: account.block_private_pushes != 0,
        noreply,
        commit_email: commit,
        limit: MAX_EMAILS as u32,
    }
}

/// Whether pushes by this person are checked for their addresses: only
/// while the address is private and they asked for pushes to be blocked.
fn guards_pushes(account: &AccountRow) -> bool {
    account.private_email != 0 && account.block_private_pushes != 0
}

/// Whether a confirmation link may be sent again to an address last sent
/// one at `sent_at`, at `now_ms`.
pub fn may_resend(sent_at: Option<&str>, now_ms: u64) -> bool {
    !is_recent(sent_at, now_ms, RESEND_SECONDS)
}

impl Identity {
    async fn account_row(&self, user_id: &str) -> Result<Option<AccountRow>> {
        self.db
            .prepare(format!("SELECT {ACCOUNT_COLUMNS} FROM users WHERE id = ?"))
            .bind(&[user_id.into()])?
            .first::<AccountRow>(None)
            .await
    }

    pub async fn email_rows(&self, user_id: &str) -> Result<Vec<EmailRow>> {
        self.db
            .prepare(
                "SELECT id, email, display, verified_at, sent_at, created_at FROM user_emails
                 WHERE user_id = ? ORDER BY created_at, id",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<EmailRow>()
    }

    async fn emails_view(&self, user_id: &str) -> Result<Outcome<AccountEmails>> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let rows = self.email_rows(user_id).await?;
        Ok(Outcome::Ok(view(&account, rows)))
    }

    /// A person's confirmed addresses, lowercased, the primary first.
    pub async fn verified_emails(&self, user_id: &str) -> Result<Vec<String>> {
        let account = self.account_row(user_id).await?;
        let primary = account.as_ref().and_then(|account| account.primary_email_id.as_deref());
        Ok(sorted(self.email_rows(user_id).await?, primary)
            .into_iter()
            .filter(|row| row.verified_at.is_some())
            .map(|row| row.email)
            .collect())
    }

    /// The account that has confirmed `email`, by id. The one helper every
    /// "does this address belong to someone" question goes through (signing
    /// in with GitHub, invites, password resets, signing in by email).
    pub async fn user_with_verified_email(&self, email: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Owner {
            user_id: String,
        }
        let Some(email) = normalize_email(email) else {
            return Ok(None);
        };
        Ok(self
            .db
            .prepare("SELECT user_id FROM user_emails WHERE email = ? AND verified_at IS NOT NULL")
            .bind(&[email.as_str().into()])?
            .first::<Owner>(None)
            .await?
            .map(|owner| owner.user_id))
    }

    /// Whether `email` is any account's: confirmed, or the unconfirmed
    /// primary a new account signed up with.
    pub async fn email_in_use(&self, email: &str) -> Result<bool> {
        let Some(email) = normalize_email(email) else {
            return Ok(false);
        };
        let found = self
            .db
            .prepare(
                "SELECT e.id FROM user_emails e JOIN users u ON u.id = e.user_id
                 WHERE e.email = ?1 AND (e.verified_at IS NOT NULL OR u.primary_email_id = e.id) LIMIT 1",
            )
            .bind(&[email.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        Ok(found.is_some())
    }

    /// `list_emails`.
    pub async fn list_emails(&self, a: UserArgs) -> Result<Outcome<AccountEmails>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        self.emails_view(&a.user.id).await
    }

    /// The key confirmation codes are kept under: IDENTITY_KEY, or none in
    /// a development setup without one.
    fn code_key(&self) -> Vec<u8> {
        self.env.secret("IDENTITY_KEY").map(|key| key.to_string().into_bytes()).unwrap_or_default()
    }

    /// Stores a new code and link for one address, ending any sent before
    /// for it, and emails them.
    async fn send_confirmation(&self, user_id: &str, username: &str, row: &EmailRow, confirming: Confirming) -> Result<()> {
        let token = crypto::random_hex(32);
        let code = crypto::random_digits(CONFIRM_CODE_DIGITS);
        let id = crypto::sha256_hex(&token);
        let code_hash = crypto::code_hash(&self.code_key(), &id, &code);
        self.db
            .batch(vec![
                // A new email ends the code and link of the one before.
                self.db
                    .prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = 'verify' AND email_id = ?")
                    .bind(&[user_id.into(), row.id.as_str().into()])?,
                self.db
                    .prepare(format!(
                        "INSERT INTO email_tokens (id, user_id, kind, expires_at, email_id, code_hash)
                         VALUES (?, ?, 'verify', {}, ?, ?)",
                        sql_after(CONFIRM_TTL_SECONDS)
                    ))
                    .bind(&[id.as_str().into(), user_id.into(), row.id.as_str().into(), code_hash.as_str().into()])?,
                self.db
                    .prepare(format!("UPDATE user_emails SET sent_at = {SQL_NOW} WHERE id = ?"))
                    .bind(&[row.id.as_str().into()])?,
            ])
            .await?;
        email::send_confirmation(&self.env, &row.display, username, confirming, &token, &code).await
    }

    /// Sends a new account its first code and link, to its primary.
    pub async fn send_primary_confirmation(&self, user_id: &str, username: &str) -> Result<()> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(());
        };
        let rows = self.email_rows(user_id).await?;
        let Some(row) = rows.iter().find(|row| Some(row.id.as_str()) == account.primary_email_id.as_deref()) else {
            return Ok(());
        };
        if row.verified_at.is_some() {
            return Ok(());
        }
        self.send_confirmation(user_id, username, row, Confirming::NewAccount).await
    }

    /// `add_email`.
    pub async fn add_email(&self, a: AccountEmailArgs) -> Result<Outcome<AccountEmails>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let typed = a.email.trim();
        let Some(email) = normalize_email(typed) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Enter a valid email address."));
        };
        if parse_noreply(&email).is_some() || email.ends_with("@users.g1t.sh") {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is a g1t noreply address; add an address you receive mail at."));
        }
        if let Some(refusal) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refusal);
        }
        let rows = self.email_rows(&a.user.id).await?;
        if let Some(row) = rows.iter().find(|row| row.email == email) {
            if row.verified_at.is_some() {
                return Ok(Outcome::fail(FailureCode::Conflict, "That address is already on your account."));
            }
            // Added before and not confirmed: adding it again sends the link again.
            if may_resend(row.sent_at.as_deref(), now_ms()) && self.allow(CONFIRM_ACCOUNT, &a.user.id).await? {
                self.send_confirmation(&a.user.id, &a.user.username, row, Confirming::AddedAddress).await?;
            }
            return self.emails_view(&a.user.id).await;
        }
        if rows.len() >= MAX_EMAILS {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("An account can have {MAX_EMAILS} addresses. Remove one first."),
            ));
        }
        if self.user_with_verified_email(&email).await?.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "That address is confirmed on another g1t account."));
        }
        let now = now_ms();
        let row = EmailRow {
            id: new_id("eml", now),
            email: email.clone(),
            display: typed.to_owned(),
            verified_at: None,
            sent_at: None,
            created_at: rfc3339(now),
        };
        let inserted = self
            .db
            .prepare(
                "INSERT INTO user_emails (id, user_id, email, display, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5
                 WHERE (SELECT count(*) FROM user_emails WHERE user_id = ?2) < ?6",
            )
            .bind(&[
                row.id.as_str().into(),
                a.user.id.as_str().into(),
                row.email.as_str().into(),
                row.display.as_str().into(),
                row.created_at.as_str().into(),
                (MAX_EMAILS as f64).into(),
            ])?
            .run()
            .await;
        if let Err(error) = inserted {
            // The same address added twice at once.
            if error.to_string().contains("UNIQUE") {
                return self.emails_view(&a.user.id).await;
            }
            return Err(error);
        }
        if !self.allow(CONFIRM_ACCOUNT, &a.user.id).await? {
            worker::console_log!("confirmation email held back: too many this hour");
        } else if let Err(error) = self.send_confirmation(&a.user.id, &a.user.username, &row, Confirming::AddedAddress).await {
            worker::console_error!("confirmation email failed: {error}");
        }
        self.log_security(&a.user.id, "email_added", Some(&row.display), None).await;
        self.tell_addresses(&a.user.id, &a.user.username, &format!("{} was added", row.display), None).await;
        self.announce_email("user.email_added", &a.user.id, false).await;
        self.emails_view(&a.user.id).await
    }

    /// `resend_email_verification`.
    pub async fn resend_email_verification(&self, a: AccountEmailArgs) -> Result<Outcome<bool>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let email = normalize_email(&a.email).unwrap_or_default();
        let rows = self.email_rows(&a.user.id).await?;
        let Some(row) = rows.iter().find(|row| row.email == email) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "That address is not on your account."));
        };
        if row.verified_at.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "That address is already confirmed."));
        }
        if !may_resend(row.sent_at.as_deref(), now_ms()) {
            return Ok(Outcome::fail(FailureCode::Conflict, SENT_RECENTLY));
        }
        if !self.allow(CONFIRM_ACCOUNT, &a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Too many confirmation emails this hour. Check your inbox, or try again later."));
        }
        let confirming = if self.account_confirmed(&a.user.id).await? { Confirming::AddedAddress } else { Confirming::NewAccount };
        self.send_confirmation(&a.user.id, &a.user.username, row, confirming).await?;
        Ok(Outcome::Ok(true))
    }

    /// Whether the account has a confirmed primary: whether it is past the
    /// confirmation page.
    pub async fn account_confirmed(&self, user_id: &str) -> Result<bool> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(false);
        };
        Ok(self
            .email_rows(user_id)
            .await?
            .iter()
            .any(|row| Some(row.id.as_str()) == account.primary_email_id.as_deref() && row.verified_at.is_some()))
    }

    /// The confirmation page's "send a new code": a new code and link for
    /// the primary of an account that has not confirmed it, or for its
    /// oldest unconfirmed address when a confirmed account elsewhere took
    /// its primary. At most one a minute; the ones before stop working.
    pub async fn resend_primary(&self, user: &g1t_contracts::User) -> Result<Outcome<bool>> {
        let Some(account) = self.account_row(&user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let rows = sorted(self.email_rows(&user.id).await?, account.primary_email_id.as_deref());
        if rows.iter().any(|row| Some(row.id.as_str()) == account.primary_email_id.as_deref() && row.verified_at.is_some()) {
            return Ok(Outcome::fail(FailureCode::Conflict, "This account's email is already confirmed."));
        }
        let Some(row) = rows.iter().find(|row| row.verified_at.is_none()) else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Add an email address in your settings first."));
        };
        if !may_resend(row.sent_at.as_deref(), now_ms()) {
            return Ok(Outcome::fail(FailureCode::Conflict, SENT_RECENTLY));
        }
        self.send_confirmation(&user.id, &account.username, row, Confirming::NewAccount).await?;
        Ok(Outcome::Ok(true))
    }

    /// `change_pending_email`: the confirmation page's "wrong address?".
    /// Only for an account with no confirmed address: its unconfirmed
    /// addresses are replaced by this one, which becomes the primary and
    /// gets a new code and link. Needs no password: the account has nothing
    /// yet that one would protect, and the new address still has to be
    /// confirmed. Counts against the confirmation emails an hour.
    pub async fn change_pending_email(&self, a: PendingEmailArgs) -> Result<Outcome<AccountEmails>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let typed = a.email.trim();
        let Some(email) = normalize_email(typed) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Enter a valid email address."));
        };
        if parse_noreply(&email).is_some() || email.ends_with("@users.g1t.sh") {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is a g1t noreply address; use an address you receive mail at."));
        }
        let rows = self.email_rows(&a.user.id).await?;
        if rows.iter().any(|row| row.verified_at.is_some()) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Your account has a confirmed address already. Change your addresses in your email settings.",
            ));
        }
        if self.user_with_verified_email(&email).await?.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "That address is confirmed on another g1t account."));
        }
        // The address it has already: nothing to change; the page's "send a
        // new code" sends one.
        if let [only] = rows.as_slice()
            && only.email == email
        {
            return self.emails_view(&a.user.id).await;
        }
        if !self.allow(CONFIRM_ACCOUNT, &a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Too many confirmation emails this hour. Check your inbox, or try again later."));
        }
        let now = now_ms();
        let row = EmailRow {
            id: new_id("eml", now),
            email: email.clone(),
            display: typed.to_owned(),
            verified_at: None,
            sent_at: None,
            created_at: rfc3339(now),
        };
        let user = JsValue::from(a.user.id.as_str());
        // One transaction: every unconfirmed address and its codes go, the
        // new one comes in as the primary.
        let changed = self
            .db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = 'verify'")
                    .bind(&[user.clone()])?,
                self.db
                    .prepare("UPDATE users SET primary_email_id = NULL, backup_email_id = NULL, email = NULL, email_verified_at = NULL WHERE id = ?")
                    .bind(&[user.clone()])?,
                self.db
                    .prepare("DELETE FROM user_emails WHERE user_id = ? AND verified_at IS NULL")
                    .bind(&[user.clone()])?,
                self.db
                    .prepare("INSERT INTO user_emails (id, user_id, email, display, created_at) VALUES (?, ?, ?, ?, ?)")
                    .bind(&[
                        row.id.as_str().into(),
                        user.clone(),
                        row.email.as_str().into(),
                        row.display.as_str().into(),
                        row.created_at.as_str().into(),
                    ])?,
                self.db
                    .prepare("UPDATE users SET primary_email_id = ?, email = ? WHERE id = ?")
                    .bind(&[row.id.as_str().into(), row.email.as_str().into(), user.clone()])?,
            ])
            .await;
        if let Err(error) = changed {
            if error.to_string().contains("UNIQUE") {
                return Ok(Outcome::fail(FailureCode::Conflict, "That address is already registered."));
            }
            return Err(error);
        }
        self.log_security(&a.user.id, "email_changed_before_confirming", Some(&row.display), None).await;
        if let Err(error) = self.send_confirmation(&a.user.id, &a.user.username, &row, Confirming::NewAccount).await {
            worker::console_error!("confirmation email failed: {error}");
        }
        self.announce_email("user.primary_email_changed", &a.user.id, false).await;
        self.emails_view(&a.user.id).await
    }

    /// `confirm_email_code`: the code from a confirmation email, typed by
    /// the signed-in person it was sent to. Every outstanding code of the
    /// account is compared, each in constant time; wrong ones are counted
    /// against the account and the client (throttle.rs). A right one is
    /// used up with its link, then confirms the address it was sent to.
    pub async fn confirm_email_code(&self, a: ConfirmEmailCodeArgs) -> Result<Outcome<EmailConfirmed>> {
        #[derive(Deserialize)]
        struct Sent {
            id: String,
            email_id: Option<String>,
            code_hash: String,
            expires_at: String,
        }
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let account_key = throttle::key(CODE_ACCOUNT, &a.user.id);
        let client_key = a
            .client
            .as_deref()
            .filter(|client| !client.trim().is_empty())
            .map(|client| throttle::key(CODE_CLIENT, client));
        // While either key is locked, no code is even compared.
        let mut locked = self.locked(&account_key).await?;
        if !locked && let Some(client_key) = &client_key {
            locked = self.locked(client_key).await?;
        }
        if locked {
            return Ok(Outcome::fail(FailureCode::Conflict, CODE_THROTTLED));
        }
        let now = rfc3339(now_ms());
        let sent: Vec<Sent> = match tidy_confirm_code(&a.code) {
            Some(_) => self
                .db
                .prepare(
                    "SELECT id, email_id, code_hash, expires_at FROM email_tokens
                     WHERE user_id = ? AND kind = 'verify' AND code_hash IS NOT NULL",
                )
                .bind(&[a.user.id.as_str().into()])?
                .all()
                .await?
                .results::<Sent>()?
                .into_iter()
                .filter(|sent| still_works(&sent.expires_at, &now))
                .collect(),
            None => Vec::new(),
        };
        let code = tidy_confirm_code(&a.code).unwrap_or_default();
        let key = self.code_key();
        let matched = matching_code(&key, &code, sent.iter().map(|sent| (sent.id.as_str(), sent.code_hash.as_str())))
            .and_then(|index| sent.get(index));
        // Used once: whoever deletes the row first has it.
        let used = match matched {
            Some(sent) => self
                .db
                .prepare("DELETE FROM email_tokens WHERE id = ? AND user_id = ? RETURNING id")
                .bind(&[sent.id.as_str().into(), a.user.id.as_str().into()])?
                .first::<serde_json::Value>(None)
                .await?
                .is_some(),
            None => false,
        };
        let Some(sent) = matched.filter(|_| used) else {
            self.count(CODE_ACCOUNT, &account_key).await?;
            if let Some(client_key) = &client_key {
                self.count(CODE_CLIENT, client_key).await?;
            }
            return Ok(Outcome::fail(FailureCode::Invalid, WRONG_CODE));
        };
        self.clear(&account_key).await?;
        // Any other code and link for the same address go too.
        self.db
            .prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = 'verify' AND email_id IS ?")
            .bind(&[a.user.id.as_str().into(), sent.email_id.as_deref().map_or(JsValue::NULL, Into::into)])?
            .run()
            .await?;
        self.confirm_address(&a.user.id, sent.email_id.as_deref()).await
    }

    /// Confirms an address after its link was followed or its code typed:
    /// `email_id`, or the primary for links sent before addresses had ids.
    /// When this confirms the account, the invite it signed up with is
    /// applied in the same transaction. Returns what it did, or why the
    /// address could not be confirmed.
    pub async fn confirm_address(&self, user_id: &str, email_id: Option<&str>) -> Result<Outcome<EmailConfirmed>> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(Outcome::fail(FailureCode::Invalid, "This confirmation link is not valid or has expired."));
        };
        let Some(email_id) = email_id.map(str::to_owned).or(account.primary_email_id.clone()) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "This confirmation link is not valid or has expired."));
        };
        let rows = self.email_rows(user_id).await?;
        let Some(row) = rows.into_iter().find(|row| row.id == email_id) else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That address was confirmed by another g1t account first, or was removed from yours.",
            ));
        };
        if row.verified_at.is_some() {
            return Ok(Outcome::Ok(EmailConfirmed {
                username: account.username,
                email: row.display,
                verified: self.account_confirmed(user_id).await?,
                ..EmailConfirmed::default()
            }));
        }
        // The invite the account signed up with, if it waits for this.
        let awaiting = self.awaiting_invite(user_id).await?;
        let join = match &awaiting {
            Some(invite) => Some(self.awaiting_join(invite).await),
            None => None,
        };
        let won = |sql: &str| sql.replace("{WON}", "EXISTS (SELECT 1 FROM user_emails WHERE id = ?1 AND verified_at IS NOT NULL)");
        let id = JsValue::from(row.id.as_str());
        let user = JsValue::from(user_id);
        let address = JsValue::from(row.email.as_str());
        // One transaction. Confirm this row only if no account has the
        // address confirmed; then, only if it was, drop everyone else's
        // claim to it, and make it this account's primary when the account
        // has no confirmed primary; then, if that confirmed the account,
        // apply the invite it signed up with.
        let mut statements = vec![
                self.db
                    .prepare(format!(
                        "UPDATE user_emails SET verified_at = {SQL_NOW}
                         WHERE id = ?1 AND verified_at IS NULL
                           AND NOT EXISTS (SELECT 1 FROM user_emails WHERE email = ?2 AND verified_at IS NOT NULL)"
                    ))
                    .bind(&[id.clone(), address.clone()])?,
                self.db
                    .prepare(won(
                        "UPDATE users SET email = NULL, email_verified_at = NULL, primary_email_id = NULL
                         WHERE id <> ?3 AND {WON} AND primary_email_id IN (
                           SELECT id FROM user_emails WHERE email = ?2 AND verified_at IS NULL AND user_id <> ?3)",
                    ))
                    .bind(&[id.clone(), address.clone(), user.clone()])?,
                self.db
                    .prepare(won(
                        "UPDATE users SET backup_email_id = NULL
                         WHERE id <> ?3 AND {WON} AND backup_email_id IN (
                           SELECT id FROM user_emails WHERE email = ?2 AND verified_at IS NULL AND user_id <> ?3)",
                    ))
                    .bind(&[id.clone(), address.clone(), user.clone()])?,
                self.db
                    .prepare(won(
                        "DELETE FROM user_emails WHERE email = ?2 AND verified_at IS NULL AND user_id <> ?3 AND {WON}",
                    ))
                    .bind(&[id.clone(), address.clone(), user.clone()])?,
                self.db
                    .prepare(won(
                        "UPDATE users SET primary_email_id = ?1, email = ?2,
                           email_verified_at = (SELECT verified_at FROM user_emails WHERE id = ?1)
                         WHERE id = ?3 AND {WON} AND (
                           primary_email_id IS NULL OR primary_email_id = ?1
                           OR NOT EXISTS (SELECT 1 FROM user_emails WHERE id = users.primary_email_id AND verified_at IS NOT NULL))",
                    ))
                    .bind(&[id.clone(), address.clone(), user.clone()])?,
        ];
        if let (Some(invite), Some(join)) = (&awaiting, &join) {
            statements.extend(self.apply_invite_statements(user_id, invite, join)?);
        }
        self.db.batch(statements).await?;
        let confirmed = self
            .email_rows(user_id)
            .await?
            .into_iter()
            .any(|current| current.id == row.id && current.verified_at.is_some());
        if !confirmed {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That address was confirmed by another g1t account first. Use a different address.",
            ));
        }
        self.log_security(user_id, "email_verified", Some(&row.display), None).await;
        self.announce_email("user.email_verified", user_id, false).await;
        let verified = self.account_confirmed(user_id).await?;
        let (mut joined, mut invite_lapsed) = (None, None);
        if let (Some(invite), Some(join), true) = (&awaiting, &join, verified) {
            let user = g1t_contracts::User {
                id: user_id.to_owned(),
                username: account.username.clone(),
                verified: true,
                ..g1t_contracts::User::default()
            };
            joined = self.after_applied(invite, &user, join).await?;
            invite_lapsed = match join {
                AwaitingJoin::Lapsed(why) => Some(why.clone()),
                // Revoked between the read and the transaction.
                AwaitingJoin::Join { .. } if joined.is_none() => Some(
                    "Your email address is confirmed. The invite you signed up with no longer applies, so it did not join you to a workspace."
                        .to_owned(),
                ),
                _ => None,
            };
        }
        Ok(Outcome::Ok(EmailConfirmed {
            username: account.username,
            email: row.display,
            verified,
            joined,
            invite_lapsed,
        }))
    }

    /// `remove_email`.
    pub async fn remove_email(&self, a: AccountEmailArgs) -> Result<Outcome<AccountEmails>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let email = normalize_email(&a.email).unwrap_or_default();
        let Some(account) = self.account_row(&a.user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let rows = self.email_rows(&a.user.id).await?;
        if let Some(why) = removal_refusal(&states(&rows, account.primary_email_id.as_deref()), &email) {
            return Ok(Outcome::fail(FailureCode::Conflict, why));
        }
        if let Some(refusal) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refusal);
        }
        let Some(row) = rows.into_iter().find(|row| row.email == email) else {
            return self.emails_view(&a.user.id).await;
        };
        self.delete_address(&a.user.id, &row).await?;
        self.log_security(&a.user.id, "email_removed", Some(&row.display), None).await;
        let removed = row.verified_at.is_some().then_some(row.display.as_str());
        self.tell_addresses(&a.user.id, &a.user.username, &format!("{} was removed", row.display), removed).await;
        self.announce_email("user.email_removed", &a.user.id, false).await;
        self.emails_view(&a.user.id).await
    }

    /// Deletes an address and anything pointing at it. The caller has made
    /// sure it is not the primary, or has moved the primary already.
    async fn delete_address(&self, user_id: &str, row: &EmailRow) -> Result<()> {
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE users SET backup_email_id = NULL WHERE id = ? AND backup_email_id = ?")
                    .bind(&[user_id.into(), row.id.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM email_tokens WHERE user_id = ? AND email_id = ?")
                    .bind(&[user_id.into(), row.id.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM user_emails WHERE id = ? AND user_id = ?")
                    .bind(&[row.id.as_str().into(), user_id.into()])?,
            ])
            .await?;
        Ok(())
    }

    /// Makes a confirmed address the primary, keeping `users` in step.
    async fn set_primary(&self, user_id: &str, row: &EmailRow) -> Result<()> {
        self.db
            .prepare(
                "UPDATE users SET primary_email_id = ?1, email = ?2,
                   email_verified_at = (SELECT verified_at FROM user_emails WHERE id = ?1),
                   backup_email_id = CASE WHEN backup_email_id = ?1 THEN NULL ELSE backup_email_id END
                 WHERE id = ?3 AND EXISTS (SELECT 1 FROM user_emails WHERE id = ?1 AND user_id = ?3 AND verified_at IS NOT NULL)",
            )
            .bind(&[row.id.as_str().into(), row.email.as_str().into(), user_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// `update_email_settings`.
    pub async fn update_email_settings(&self, a: EmailSettingsArgs) -> Result<Outcome<AccountEmails>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let Some(account) = self.account_row(&a.user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let rows = self.email_rows(&a.user.id).await?;
        let find = |email: &str| {
            let email = normalize_email(email).unwrap_or_default();
            rows.iter().find(|row| row.email == email).cloned()
        };
        let primary = match a.primary.as_deref().map(str::trim).filter(|email| !email.is_empty()) {
            None => None,
            Some(email) => {
                let normalized = normalize_email(email).unwrap_or_default();
                if let Some(why) = primary_refusal(&states(&rows, account.primary_email_id.as_deref()), &normalized) {
                    return Ok(Outcome::fail(FailureCode::Conflict, why));
                }
                find(email).filter(|row| Some(row.id.as_str()) != account.primary_email_id.as_deref())
            }
        };
        // Some(None): the primary only.
        let backup: Option<Option<EmailRow>> = match a.backup.as_deref().map(str::trim) {
            None => None,
            Some("") => (account.backup_email_id.is_some()).then_some(None),
            Some(email) => {
                let Some(row) = find(email).filter(|row| row.verified_at.is_some()) else {
                    return Ok(Outcome::fail(FailureCode::Conflict, "Only a confirmed address on your account can be the backup."));
                };
                let will_be_primary = primary.as_ref().map_or(account.primary_email_id.clone(), |row| Some(row.id.clone()));
                if Some(&row.id) == will_be_primary.as_ref() {
                    return Ok(Outcome::fail(FailureCode::Conflict, "That is your primary address; choose another for the backup."));
                }
                (account.backup_email_id.as_deref() != Some(row.id.as_str())).then_some(Some(row))
            }
        };
        if (primary.is_some() || backup.is_some())
            && let Some(refusal) = self.proof(&a.user.id, &a.reauth).await?.refusal()
        {
            return Ok(refusal);
        }
        if let Some(row) = &primary {
            let old = rows.iter().find(|old| Some(old.id.as_str()) == account.primary_email_id.as_deref());
            self.set_primary(&a.user.id, row).await?;
            self.log_security(&a.user.id, "primary_email_changed", Some(&row.display), None).await;
            // Every confirmed address hears of it, the old primary included.
            self.tell_addresses(
                &a.user.id,
                &a.user.username,
                &format!("{} is now the primary address", row.display),
                old.filter(|old| old.verified_at.is_some()).map(|old| old.display.as_str()),
            )
            .await;
            self.announce_email("user.primary_email_changed", &a.user.id, false).await;
        }
        if let Some(choice) = &backup {
            self.db
                .prepare("UPDATE users SET backup_email_id = ? WHERE id = ?")
                .bind(&[
                    choice.as_ref().map_or(JsValue::NULL, |row| row.id.as_str().into()),
                    a.user.id.as_str().into(),
                ])?
                .run()
                .await?;
            let said = choice.as_ref().map_or("primary only".to_owned(), |row| row.display.clone());
            self.log_security(&a.user.id, "backup_email_changed", Some(&said), None).await;
            let change = match choice {
                Some(row) => format!("{} now gets security notices too", row.display),
                None => "Security notices now go to the primary address only".to_owned(),
            };
            self.tell_addresses(&a.user.id, &a.user.username, &change, None).await;
        }
        let private = a.private_email.filter(|private| *private != (account.private_email != 0));
        let block = a.block_private_pushes.filter(|block| *block != (account.block_private_pushes != 0));
        if private.is_some() || block.is_some() {
            self.db
                .prepare(
                    "UPDATE users SET private_email = COALESCE(?, private_email),
                       block_private_pushes = COALESCE(?, block_private_pushes) WHERE id = ?",
                )
                .bind(&[
                    private.map_or(JsValue::NULL, |on| (on as u8 as f64).into()),
                    block.map_or(JsValue::NULL, |on| (on as u8 as f64).into()),
                    a.user.id.as_str().into(),
                ])?
                .run()
                .await?;
            let mut said = Vec::new();
            if let Some(on) = private {
                said.push(if on { "address kept private" } else { "address used on web commits" });
            }
            if let Some(on) = block {
                said.push(if on { "pushes that expose it refused" } else { "pushes that expose it allowed" });
            }
            self.log_security(&a.user.id, "email_privacy_changed", Some(&said.join("; ")), None).await;
        }
        self.emails_view(&a.user.id).await
    }

    /// Who gets a security notice: every confirmed address when `all`,
    /// otherwise the primary and the backup.
    pub async fn notice_recipients(&self, user_id: &str, all: bool) -> Result<Vec<String>> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(Vec::new());
        };
        let rows = sorted(self.email_rows(user_id).await?, account.primary_email_id.as_deref());
        Ok(rows
            .into_iter()
            .filter(|row| row.verified_at.is_some())
            .filter(|row| {
                all || Some(row.id.as_str()) == account.primary_email_id.as_deref()
                    || Some(row.id.as_str()) == account.backup_email_id.as_deref()
            })
            .map(|row| row.display)
            .collect())
    }

    /// Tells every confirmed address of an account, and `also` (an address
    /// that has just left it), what changed. Best effort.
    pub async fn tell_addresses(&self, user_id: &str, username: &str, change: &str, also: Option<&str>) {
        let mut to = self.notice_recipients(user_id, true).await.unwrap_or_default();
        if let Some(also) = also
            && !to.iter().any(|known| known.eq_ignore_ascii_case(also))
        {
            to.push(also.to_owned());
        }
        for address in to {
            if let Err(error) = email::send_security_notice(&self.env, &address, username, change).await {
                worker::console_error!("security notice failed: {error}");
            }
        }
    }

    /// Tells the primary and the backup what changed. Best effort.
    pub async fn tell_primary_and_backup(&self, user_id: &str, username: &str, change: &str) {
        for address in self.notice_recipients(user_id, false).await.unwrap_or_default() {
            if let Err(error) = email::send_security_notice(&self.env, &address, username, change).await {
                worker::console_error!("security notice failed: {error}");
            }
        }
    }

    async fn announce_email(&self, kind: &'static str, user_id: &str, by_staff: bool) {
        let actor = (!by_staff).then_some(user_id);
        self.announce(
            kind,
            actor,
            UserEmailChanged {
                user_id: user_id.to_owned(),
                by_staff,
            },
        )
        .await;
    }

    // --- Signing in and resetting by any confirmed address ---

    /// The account a password reset for `email` goes to, the address it is
    /// sent to and that address's id: a confirmed address, or else the
    /// unconfirmed address a new account signed up with (following the link
    /// confirms it).
    pub async fn reset_target(&self, email: &str) -> Result<Option<ResetTarget>> {
        let Some(email) = normalize_email(email) else {
            return Ok(None);
        };
        let confirmed = self
            .db
            .prepare(
                "SELECT u.id AS user_id, u.username, e.id AS email_id, e.display FROM user_emails e
                 JOIN users u ON u.id = e.user_id WHERE e.email = ? AND e.verified_at IS NOT NULL AND u.deleted_at IS NULL",
            )
            .bind(&[email.as_str().into()])?
            .first::<ResetTarget>(None)
            .await?;
        if confirmed.is_some() {
            return Ok(confirmed);
        }
        self.db
            .prepare(
                "SELECT u.id AS user_id, u.username, e.id AS email_id, e.display FROM user_emails e
                 JOIN users u ON u.primary_email_id = e.id
                 WHERE e.email = ? AND e.verified_at IS NULL AND u.deleted_at IS NULL ORDER BY u.created_at, u.id LIMIT 1",
            )
            .bind(&[email.as_str().into()])?
            .first::<ResetTarget>(None)
            .await
    }

    // --- Commits ---

    /// `email_owners`: whose commits these are, by author address.
    pub async fn email_owners(&self, a: EmailOwnersArgs) -> Result<HashMap<String, EmailOwner>> {
        #[derive(Deserialize)]
        struct Row {
            email: String,
            id: String,
            username: String,
            avatar: Option<String>,
            /// 1 for an account that is deleted: purged (its username is
            /// in `deleted_users`) or in its window to be restored.
            #[serde(default)]
            gone: u8,
        }
        let mut owners = HashMap::new();
        let mut plain: Vec<String> = Vec::new();
        let mut by_name: Vec<(String, Option<String>, String)> = Vec::new();
        for email in a.emails.iter().take(200) {
            let Some(email) = normalize_email(email) else { continue };
            if let Some((suffix, username)) = parse_noreply(&email) {
                by_name.push((username, Some(suffix), email));
            } else if let Some(username) = email.strip_suffix("@users.g1t.sh") {
                // What g1t put on the commits it made before noreply
                // addresses existed.
                by_name.push((username.to_owned(), None, email.clone()));
            } else if !plain.contains(&email) {
                plain.push(email);
            }
        }
        if !plain.is_empty() {
            let marks = vec!["?"; plain.len()].join(", ");
            let bind: Vec<JsValue> = plain.iter().map(|email| email.as_str().into()).collect();
            let rows = self
                .db
                .prepare(format!(
                    "SELECT e.email, u.id, u.username, u.avatar, u.deleted_at IS NOT NULL AS gone
                     FROM user_emails e JOIN users u ON u.id = e.user_id
                     WHERE e.verified_at IS NOT NULL AND e.email IN ({marks})"
                ))
                .bind(&bind)?
                .all()
                .await?
                .results::<Row>()?;
            for row in rows {
                owners.insert(row.email, shown_owner(row.id, row.username, row.avatar, row.gone != 0));
            }
        }
        if !by_name.is_empty() {
            let names: Vec<&str> = by_name.iter().map(|(name, _, _)| name.as_str()).collect();
            let marks = vec!["?"; names.len()].join(", ");
            let bind: Vec<JsValue> = names.iter().map(|name| (*name).into()).collect();
            let rows = self
                .db
                .prepare(format!(
                    "SELECT username AS email, id, username, avatar, deleted_at IS NOT NULL AS gone FROM users
                     WHERE username IN ({marks})
                     UNION ALL
                     SELECT username AS email, user_id AS id, username, NULL AS avatar, 1 AS gone FROM deleted_users
                     WHERE username IN ({marks})"
                ))
                .bind(&[bind.clone(), bind].concat())?
                .all()
                .await?
                .results::<Row>()?;
            for (username, suffix, email) in by_name {
                if let Some(row) = rows.iter().find(|row| row.username == username)
                    && suffix.as_deref().is_none_or(|suffix| id_suffix(&row.id) == suffix)
                {
                    owners.insert(email, shown_owner(row.id.clone(), row.username.clone(), row.avatar.clone(), row.gone != 0));
                }
            }
        }
        Ok(owners)
    }

    /// `commit_identity`.
    pub async fn commit_identity(&self, a: CommitIdentityArgs) -> Result<Option<CommitIdentity>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            username: String,
            display_name: Option<String>,
            private_email: u8,
            primary: Option<String>,
            verified: u8,
        }
        let row = self
            .db
            .prepare(
                "SELECT u.id, u.username, u.display_name, u.private_email, e.email AS \"primary\",
                   e.verified_at IS NOT NULL AS verified
                 FROM users u LEFT JOIN user_emails e ON e.id = u.primary_email_id WHERE u.id = ?",
            )
            .bind(&[a.user_id.as_str().into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map(|row| {
            let noreply = noreply_address(&row.id, &row.username);
            let email = match row.primary {
                Some(primary) if row.private_email == 0 && row.verified != 0 => primary,
                _ => noreply,
            };
            let name = row.display_name.filter(|name| !name.trim().is_empty()).unwrap_or(row.username);
            CommitIdentity { name, email }
        }))
    }

    /// `push_email_guard`: the addresses a push by this person must not
    /// publish, while they keep their address private and block pushes
    /// that expose it. One read of the account and one of its addresses.
    pub async fn push_email_guard(&self, a: CommitIdentityArgs) -> Result<Option<PushEmailGuard>> {
        let Some(account) = self.account_row(&a.user_id).await? else {
            return Ok(None);
        };
        if !guards_pushes(&account) {
            return Ok(None);
        }
        let rows = self.email_rows(&a.user_id).await?;
        Ok(Some(PushEmailGuard {
            emails: rows.into_iter().filter(|row| row.verified_at.is_some()).map(|row| row.email.to_lowercase()).collect(),
            noreply: noreply_address(&account.id, &account.username),
        }))
    }

    // --- Staff ---

    /// `admin_user`.
    pub async fn admin_user(&self, a: UsernameArgs) -> Result<Option<AdminUser>> {
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let found = self
            .db
            .prepare("SELECT id FROM users WHERE username = ?")
            .bind(&[a.username.trim().to_lowercase().into()])?
            .first::<Id>(None)
            .await?;
        let Some(found) = found else {
            return Ok(None);
        };
        self.admin_user_by_id(&found.id).await
    }

    async fn admin_user_by_id(&self, user_id: &str) -> Result<Option<AdminUser>> {
        let Some(account) = self.account_row(user_id).await? else {
            return Ok(None);
        };
        let rows = self.email_rows(user_id).await?;
        let log = self.security_events(user_id, true).await?;
        let emails = view(&account, rows);
        // Whether it can be deleted, and its deletion while it waits to be
        // purged (account_deletion.rs). For each workspace it owns alone,
        // whether staff could delete it with the account: protected, or
        // billing that cannot settle.
        let deleted = self.deleted_account(&account.id).await?;
        let deletion = self
            .account_deletion_facts(&account.id, &account.username, crate::account_deletion::AskBilling::Staff)
            .await?;
        Ok(Some(AdminUser {
            id: account.id,
            username: account.username,
            created_at: account.created_at,
            emails: emails.emails,
            private_email: emails.private_email,
            log,
            deletion,
            deleted,
            joined_through: self.shared_source(user_id).await?,
        }))
    }

    /// `admin_remove_email`.
    pub async fn admin_remove_email(&self, a: AdminRemoveEmailArgs) -> Result<Outcome<AdminUser>> {
        let reason = a.reason.trim();
        if reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why the address is being removed; the person sees it."));
        }
        if a.staff.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Staff changes name who made them."));
        }
        let Some(user) = self.admin_user(UsernameArgs { username: a.username.clone() }).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let Some(account) = self.account_row(&user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let email = normalize_email(&a.email).unwrap_or_default();
        let rows = sorted(self.email_rows(&user.id).await?, account.primary_email_id.as_deref());
        let Some(row) = rows.iter().find(|row| row.email == email).cloned() else {
            return Ok(Outcome::fail(FailureCode::NotFound, "That address is not on this account."));
        };
        let confirmed: Vec<&EmailRow> = rows.iter().filter(|other| other.verified_at.is_some()).collect();
        if row.verified_at.is_some() && confirmed.len() <= 1 {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That is the account's only confirmed address. The person has to add and confirm another first.",
            ));
        }
        let was_primary = account.primary_email_id.as_deref() == Some(row.id.as_str());
        if was_primary {
            match confirmed.iter().find(|other| other.id != row.id) {
                Some(next) => self.set_primary(&user.id, next).await?,
                None => {
                    // An unconfirmed primary on an account with no
                    // confirmed address: it is left without one.
                    self.db
                        .prepare("UPDATE users SET primary_email_id = NULL, email = NULL, email_verified_at = NULL WHERE id = ?")
                        .bind(&[user.id.as_str().into()])?
                        .run()
                        .await?;
                }
            }
        }
        self.delete_address(&user.id, &row).await?;
        let staff = (a.staff.trim(), reason);
        self.log_security(&user.id, "email_removed", Some(&row.display), Some(staff)).await;
        let removed = row.verified_at.is_some().then_some(row.display.as_str());
        self.tell_addresses(&user.id, &user.username, &format!("g1t staff removed {} ({reason})", row.display), removed)
            .await;
        self.announce_email("user.email_removed", &user.id, true).await;
        if was_primary {
            self.announce_email("user.primary_email_changed", &user.id, true).await;
        }
        Ok(match self.admin_user_by_id(&user.id).await? {
            Some(user) => Outcome::Ok(user),
            None => Outcome::fail(FailureCode::NotFound, "No such account."),
        })
    }
}

/// Whether a code and link that stop working at `expires_at` still work
/// at `now` (both RFC 3339, which sort as they read).
pub fn still_works(expires_at: &str, now: &str) -> bool {
    expires_at > now
}

/// Which of the account's outstanding codes `code` is, by index: each
/// `(token id, code hash)` is compared in constant time, and every one is
/// compared whatever matched before it.
pub fn matching_code<'a>(key: &[u8], code: &str, sent: impl Iterator<Item = (&'a str, &'a str)>) -> Option<usize> {
    let mut found = None;
    for (index, (id, hash)) in sent.enumerate() {
        let expected = crypto::code_hash(key, id, code);
        if crypto::same(&expected, hash) && found.is_none() {
            found = Some(index);
        }
    }
    if code.is_empty() { None } else { found }
}

/// Where a password reset goes.
#[derive(Debug, Deserialize)]
pub struct ResetTarget {
    pub user_id: String,
    pub username: String,
    pub email_id: String,
    pub display: String,
}

/// Who an address's commits are shown as: the account, or ghost for a
/// deleted one. An account in its window to be restored is ghost already,
/// as it will be once purged (account_deletion.rs), and is itself again if
/// staff restore it, since nothing about it is changed here.
fn shown_owner(id: String, username: String, avatar: Option<String>, gone: bool) -> EmailOwner {
    if gone {
        EmailOwner { id: GHOST_ID.to_owned(), username: GHOST_USERNAME.to_owned(), avatar: None }
    } else {
        EmailOwner { id, username, avatar }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deleted_account_is_ghost_on_its_commits_until_restored() {
        let live = shown_owner("usr_ana".into(), "ana".into(), Some("abc".into()), false);
        assert_eq!((live.id.as_str(), live.username.as_str(), live.avatar.as_deref()), ("usr_ana", "ana", Some("abc")));
        // Deleted and restorable, or purged: ghost, with nothing of the account.
        let gone = shown_owner("usr_ana".into(), "ana".into(), Some("abc".into()), true);
        assert_eq!((gone.id.as_str(), gone.username.as_str(), gone.avatar), (GHOST_ID, GHOST_USERNAME, None));
    }

    fn row(id: &str, email: &str, verified: bool, created: &str) -> EmailRow {
        EmailRow {
            id: id.into(),
            email: email.into(),
            display: email.to_uppercase(),
            verified_at: verified.then(|| "2026-10-01T00:00:00.000Z".to_owned()),
            sent_at: None,
            created_at: created.into(),
        }
    }

    fn account(primary: Option<&str>, backup: Option<&str>, private: bool) -> AccountRow {
        AccountRow {
            id: "usr_01j9zq4m8x7k2v5n3b6c1d0efg".into(),
            username: "ada".into(),
            primary_email_id: primary.map(Into::into),
            backup_email_id: backup.map(Into::into),
            private_email: private as u8,
            block_private_pushes: 0,
            created_at: String::new(),
        }
    }

    #[test]
    fn the_primary_comes_first_then_confirmed_then_the_rest() {
        let rows = vec![
            row("e1", "old@x.io", false, "2026-01-01"),
            row("e2", "work@x.io", true, "2026-02-01"),
            row("e3", "home@x.io", true, "2026-03-01"),
        ];
        let order: Vec<String> = sorted(rows, Some("e3")).into_iter().map(|row| row.id).collect();
        assert_eq!(order, ["e3", "e2", "e1"]);
    }

    #[test]
    fn the_view_marks_primary_and_backup_and_shows_addresses_as_typed() {
        let rows = vec![row("e1", "a@x.io", true, "1"), row("e2", "b@x.io", true, "2"), row("e3", "c@x.io", false, "3")];
        let seen = view(&account(Some("e1"), Some("e2"), true), rows);
        assert_eq!(seen.emails[0].email, "A@X.IO");
        assert!(seen.emails[0].primary && !seen.emails[0].backup);
        assert!(seen.emails[1].backup && !seen.emails[1].primary);
        assert!(!seen.emails[2].verified);
        assert_eq!(seen.noreply, "6c1d0efg+ada@users.noreply.g1t.sh");
        assert_eq!(seen.commit_email, seen.noreply);
        assert_eq!(seen.limit, 10);
    }

    #[test]
    fn commits_use_the_primary_only_when_the_person_allows_it_and_it_is_confirmed() {
        let confirmed = row("e1", "a@x.io", true, "1");
        let unconfirmed = row("e2", "b@x.io", false, "2");
        assert_eq!(commit_email(false, Some(&confirmed), "n@noreply"), "a@x.io");
        assert_eq!(commit_email(true, Some(&confirmed), "n@noreply"), "n@noreply");
        assert_eq!(commit_email(false, Some(&unconfirmed), "n@noreply"), "n@noreply");
        assert_eq!(commit_email(false, None, "n@noreply"), "n@noreply");
    }

    #[test]
    fn pushes_are_guarded_only_while_private_and_blocking() {
        let mut ada = account(None, None, true);
        assert!(!guards_pushes(&ada));
        ada.block_private_pushes = 1;
        assert!(guards_pushes(&ada));
        ada.private_email = 0;
        assert!(!guards_pushes(&ada));
    }

    #[test]
    fn a_code_works_for_its_own_link_and_address_only_and_not_after_a_new_email() {
        let key = b"identity key".as_slice();
        let first = ("link-1", crypto::code_hash(key, "link-1", "482913"));
        let other_address = ("link-2", crypto::code_hash(key, "link-2", "100200"));
        fn sent<'a>(rows: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
            rows.iter().map(|(id, hash)| (*id, hash.as_str())).collect()
        }
        let rows = vec![first.clone(), other_address.clone()];
        assert_eq!(matching_code(key, "482913", sent(&rows).into_iter()), Some(0));
        assert_eq!(matching_code(key, "100200", sent(&rows).into_iter()), Some(1));
        // A wrong code, an empty one, or the right one under another key.
        assert_eq!(matching_code(key, "482914", sent(&rows).into_iter()), None);
        assert_eq!(matching_code(key, "", sent(&rows).into_iter()), None);
        assert_eq!(matching_code(b"another key", "482913", sent(&rows).into_iter()), None);
        // Used, or replaced by a new email: the row is gone, and the new
        // pair's code is bound to its own link, so the old code fails.
        let resent = vec![("link-3", crypto::code_hash(key, "link-3", "731055")), other_address];
        assert_eq!(matching_code(key, "482913", sent(&resent).into_iter()), None);
        assert_eq!(matching_code(key, "731055", sent(&resent).into_iter()), Some(0));
    }

    #[test]
    fn a_code_and_link_stop_working_after_an_hour() {
        let sent = 1_800_000_000_000;
        let expires = rfc3339(sent + CONFIRM_TTL_SECONDS * 1000);
        assert!(still_works(&expires, &rfc3339(sent)));
        assert!(still_works(&expires, &rfc3339(sent + 59 * 60 * 1000)));
        assert!(!still_works(&expires, &rfc3339(sent + 60 * 60 * 1000)));
        assert!(!still_works(&expires, &rfc3339(sent + 61 * 60 * 1000)));
        // Long enough to switch to a mail app, short enough that six
        // digits are not worth guessing.
        assert!((30 * 60..=60 * 60).contains(&CONFIRM_TTL_SECONDS));
    }

    #[test]
    fn a_link_can_be_sent_again_after_a_minute() {
        let now = 1_800_000_000_000;
        assert!(may_resend(None, now));
        assert!(!may_resend(Some(&rfc3339(now - 30_000)), now));
        assert!(may_resend(Some(&rfc3339(now - 61_000)), now));
    }
}
