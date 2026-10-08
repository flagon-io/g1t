//! Invite-only registration: invite codes, allowances, the waitlist, and
//! the one place every new account is made.
//!
//! [`Identity::create_account`] is the only way an account comes to exist.
//! While `REGISTRATION_MODE` is `invite` (or unset), it needs an invite
//! code: unknown, used, revoked and expired codes all get the same answer,
//! an email-bound code works only with that address, and the code is spent
//! in the same transaction that makes the account, so two people racing
//! with one code cannot both get in.
//!
//! A code is 160 random bits in Crockford base32, shown as `g1t-` and eight
//! groups of four. Only its SHA-256 is kept to find it, with a copy sealed
//! under IDENTITY_KEY so whoever made it can copy the link again while it
//! is pending.
//!
//! Each person may have `INVITES_PER_USER` (5) invites out: pending and
//! used ones count, and a revoked or expired one that was never used comes
//! back. Staff grant more in sudo, to a person or to a workspace, whose
//! owners share them. Owners of the workspaces in
//! `INVITE_STAFF_WORKSPACES` (g1t's own) have no limit. Inviting an address
//! into a workspace always makes an invite bound to it, and costs one only
//! when the address has no account, so the answer never says which.
//!
//! Vars: REGISTRATION_MODE (`invite` | `open`), INVITES_PER_USER,
//! INVITE_TTL_DAYS, INVITE_STAFF_WORKSPACES (comma separated slugs).

use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::events::{InviteCreated, InviteRedeemed, WaitlistRequested};
use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use g1t_secrets::Sealer;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Identity, crypto};

/// Crockford base32, as ids use: no i, l, o or u.
const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// 32 characters of 5 bits: 160 random bits.
const CODE_LENGTH: usize = 32;
const GROUP: usize = 4;

pub const INVALID: &str =
    "That invite code is not valid. It may have been used, revoked or expired; ask whoever invited you for a new one.";
pub const WRONG_EMAIL: &str = "This invite is for a different email address. Use the address it was sent to.";
pub const MISSING: &str = "g1t is invite-only for now. Enter your invite code, or request access.";
const TOO_MANY: &str = "Too many attempts. Try again in an hour.";
const PEOPLE_ONLY: &str = "Only a person can make invites, not an agent or a workspace's token.";
const CONFIRM_FIRST: &str = "Confirm your email address before inviting anyone.";
const BAD_EMAIL: &str = "Enter a valid email address.";

const HOUR_MS: u64 = 60 * 60 * 1000;
/// Invites one person may make in an hour, whatever their allowance.
const CREATES_PER_HOUR: u32 = 20;
/// Wrong codes one client may try in an hour before being turned away.
const FAILURES_PER_HOUR: u32 = 20;
/// Access requests from one client in an hour.
const REQUESTS_PER_HOUR: u32 = 5;
/// Access requests from clients that sent no address, together, in an hour.
const ANONYMOUS_REQUESTS_PER_HOUR: u32 = 200;
/// Confirmations of access requests, to everyone together, in an hour.
const CONFIRMATIONS_PER_HOUR: u32 = 300;
/// The least time between two summaries of new requests to staff.
const SUMMARY_EVERY_MS: u64 = 15 * 60 * 1000;
/// The most invites a person's or workspace's list shows.
const LIST_LIMIT: u32 = 200;
/// How far down the invite tree staff see.
const TREE_DEPTH: usize = 3;

// --- Codes ------------------------------------------------------------------

/// The 32 characters of a code from 20 random bytes.
fn encode(bytes: &[u8; 20]) -> String {
    let mut out = String::with_capacity(CODE_LENGTH);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
        buffer &= (1 << bits) - 1;
    }
    out
}

/// A new code's 32 characters.
pub fn new_code_body() -> String {
    let mut bytes = [0u8; 20];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");
    encode(&bytes)
}

/// How a code is shown: `g1t-` and groups of four.
pub fn format_code(body: &str) -> String {
    let groups: Vec<&str> = body
        .as_bytes()
        .chunks(GROUP)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect();
    format!("g1t-{}", groups.join("-"))
}

/// A code's 32 characters from however it was typed or pasted: any case,
/// with or without `g1t-`, hyphens or spaces, or a whole invite link.
/// Letters easily misread are read as Crockford reads them.
pub fn normalize_code(input: &str) -> Option<String> {
    let mut text = input.trim().to_ascii_lowercase();
    // A pasted link: the last path segment, or the `invite` parameter.
    if let Some(at) = text.find("invite=") {
        text = text[at + "invite=".len()..].split('&').next().unwrap_or_default().to_owned();
    } else if let Some(at) = text.rfind('/') {
        text = text[at + 1..].to_owned();
    }
    let text = text.strip_prefix("g1t").unwrap_or(&text);
    let mut body = String::with_capacity(CODE_LENGTH);
    for c in text.chars() {
        let c = match c {
            '-' | ' ' | '_' => continue,
            'i' | 'l' => '1',
            'o' => '0',
            c if ALPHABET.contains(&(c as u8)) && c.is_ascii() => c,
            _ => return None,
        };
        body.push(c);
    }
    (body.len() == CODE_LENGTH).then_some(body)
}

/// What is stored to find a code.
pub fn code_hash(body: &str) -> String {
    crypto::sha256_hex(body)
}

/// The code's first group, kept to recognise it: 20 of its 160 bits.
pub fn code_hint(body: &str) -> String {
    format!("g1t-{}", &body[..GROUP])
}

// --- Rules --------------------------------------------------------------------

/// Where an invite stands at `now`, from its row.
pub fn status_of(revoked_at: Option<&str>, redeemed_at: Option<&str>, expires_at: &str, now: &str) -> InviteStatus {
    if redeemed_at.is_some() {
        InviteStatus::Redeemed
    } else if revoked_at.is_some() {
        InviteStatus::Revoked
    } else if expires_at <= now {
        InviteStatus::Expired
    } else {
        InviteStatus::Pending
    }
}

/// Whether an invite in this state uses up one of an allowance: pending
/// and used ones do; a revoked or expired one never used gives it back.
#[cfg(test)]
pub fn counts_against_allowance(status: InviteStatus) -> bool {
    matches!(status, InviteStatus::Pending | InviteStatus::Redeemed)
}

/// The SQL condition that matches [`counts_against_allowance`] for rows of
/// `invites` aliased `i`.
fn counted_sql() -> String {
    format!("(i.redeemed_at IS NOT NULL OR (i.revoked_at IS NULL AND i.expires_at > {SQL_NOW}))")
}

/// How many invites someone may have out: the default plus staff grants,
/// never below zero; None for no limit.
pub fn limit_for(default: u32, granted: i64, unlimited: bool) -> Option<u32> {
    if unlimited {
        return None;
    }
    Some((i64::from(default) + granted).clamp(0, i64::from(u32::MAX)) as u32)
}

/// Why an invite cannot make an account.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Unknown, used, revoked, expired, or not for making accounts. One
    /// answer for all, so codes cannot be probed.
    Invalid,
    /// It is bound to another address.
    WrongEmail,
}

/// The parts of an invite that decide whether it admits someone.
#[derive(Debug)]
pub struct Admits<'a> {
    pub kind: &'a str,
    pub email: Option<&'a str>,
    pub status: InviteStatus,
}

/// Whether an invite lets `email` make an account (`for_account`) or join
/// its workspace with an existing one.
pub fn admits(invite: Option<&Admits>, email: &str, for_account: bool) -> std::result::Result<(), Refusal> {
    let Some(invite) = invite else {
        return Err(Refusal::Invalid);
    };
    if invite.status != InviteStatus::Pending || (for_account && invite.kind != "account") {
        return Err(Refusal::Invalid);
    }
    match invite.email {
        Some(bound) if !bound.eq_ignore_ascii_case(email.trim()) => Err(Refusal::WrongEmail),
        _ => Ok(()),
    }
}

/// A trimmed, lowercased address, if it looks like one.
pub fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_lowercase();
    let well_formed = email.len() <= 254
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !domain.contains('@'))
        && !email.contains(char::is_whitespace);
    well_formed.then_some(email)
}

/// An address with most of its local part hidden: `a•••@example.com`.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}•••@{domain}")
        }
        None => "•••".to_owned(),
    }
}

/// The fixed window a moment falls in.
pub fn bucket(now_ms: u64, window_ms: u64) -> u64 {
    now_ms / window_ms
}

/// Whether staff may be sent a summary of new requests: none was sent yet,
/// or the last went before `since` (15 minutes ago). RFC 3339 times.
pub fn summary_due(last: Option<&str>, since: &str) -> bool {
    last.is_none_or(|last| last <= since)
}

// --- Rows ---------------------------------------------------------------------

const COLUMNS: &str = "i.id, i.hint, i.sealed_code, i.email, i.kind, i.workspace_id, w.slug AS workspace,
  i.inviter_id, iu.username AS inviter, i.staff, i.charged_to, i.charged_workspace_id, i.created_at, i.expires_at,
  i.revoked_at, i.redeemed_by, ru.username AS redeemer, i.redeemed_at
  FROM invites i
  LEFT JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
  LEFT JOIN users iu ON iu.id = i.inviter_id
  LEFT JOIN users ru ON ru.id = i.redeemed_by";

#[derive(Debug, Deserialize)]
pub struct InviteRow {
    pub id: String,
    pub hint: String,
    pub sealed_code: Option<String>,
    pub email: Option<String>,
    pub kind: String,
    pub workspace_id: Option<String>,
    pub workspace: Option<String>,
    pub inviter_id: Option<String>,
    pub inviter: Option<String>,
    pub staff: Option<String>,
    pub charged_to: String,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub redeemer: Option<String>,
    pub redeemed_at: Option<String>,
}

impl InviteRow {
    pub fn status(&self, now: &str) -> InviteStatus {
        status_of(self.revoked_at.as_deref(), self.redeemed_at.as_deref(), &self.expires_at, now)
    }

    fn admits(&self, now: &str) -> Admits<'_> {
        Admits {
            kind: &self.kind,
            email: self.email.as_deref(),
            status: self.status(now),
        }
    }
}

fn kind_of(kind: &str) -> InviteKind {
    if kind == "workspace" { InviteKind::Workspace } else { InviteKind::Account }
}

fn charge_of(charged_to: &str) -> InviteCharge {
    match charged_to {
        "user" => InviteCharge::User,
        "workspace" => InviteCharge::Workspace,
        _ => InviteCharge::None,
    }
}

#[derive(Deserialize)]
struct Count {
    n: f64,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct WaitlistRow {
    id: String,
    email: String,
    about: Option<String>,
    status: String,
    invite_id: Option<String>,
    decided_by: Option<String>,
    decided_at: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    joined_as: Option<String>,
    created_at: String,
    updated_at: String,
}

const WAITLIST_COLUMNS: &str = "wl.id, wl.email, wl.about, wl.status, wl.invite_id, wl.decided_by, wl.decided_at, wl.note,
  ju.username AS joined_as, wl.created_at, wl.updated_at
  FROM waitlist wl
  LEFT JOIN invites wi ON wi.id = wl.invite_id
  LEFT JOIN users ju ON ju.id = wi.redeemed_by";

impl From<WaitlistRow> for WaitlistEntry {
    fn from(row: WaitlistRow) -> Self {
        WaitlistEntry {
            id: row.id,
            email: row.email,
            about: row.about,
            status: match row.status.as_str() {
                "invited" => WaitlistStatus::Invited,
                "dismissed" => WaitlistStatus::Dismissed,
                _ => WaitlistStatus::Waiting,
            },
            invite_id: row.invite_id,
            decided_by: row.decided_by,
            decided_at: row.decided_at,
            note: row.note,
            joined_as: row.joined_as,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// What a new account is made from.
pub struct NewAccount<'a> {
    /// Checked by the caller: valid, and free.
    pub username: &'a str,
    /// Lowercased and checked by the caller.
    pub email: &'a str,
    /// Empty for an account with no password (made through GitHub).
    pub password_hash: &'a str,
    /// Whether the address is confirmed already (GitHub's verified email).
    pub verified: bool,
    pub invite_code: Option<&'a str>,
    /// Who is asking, for rate limits.
    pub client: Option<&'a str>,
}

/// What an invite was made for.
struct Draft<'a> {
    email: Option<&'a str>,
    kind: &'a str,
    /// The workspace using it joins.
    workspace_id: Option<&'a str>,
    inviter: Option<&'a User>,
    staff: Option<&'a str>,
    /// `user`, `workspace` or `none`; the workspace for `workspace`; and
    /// the limit when there is one.
    charged_to: &'a str,
    charged_workspace_id: Option<&'a str>,
    limit: Option<u32>,
}

impl Identity {
    // --- Settings ---

    pub fn registration_mode(&self) -> RegistrationMode {
        RegistrationMode::parse(self.env.var("REGISTRATION_MODE").ok().map(|v| v.to_string()).as_deref())
    }

    /// Whether new accounts need an invite code.
    pub fn invites_required(&self) -> bool {
        self.registration_mode() == RegistrationMode::Invite
    }

    fn var_number(&self, name: &str) -> Option<u64> {
        self.env.var(name).ok()?.to_string().trim().parse().ok()
    }

    fn invites_per_user(&self) -> u32 {
        self.var_number("INVITES_PER_USER").map_or(INVITES_PER_USER, |n| n.min(u64::from(u32::MAX)) as u32)
    }

    fn invite_ttl_days(&self) -> u64 {
        self.var_number("INVITE_TTL_DAYS").filter(|days| (1..=365).contains(days)).unwrap_or(INVITE_TTL_DAYS)
    }

    /// The workspaces whose owners invite without limit: g1t's own.
    fn staff_workspaces(&self) -> Vec<String> {
        self.env
            .var("INVITE_STAFF_WORKSPACES")
            .map(|v| v.to_string())
            .unwrap_or_default()
            .split(',')
            .map(|slug| slug.trim().to_lowercase())
            .filter(|slug| !slug.is_empty())
            .collect()
    }

    fn invite_sealer(&self) -> Option<Sealer> {
        Sealer::new(&self.env.secret("IDENTITY_KEY").ok()?.to_string())
    }

    // --- Rate limits ---

    /// Counts one more hit on `key` this hour; false once past `limit`.
    async fn hit(&self, key: &str, limit: u32) -> Result<bool> {
        let now = bucket(now_ms(), HOUR_MS);
        let hits = self
            .db
            .prepare(
                "INSERT INTO rate_limits (key, bucket, hits) VALUES (?1, ?2, 1)
                 ON CONFLICT (key) DO UPDATE SET
                   hits = CASE WHEN rate_limits.bucket = excluded.bucket THEN rate_limits.hits + 1 ELSE 1 END,
                   bucket = excluded.bucket
                 RETURNING hits AS n",
            )
            .bind(&[key.into(), (now as f64).into()])?
            .first::<Count>(None)
            .await?
            .map_or(1.0, |count| count.n);
        if hits <= 1.0 {
            // A new window: forget windows gone by.
            self.db
                .prepare("DELETE FROM rate_limits WHERE bucket < ?")
                .bind(&[((now.saturating_sub(1)) as f64).into()])?
                .run()
                .await?;
        }
        Ok(hits <= f64::from(limit))
    }

    /// Hits on `key` this hour, without adding one.
    async fn hits(&self, key: &str) -> Result<u32> {
        Ok(self
            .db
            .prepare("SELECT hits AS n FROM rate_limits WHERE key = ? AND bucket = ?")
            .bind(&[key.into(), (bucket(now_ms(), HOUR_MS) as f64).into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n as u32))
    }

    /// Whether `client` has tried too many wrong codes this hour.
    async fn turned_away(&self, client: Option<&str>) -> Result<bool> {
        Ok(match client {
            Some(client) => self.hits(&format!("invite.fail:{}", crypto::sha256_hex(client))).await? >= FAILURES_PER_HOUR,
            None => false,
        })
    }

    async fn count_failure(&self, client: Option<&str>) -> Result<()> {
        if let Some(client) = client {
            self.hit(&format!("invite.fail:{}", crypto::sha256_hex(client)), FAILURES_PER_HOUR).await?;
        }
        Ok(())
    }

    // --- Reading ---

    async fn invite_by_code(&self, code: &str) -> Result<Option<InviteRow>> {
        let Some(body) = normalize_code(code) else {
            return Ok(None);
        };
        self.db
            .prepare(format!("SELECT {COLUMNS} WHERE i.code_hash = ?"))
            .bind(&[code_hash(&body).into()])?
            .first::<InviteRow>(None)
            .await
    }

    async fn invite_by_id(&self, id: &str) -> Result<Option<InviteRow>> {
        self.db
            .prepare(format!("SELECT {COLUMNS} WHERE i.id = ?"))
            .bind(&[id.into()])?
            .first::<InviteRow>(None)
            .await
    }

    /// An invite as shown, with its code when `reveal` and it is pending.
    fn shown(&self, row: InviteRow, reveal: bool, staff_view: bool) -> Invite {
        let now = rfc3339(now_ms());
        let status = row.status(&now);
        let code = if reveal && status == InviteStatus::Pending {
            row.sealed_code
                .as_deref()
                .and_then(|sealed| self.invite_sealer()?.open(sealed, &row.id))
        } else {
            None
        };
        Invite {
            id: row.id,
            code,
            hint: row.hint,
            email: row.email,
            kind: kind_of(&row.kind),
            workspace: row.workspace,
            status,
            charged_to: charge_of(&row.charged_to),
            invited_by: row.inviter,
            redeemed_by: row.redeemer,
            created_at: row.created_at,
            expires_at: row.expires_at,
            redeemed_at: row.redeemed_at,
            revoked_at: row.revoked_at,
            staff: if staff_view { row.staff } else { None },
        }
    }

    async fn rows(&self, filter: &str, binds: &[JsValue], limit: u32) -> Result<Vec<InviteRow>> {
        self.db
            .prepare(format!("SELECT {COLUMNS} {filter} ORDER BY i.created_at DESC, i.id DESC LIMIT {limit}"))
            .bind(binds)?
            .all()
            .await?
            .results::<InviteRow>()
    }

    async fn granted(&self, target: GrantTarget, id: &str) -> Result<i64> {
        Ok(self
            .db
            .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM invite_grants WHERE target_kind = ? AND target_id = ?")
            .bind(&[target.as_str().into(), id.into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n as i64))
    }

    async fn is_invite_staff(&self, user_id: &str) -> Result<bool> {
        let staff = self.staff_workspaces();
        if staff.is_empty() {
            return Ok(false);
        }
        let marks = vec!["?"; staff.len()].join(", ");
        let mut binds: Vec<JsValue> = vec![user_id.into()];
        binds.extend(staff.iter().map(|slug| JsValue::from(slug.as_str())));
        Ok(self
            .db
            .prepare(format!(
                "SELECT count(*) AS n FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                 WHERE m.user_id = ? AND m.role = 'owner' AND w.deleted_at IS NULL AND w.slug IN ({marks})"
            ))
            .bind(&binds)?
            .first::<Count>(None)
            .await?
            .is_some_and(|count| count.n > 0.0))
    }

    async fn used(&self, column: &'static str, id: &str, charged_to: &str) -> Result<u32> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT count(*) AS n FROM invites i WHERE i.{column} = ? AND i.charged_to = ? AND {}",
                counted_sql()
            ))
            .bind(&[id.into(), charged_to.into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n as u32))
    }

    /// A person's own allowance.
    pub async fn user_allowance(&self, user_id: &str) -> Result<Allowance> {
        let unlimited = self.is_invite_staff(user_id).await?;
        let granted = self.granted(GrantTarget::User, user_id).await?;
        let used = self.used("inviter_id", user_id, "user").await?;
        Ok(Allowance::new(limit_for(self.invites_per_user(), granted, unlimited), used))
    }

    /// A workspace's shared allowance: only what staff granted it.
    async fn workspace_allowance(&self, workspace_id: &str) -> Result<Allowance> {
        let granted = self.granted(GrantTarget::Workspace, workspace_id).await?;
        let used = self.used("charged_workspace_id", workspace_id, "workspace").await?;
        Ok(Allowance::new(limit_for(0, granted, false), used))
    }

    async fn workspace_id(&self, slug: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .prepare("SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.trim().to_lowercase().into()])?
            .first::<Id>(None)
            .await?
            .map(|row| row.id))
    }

    /// Whether an address is any account's: confirmed on one, or the
    /// address a new account signed up with (emails.rs).
    async fn email_has_account(&self, email: &str) -> Result<bool> {
        self.email_in_use(email).await
    }

    // --- The gate ---

    /// Makes an account: the only place one is made. While registration is
    /// invite-only, `invite_code` must admit `email`; the code is spent in
    /// the same transaction as the account is made. An invite for a
    /// workspace also joins it. In open mode a code is used if it is good
    /// and otherwise ignored.
    pub async fn create_account(&self, new: NewAccount<'_>) -> Result<Outcome<User>> {
        let required = self.invites_required();
        let code = new.invite_code.map(str::trim).filter(|code| !code.is_empty());
        let mut invite = None;
        match code {
            None if required => return Ok(Outcome::fail(FailureCode::Forbidden, MISSING)),
            None => {}
            Some(code) => {
                if required && self.turned_away(new.client).await? {
                    return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
                }
                let row = self.invite_by_code(code).await?;
                let now = rfc3339(now_ms());
                match admits(row.as_ref().map(|row| row.admits(&now)).as_ref(), new.email, true) {
                    Ok(()) => invite = row,
                    Err(_) if !required => {}
                    Err(refusal) => {
                        self.count_failure(new.client).await?;
                        let message = if refusal == Refusal::WrongEmail { WRONG_EMAIL } else { INVALID };
                        return Ok(Outcome::fail(FailureCode::Forbidden, message));
                    }
                }
            }
        }

        // An invite bound to this address arrived there: following its link
        // proves the address as well as a confirmation link would, so no
        // second email asks for it.
        let verified = new.verified || invite.as_ref().is_some_and(|row| row.email.is_some());
        let user = User {
            id: new_id("usr", now_ms()),
            username: new.username.to_owned(),
            verified,
            ..User::default()
        };
        let verified_at = if verified { SQL_NOW } else { "NULL" };
        let values = [
            JsValue::from(user.id.as_str()),
            new.username.into(),
            new.email.into(),
            new.password_hash.into(),
        ];
        let made = match &invite {
            None => {
                self.db
                    .prepare(format!(
                        "INSERT INTO users (id, username, email, password_hash, email_verified_at)
                         VALUES (?, ?, ?, ?, {verified_at})"
                    ))
                    .bind(&values)?
                    .run()
                    .await
                    .map(|_| ())
            }
            // Spend the code, then make the account only if this request
            // spent it: one transaction, so a second use finds it gone.
            Some(row) => {
                let mut insert = values.to_vec();
                insert.extend([JsValue::from(row.id.as_str()), user.id.as_str().into()]);
                self.db
                    .batch(vec![
                        self.db
                            .prepare(format!(
                                "UPDATE invites SET redeemed_by = ?, redeemed_at = {SQL_NOW}, sealed_code = NULL
                                 WHERE id = ? AND kind = 'account' AND redeemed_at IS NULL AND revoked_at IS NULL
                                   AND expires_at > {SQL_NOW}"
                            ))
                            .bind(&[user.id.as_str().into(), row.id.as_str().into()])?,
                        self.db
                            .prepare(format!(
                                "INSERT INTO users (id, username, email, password_hash, email_verified_at)
                                 SELECT ?, ?, ?, ?, {verified_at}
                                 WHERE EXISTS (SELECT 1 FROM invites WHERE id = ? AND redeemed_by = ?)"
                            ))
                            .bind(&insert)?,
                    ])
                    .await
                    .map(|_| ())
            }
        };
        if let Err(error) = made {
            // Someone took the username or email a moment ago; nothing
            // was written, the code included.
            if error.to_string().contains("UNIQUE") {
                return Ok(Outcome::fail(FailureCode::Conflict, "That username or email is already registered."));
            }
            return Err(error);
        }
        let exists = self
            .db
            .prepare("SELECT id FROM users WHERE id = ?")
            .bind(&[user.id.as_str().into()])?
            .first::<Id>(None)
            .await?
            .is_some();
        if !exists {
            // Another sign-up spent the code first.
            self.count_failure(new.client).await?;
            return Ok(Outcome::fail(FailureCode::Forbidden, INVALID));
        }
        if let Some(row) = invite {
            self.after_redeemed(&row, &user, true).await?;
        }
        Ok(Outcome::Ok(user))
    }

    /// Joins the invite's workspace, and tells the event log and audit log.
    async fn after_redeemed(&self, row: &InviteRow, user: &User, created_account: bool) -> Result<()> {
        let mut joined = None;
        // A free workspace adds no one (paid.rs): a sign-up with an invite
        // from one sent before still makes the account, without joining.
        let free = match &row.workspace {
            Some(slug) => self.is_free_workspace(slug).await,
            None => false,
        };
        if let (Some(workspace_id), Some(slug), false) = (&row.workspace_id, &row.workspace, free) {
            self.db
                .prepare(
                    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                     VALUES (?, ?, 'member', ?)",
                )
                .bind(&[workspace_id.as_str().into(), user.id.as_str().into(), rfc3339(now_ms()).into()])?
                .run()
                .await?;
            joined = Some(slug.clone());
        }
        // A code sent with an invitation to collaborate on a repository:
        // using it accepts (access.rs).
        if let Err(error) = self.accept_invitations_of_code(&row.id, user).await {
            worker::console_error!("repository invitations for {} not accepted: {error}", row.id);
        }
        self.announce(
            "invite.redeemed",
            Some(&user.id),
            InviteRedeemed {
                invite_id: row.id.clone(),
                user_id: user.id.clone(),
                inviter_id: row.inviter_id.clone(),
                workspace_id: row.workspace_id.clone(),
                created_account,
            },
        )
        .await;
        if let Some(slug) = joined {
            let message = match &row.inviter {
                Some(inviter) => format!("Joined with an invite from {inviter}"),
                None => "Joined with an invite from g1t".to_owned(),
            };
            self.audit_invites(user, "invite.redeemed", vec![slug], Surface::Web, message).await;
        }
        Ok(())
    }

    // --- People's invites ---

    fn draft_allowed(user: &User) -> Option<&'static str> {
        if user.kind != PrincipalKind::User || user.acting.is_some() {
            return Some(PEOPLE_ONLY);
        }
        if !user.verified {
            return Some(CONFIRM_FIRST);
        }
        None
    }

    /// Stores a new invite and returns it with its code, or None when the
    /// allowance ran out between reading it and writing.
    async fn insert_invite(&self, draft: Draft<'_>) -> Result<Option<Invite>> {
        let body = new_code_body();
        let code = format_code(&body);
        let now = now_ms();
        let id = new_id("inv", now);
        let sealed = self.invite_sealer().map(|sealer| sealer.seal(&code, &id));
        let expires_at = rfc3339(now + self.invite_ttl_days() * 24 * HOUR_MS);
        let created_at = rfc3339(now);
        let opt = |value: Option<&str>| value.map_or(JsValue::NULL, JsValue::from);
        let mut binds = vec![
            JsValue::from(id.as_str()),
            code_hash(&body).into(),
            code_hint(&body).into(),
            opt(sealed.as_deref()),
            opt(draft.email),
            draft.kind.into(),
            opt(draft.workspace_id),
            opt(draft.inviter.map(|user| user.id.as_str())),
            opt(draft.staff),
            draft.charged_to.into(),
            opt(draft.charged_workspace_id),
            created_at.as_str().into(),
            expires_at.as_str().into(),
        ];
        // The allowance is checked in the insert itself, so two invites made
        // at once cannot both take the last one.
        let guard = match (draft.charged_to, draft.limit) {
            ("user", Some(limit)) => {
                binds.extend([opt(draft.inviter.map(|user| user.id.as_str())), f64::from(limit).into()]);
                format!(
                    "WHERE (SELECT count(*) FROM invites i WHERE i.inviter_id = ? AND i.charged_to = 'user' AND {}) < ?",
                    counted_sql()
                )
            }
            ("workspace", Some(limit)) => {
                binds.extend([opt(draft.charged_workspace_id), f64::from(limit).into()]);
                format!(
                    "WHERE (SELECT count(*) FROM invites i WHERE i.charged_workspace_id = ? AND i.charged_to = 'workspace' AND {}) < ?",
                    counted_sql()
                )
            }
            _ => String::new(),
        };
        let inserted = self
            .db
            .prepare(format!(
                "INSERT INTO invites (id, code_hash, hint, sealed_code, email, kind, workspace_id, inviter_id,
                   staff, charged_to, charged_workspace_id, created_at, expires_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? {guard}
                 RETURNING id"
            ))
            .bind(&binds)?
            .first::<Id>(None)
            .await?;
        if inserted.is_none() {
            return Ok(None);
        }
        self.announce(
            "invite.created",
            draft.inviter.map(|user| user.id.as_str()),
            InviteCreated {
                invite_id: id.clone(),
                inviter_id: draft.inviter.map(|user| user.id.clone()),
                workspace_id: draft.workspace_id.map(str::to_owned),
                bound: draft.email.is_some(),
            },
        )
        .await;
        let Some(row) = self.invite_by_id(&id).await? else {
            return Ok(None);
        };
        let mut invite = self.shown(row, false, false);
        invite.code = Some(code);
        Ok(Some(invite))
    }

    fn out_of_invites() -> Outcome<Invite> {
        Outcome::fail(
            FailureCode::Limit,
            "You have no invites left. Need more? Contact us at hey@flagon.io with the subject [g1t Invites].",
        )
    }

    pub async fn create_invite(&self, a: CreateInviteArgs) -> Result<Outcome<Invite>> {
        if let Some(reason) = Self::draft_allowed(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        let email = match a.email.as_deref().map(str::trim).filter(|email| !email.is_empty()) {
            Some(email) => match normalize_email(email) {
                Some(email) => Some(email),
                None => return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL)),
            },
            None => None,
        };
        if !self.hit(&format!("invite.create:{}", a.user.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        if let Some(email) = &email {
            if self.email_has_account(email).await? {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "That address already has a g1t account. Add them to a workspace from its People page instead.",
                ));
            }
            let pending = self
                .rows(
                    &format!(
                        "WHERE i.inviter_id = ? AND i.email = ? AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > {SQL_NOW}"
                    ),
                    &[a.user.id.as_str().into(), email.as_str().into()],
                    1,
                )
                .await?;
            if !pending.is_empty() {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "You already have a pending invite for that address. Revoke it to send a new one.",
                ));
            }
        }
        // A workspace's granted invites, for its owners.
        let (workspace_id, charged_to, limit) = match a.workspace.as_deref().map(str::trim).filter(|slug| !slug.is_empty()) {
            Some(slug) => {
                let slug = slug.to_lowercase();
                if a.user.role_in(&slug) != Some(Role::Owner) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, "Only a workspace's owners can use its invites."));
                }
                let Some(id) = self.workspace_id(&slug).await? else {
                    return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
                };
                let allowance = self.workspace_allowance(&id).await?;
                if allowance.exhausted() {
                    return Ok(Outcome::fail(
                        FailureCode::Limit,
                        format!("{slug} has no invites left. Need more? Contact us at hey@flagon.io with the subject [g1t Invites]."),
                    ));
                }
                (Some(id), "workspace", allowance.limit)
            }
            None => {
                let allowance = self.user_allowance(&a.user.id).await?;
                if allowance.exhausted() {
                    return Ok(Self::out_of_invites());
                }
                (None, "user", allowance.limit)
            }
        };
        let draft = Draft {
            email: email.as_deref(),
            kind: "account",
            workspace_id: None,
            inviter: Some(&a.user),
            staff: None,
            charged_to,
            charged_workspace_id: workspace_id.as_deref(),
            limit,
        };
        let Some(invite) = self.insert_invite(draft).await? else {
            return Ok(Self::out_of_invites());
        };
        if let (Some(email), Some(code)) = (&email, &invite.code) {
            let from = self.display_name(&a.user).await;
            self.send_invite_email(email, Some(&from), None, false, code, None).await;
        }
        let logs: Vec<String> = a.user.workspaces.iter().map(|membership| membership.slug.clone()).collect();
        self.audit_invites(&a.user, "invite.created", logs, a.surface.unwrap_or(Surface::Web), format!("Created invite {}", invite.hint))
            .await;
        Ok(Outcome::Ok(invite))
    }

    async fn send_invite_email(
        &self,
        to: &str,
        from: Option<&str>,
        workspace: Option<&str>,
        existing: bool,
        code: &str,
        note: Option<&str>,
    ) {
        let invite = crate::email::InviteEmail {
            to,
            from,
            workspace,
            joins_existing_account: existing,
            code,
            days: self.invite_ttl_days(),
            note,
        };
        if let Err(error) = crate::email::send_invite(&self.env, &invite).await {
            worker::console_error!("invite email failed: {error}");
        }
    }

    /// How an invite names the person who sent it: their name, else their
    /// username.
    async fn display_name(&self, user: &User) -> String {
        self.name_of("SELECT display_name AS name FROM users WHERE id = ?", &user.id)
            .await
            .unwrap_or_else(|| user.username.clone())
    }

    /// A workspace's name, as an invite shows it; its slug if it has none.
    async fn workspace_name(&self, workspace_id: &str, slug: &str) -> String {
        self.name_of("SELECT name FROM workspaces WHERE id = ?", workspace_id)
            .await
            .unwrap_or_else(|| slug.to_owned())
    }

    /// A name `sql` selects for `id`, if it has one. Only for wording an
    /// email, so a failed read is no name.
    async fn name_of(&self, sql: &str, id: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Name {
            name: Option<String>,
        }
        let read = async { self.db.prepare(sql).bind(&[id.into()])?.first::<Name>(None).await };
        read.await
            .ok()
            .flatten()
            .and_then(|row| row.name)
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
    }

    /// The address a pending invite is bound to, if it is: signing up with
    /// GitHub uses it when GitHub has confirmed it too (github.rs).
    pub(crate) async fn bound_email_of(&self, code: &str) -> Result<Option<String>> {
        let now = rfc3339(now_ms());
        Ok(self
            .invite_by_code(code)
            .await?
            .filter(|row| row.status(&now) == InviteStatus::Pending)
            .and_then(|row| row.email))
    }

    pub async fn list_invites(&self, a: UserArgs) -> Result<InvitesOverview> {
        let invites: Vec<Invite> = self
            .rows("WHERE i.inviter_id = ?", &[a.user.id.as_str().into()], LIST_LIMIT)
            .await?
            .into_iter()
            .map(|row| self.shown(row, true, false))
            .collect();
        let mut workspaces = Vec::new();
        for membership in a.user.workspaces.iter().filter(|membership| membership.role == Role::Owner) {
            if let Some(id) = self.workspace_id(&membership.slug).await?
                && self.granted(GrantTarget::Workspace, &id).await? != 0
            {
                workspaces.push(WorkspaceAllowance {
                    slug: membership.slug.clone(),
                    allowance: self.workspace_allowance(&id).await?,
                });
            }
        }
        Ok(InvitesOverview {
            mode: self.registration_mode(),
            allowance: self.user_allowance(&a.user.id).await?,
            workspaces,
            invites,
        })
    }

    /// Revokes a pending invite the person made, or one made for (or
    /// charged to) a workspace they own.
    pub async fn revoke_invite(&self, a: RemoveArgs) -> Result<Outcome<Invite>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let revoked = self
            .db
            .prepare(format!(
                "UPDATE invites SET revoked_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ?2 AND redeemed_at IS NULL AND revoked_at IS NULL
                   AND (inviter_id = ?1
                     OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1 AND role = 'owner')
                     OR charged_workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1 AND role = 'owner'))
                 RETURNING id"
            ))
            .bind(&[a.user.id.as_str().into(), a.id.as_str().into()])?
            .first::<Id>(None)
            .await?;
        let Some(Id { id }) = revoked else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no pending invite of yours with that id."));
        };
        let Some(row) = self.invite_by_id(&id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Invite not found."));
        };
        let logs = match &row.workspace {
            Some(slug) => vec![slug.clone()],
            None => a.user.workspaces.iter().map(|membership| membership.slug.clone()).collect(),
        };
        self.audit_invites(&a.user, "invite.revoked", logs, Surface::Web, format!("Revoked invite {}", row.hint)).await;
        Ok(Outcome::Ok(self.shown(row, false, false)))
    }

    /// What an invite code is for: who sent it, and which workspace it
    /// joins. Any code that cannot be used gets the same answer.
    pub async fn check_invite(&self, a: InviteCodeArgs) -> Result<Outcome<InvitePreview>> {
        if self.turned_away(a.client.as_deref()).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let now = rfc3339(now_ms());
        // A spent code is still a real one (160 random bits): saying what
        // became of it tells a guesser nothing.
        let row = self
            .invite_by_code(&a.code)
            .await?
            .filter(|row| a.any_status || row.status(&now) == InviteStatus::Pending);
        let Some(row) = row else {
            self.count_failure(a.client.as_deref()).await?;
            return Ok(Outcome::fail(FailureCode::NotFound, INVALID));
        };
        let status = row.status(&now);
        let pending = status == InviteStatus::Pending;
        // Whether it is the viewer's: for one of their confirmed addresses,
        // or, once used, used by them.
        let for_viewer = match &a.viewer {
            Some(viewer) if viewer.kind == PrincipalKind::User => match (&row.email, status) {
                (_, InviteStatus::Redeemed) => Some(row.redeemer.as_deref() == Some(viewer.username.as_str())),
                (Some(bound), _) => {
                    let mine = self.verified_emails(&viewer.id).await?;
                    Some(mine.iter().any(|address| address.eq_ignore_ascii_case(bound.trim())))
                }
                (None, _) => None,
            },
            _ => None,
        };
        let has_account = match (&row.email, pending) {
            (Some(bound), true) => self.email_has_account(bound).await?,
            _ => false,
        };
        let repository = self.repository_of_code(&row.id).await?;
        #[derive(Deserialize)]
        struct From {
            username: String,
            name: Option<String>,
            avatar: Option<String>,
        }
        let invited_by = match &row.inviter_id {
            Some(id) => self
                .db
                .prepare("SELECT username, display_name AS name, avatar FROM users WHERE id = ?")
                .bind(&[id.as_str().into()])?
                .first::<From>(None)
                .await?
                .map(|from| InviteFrom {
                    username: from.username,
                    name: from.name,
                    avatar: from.avatar,
                }),
            None => None,
        };
        let workspace = match &row.workspace_id {
            Some(id) => self
                .db
                .prepare("SELECT slug, name, avatar FROM workspaces WHERE id = ?")
                .bind(&[id.as_str().into()])?
                .first::<ProfileWorkspace>(None)
                .await?,
            None => None,
        };
        Ok(Outcome::Ok(InvitePreview {
            kind: kind_of(&row.kind),
            status,
            invited_by,
            workspace,
            repository,
            email: row.email.as_deref().map(mask_email),
            address: row.email.clone().filter(|_| pending),
            has_account,
            for_viewer,
            expires_at: row.expires_at,
        }))
    }

    /// A signed-in person uses a workspace invite sent to their address,
    /// or one sent with a repository invitation.
    pub async fn accept_invite(&self, a: AcceptInviteArgs) -> Result<Outcome<String>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can accept an invite."));
        }
        // Any of the person's confirmed addresses can match an invite bound
        // to one (emails.rs); the primary otherwise.
        let verified = self.verified_emails(&a.user.id).await?;
        let Some(primary) = verified.first().cloned() else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first, then open the invite again."));
        };
        let now = rfc3339(now_ms());
        let row = self.invite_by_code(&a.code).await?;
        let email = row
            .as_ref()
            .and_then(|row| row.email.as_deref())
            .and_then(|bound| verified.iter().find(|address| address.eq_ignore_ascii_case(bound.trim())).cloned())
            .unwrap_or(primary);
        // What using it gives an account that exists: a workspace, or a
        // repository it was sent with.
        let repository = match &row {
            Some(row) => self.repository_of_code(&row.id).await?,
            None => None,
        };
        let joins = row.as_ref().is_some_and(joins_workspace) || repository.is_some();
        if let Err(refusal) = admits(row.as_ref().map(|row| row.admits(&now)).as_ref(), &email, false) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                if refusal == Refusal::WrongEmail { WRONG_EMAIL } else { INVALID },
            ));
        }
        let Some(row) = row.filter(|_| joins) else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "You already have a g1t account, so this invite has nothing more to give you. Pass it on to someone who needs it.",
            ));
        };
        // What the workspace asks of its members (security.rs); nothing yet.
        if let Some(slug) = row.workspace.as_deref()
            && let Some(why) = self.policy_refusal(&a.user.id, slug).await?
        {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        // An invite sent before the workspace was free waits until it
        // starts the plan (paid.rs); the code is not used up.
        let joins_slug = row.workspace.clone().or_else(|| {
            repository.as_ref().and_then(|r| r.name.split_once('/').map(|(workspace, _)| workspace.to_owned()))
        });
        if let Some(slug) = joins_slug.as_deref()
            && let Some(refused) = self.free_workspace_refusal(slug).await?
        {
            return Ok(refused);
        }
        let claimed = self
            .db
            .prepare(format!(
                "UPDATE invites SET redeemed_by = ?, redeemed_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > {SQL_NOW}
                 RETURNING id"
            ))
            .bind(&[a.user.id.as_str().into(), row.id.as_str().into()])?
            .first::<Id>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(FailureCode::Forbidden, INVALID));
        }
        let lands = row
            .workspace
            .clone()
            .or_else(|| repository.map(|repository| repository.name))
            .unwrap_or_default();
        self.after_redeemed(&row, &a.user, false).await?;
        Ok(Outcome::Ok(lands))
    }

    // --- Workspace invitations ---

    pub async fn invite_member(&self, a: InviteMemberArgs) -> Result<Outcome<Invite>> {
        let slug = a.slug.trim().to_lowercase();
        if let Some(reason) = Self::draft_allowed(&a.actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        if a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can invite people to a workspace."));
        }
        let Some(email) = normalize_email(&a.email) else {
            return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL));
        };
        let Some(workspace_id) = self.workspace_id(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        // A free workspace invites no one until it starts the plan (paid.rs).
        if let Some(refused) = self.free_workspace_refusal(&slug).await? {
            return Ok(refused);
        }
        if !self.hit(&format!("invite.create:{}", a.actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let pending = self
            .rows(
                &format!(
                    "WHERE i.workspace_id = ? AND i.email = ?
                       AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > {SQL_NOW}"
                ),
                &[workspace_id.as_str().into(), email.as_str().into()],
                1,
            )
            .await?;
        if !pending.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "There is already a pending invite for that address. Revoke it to send a new one.",
            ));
        }
        let has_account = self.email_has_account(&email).await?;
        let draft = if has_account {
            // Costs nothing: the person is on g1t already.
            Draft {
                email: Some(&email),
                kind: "workspace",
                workspace_id: Some(&workspace_id),
                inviter: Some(&a.actor),
                staff: None,
                charged_to: "none",
                charged_workspace_id: None,
                limit: None,
            }
        } else {
            let shared = self.workspace_allowance(&workspace_id).await?;
            let (charged_to, charged_workspace_id, limit) = if shared.remaining.is_some_and(|left| left > 0) {
                ("workspace", Some(workspace_id.as_str()), shared.limit)
            } else {
                let own = self.user_allowance(&a.actor.id).await?;
                if own.exhausted() {
                    return Ok(Self::out_of_invites());
                }
                ("user", None, own.limit)
            };
            Draft {
                email: Some(&email),
                kind: "account",
                workspace_id: Some(&workspace_id),
                inviter: Some(&a.actor),
                staff: None,
                charged_to,
                charged_workspace_id,
                limit,
            }
        };
        let Some(invite) = self.insert_invite(draft).await? else {
            return Ok(Self::out_of_invites());
        };
        if let Some(code) = &invite.code {
            let from = self.display_name(&a.actor).await;
            let workspace = self.workspace_name(&workspace_id, &slug).await;
            self.send_invite_email(&email, Some(&from), Some(&workspace), has_account, code, None).await;
        }
        self.audit_invites(
            &a.actor,
            "invite.created",
            vec![slug.clone()],
            a.surface.unwrap_or(Surface::Web),
            format!("Invited {email} to {slug}"),
        )
        .await;
        Ok(Outcome::Ok(invite))
    }

    /// An invite code for an address without an account, invited to
    /// collaborate on one repository of `workspace_id` (access.rs). Charged
    /// as a workspace invite is: the workspace's shared invites first, then
    /// the inviter's own. The code joins no workspace; redeeming it accepts
    /// the repository invitation that names it.
    pub(crate) async fn repo_invite_code(&self, actor: &User, email: &str, workspace_id: &str) -> Result<Outcome<Invite>> {
        if let Some(reason) = Self::draft_allowed(actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        if !self.hit(&format!("invite.create:{}", actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let shared = self.workspace_allowance(workspace_id).await?;
        let (charged_to, charged_workspace_id, limit) = if shared.remaining.is_some_and(|left| left > 0) {
            ("workspace", Some(workspace_id), shared.limit)
        } else {
            let own = self.user_allowance(&actor.id).await?;
            if own.exhausted() {
                return Ok(Self::out_of_invites());
            }
            ("user", None, own.limit)
        };
        let draft = Draft {
            email: Some(email),
            kind: "account",
            workspace_id: None,
            inviter: Some(actor),
            staff: None,
            charged_to,
            charged_workspace_id,
            limit,
        };
        Ok(match self.insert_invite(draft).await? {
            Some(invite) => Outcome::Ok(invite),
            None => Self::out_of_invites(),
        })
    }

    /// Revokes an invite code made for a repository invitation, when that
    /// invitation is revoked. Only a pending code changes.
    pub(crate) async fn revoke_code(&self, invite_id: &str) -> Result<()> {
        self.db
            .prepare(format!(
                "UPDATE invites SET revoked_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL"
            ))
            .bind(&[invite_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn workspace_invites(&self, a: ListMembersArgs) -> Result<Outcome<Vec<Invite>>> {
        let slug = a.slug.trim().to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.role_in(&slug) == Some(Role::Owner)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only owners can see a workspace's invites."));
        }
        let Some(workspace_id) = self.workspace_id(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let rows = self.rows("WHERE i.workspace_id = ?", &[workspace_id.as_str().into()], LIST_LIMIT).await?;
        Ok(Outcome::Ok(rows.into_iter().map(|row| self.shown(row, true, false)).collect()))
    }

    pub async fn revoke_workspace_invite(&self, a: WorkspaceInviteArgs) -> Result<Outcome<Invite>> {
        let slug = a.slug.trim().to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can revoke a workspace's invites."));
        }
        self.revoke_invite(RemoveArgs { user: a.actor, id: a.id }).await
    }

    // --- The waitlist ---

    pub async fn request_access(&self, a: RequestAccessArgs) -> Result<Outcome<bool>> {
        let Some(email) = normalize_email(&a.email) else {
            return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL));
        };
        let allowed = match a.client.as_deref().filter(|client| !client.is_empty()) {
            Some(client) => self.hit(&format!("waitlist:{}", crypto::sha256_hex(client)), REQUESTS_PER_HOUR).await?,
            None => self.hit("waitlist:anonymous", ANONYMOUS_REQUESTS_PER_HOUR).await?,
        };
        if !allowed {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let about: String = a.about.trim().chars().take(MAX_WAITLIST_ABOUT).collect();
        let now = rfc3339(now_ms());
        #[derive(Deserialize)]
        struct Upserted {
            id: String,
            created_at: String,
        }
        let row = self
            .db
            .prepare(
                "INSERT INTO waitlist (id, email, about, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'waiting', ?4, ?4)
                 ON CONFLICT (email) DO UPDATE SET
                   about = COALESCE(excluded.about, waitlist.about), updated_at = excluded.updated_at
                 RETURNING id, created_at",
            )
            .bind(&[
                new_id("wl", now_ms()).into(),
                email.as_str().into(),
                if about.is_empty() { JsValue::NULL } else { about.as_str().into() },
                now.as_str().into(),
            ])?
            .first::<Upserted>(None)
            .await?;
        if let Some(row) = row.filter(|row| row.created_at == now) {
            self.announce("waitlist.requested", None, WaitlistRequested { entry_id: row.id.clone() }).await;
            self.acknowledge_request(&row.id, &email).await?;
            self.notify_staff_of_requests().await?;
        }
        Ok(Outcome::Ok(true))
    }

    /// The one confirmation an address gets for asking: claimed in the
    /// database first, so a repeat request (or two at once) never sends a
    /// second, and capped across everyone, since anyone can type any
    /// address.
    async fn acknowledge_request(&self, id: &str, email: &str) -> Result<()> {
        if !self.hit("waitlist.ack", CONFIRMATIONS_PER_HOUR).await? {
            return Ok(());
        }
        let claimed = self
            .db
            .prepare(format!(
                "UPDATE waitlist SET acknowledged_at = {SQL_NOW} WHERE id = ? AND acknowledged_at IS NULL RETURNING id"
            ))
            .bind(&[id.into()])?
            .first::<Id>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        if let Err(error) = crate::email::send_waitlist_confirmation(&self.env, email).await {
            worker::console_error!("waitlist confirmation failed: {error}");
            // Not sent: leave it unclaimed, so staff can see it was not.
            self.db
                .prepare("UPDATE waitlist SET acknowledged_at = NULL WHERE id = ?")
                .bind(&[id.into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    /// Where staff hear about new requests: WAITLIST_NOTIFY_EMAIL, unset or
    /// empty for nobody.
    fn waitlist_notify_email(&self) -> Option<String> {
        let to = self.env.var("WAITLIST_NOTIFY_EMAIL").ok()?.to_string();
        normalize_email(&to)
    }

    /// Tells staff about every request they have not heard about, unless a
    /// summary went in the last 15 minutes: then the next request after
    /// that brings them all in one. The rows are claimed before sending, so
    /// two requests at once send one summary.
    pub(crate) async fn notify_staff_of_requests(&self) -> Result<()> {
        let Some(to) = self.waitlist_notify_email() else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Last {
            at: Option<String>,
        }
        let last = self
            .db
            .prepare("SELECT max(notified_at) AS at FROM waitlist")
            .first::<Last>(None)
            .await?
            .and_then(|last| last.at);
        let now = now_ms();
        if !summary_due(last.as_deref(), &rfc3339(now.saturating_sub(SUMMARY_EVERY_MS))) {
            return Ok(());
        }
        let stamp = rfc3339(now);
        #[derive(Deserialize)]
        struct New {
            email: String,
            about: Option<String>,
            created_at: String,
        }
        let mut new = self
            .db
            .prepare(
                "UPDATE waitlist SET notified_at = ? WHERE notified_at IS NULL AND status = 'waiting'
                 RETURNING email, about, created_at",
            )
            .bind(&[stamp.as_str().into()])?
            .all()
            .await?
            .results::<New>()?;
        if new.is_empty() {
            return Ok(());
        }
        new.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        let waiting = self
            .db
            .prepare("SELECT count(*) AS n FROM waitlist WHERE status = 'waiting'")
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n as u32);
        let new: Vec<crate::email::Requested> = new
            .into_iter()
            .map(|row| crate::email::Requested { email: row.email, about: row.about })
            .collect();
        if let Err(error) = crate::email::send_waitlist_summary(&self.env, &to, &new, waiting).await {
            worker::console_error!("waitlist summary failed: {error}");
            // Not sent: the next request tries again with these too.
            self.db
                .prepare("UPDATE waitlist SET notified_at = NULL WHERE notified_at = ?")
                .bind(&[stamp.as_str().into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    // --- Staff ---

    pub async fn admin_waitlist(&self, a: AdminWaitlistArgs) -> Result<Vec<WaitlistEntry>> {
        let mut filters = Vec::new();
        let mut binds: Vec<JsValue> = Vec::new();
        if let Some(status) = a.status {
            filters.push("wl.status = ?".to_owned());
            binds.push(status.as_str().into());
        }
        if let Some(pattern) = crate::admin::like_pattern(a.query.as_deref()) {
            filters.push("(wl.email LIKE ? ESCAPE '\\' OR lower(wl.about) LIKE ? ESCAPE '\\')".to_owned());
            binds.push(pattern.as_str().into());
            binds.push(pattern.as_str().into());
        }
        let filter = if filters.is_empty() { String::new() } else { format!("WHERE {}", filters.join(" AND ")) };
        Ok(self
            .db
            .prepare(format!(
                "SELECT {WAITLIST_COLUMNS} {filter} ORDER BY wl.created_at DESC, wl.id DESC LIMIT {ADMIN_INVITES_LIMIT}"
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<WaitlistRow>()?
            .into_iter()
            .map(WaitlistEntry::from)
            .collect())
    }

    async fn waitlist_entry(&self, id: &str) -> Result<Option<WaitlistRow>> {
        self.db
            .prepare(format!("SELECT {WAITLIST_COLUMNS} WHERE wl.id = ?"))
            .bind(&[id.into()])?
            .first::<WaitlistRow>(None)
            .await
    }

    /// How many requests are waiting, for sudo's navigation.
    pub async fn admin_waitlist_pending(&self) -> Result<u32> {
        Ok(self
            .db
            .prepare("SELECT count(*) AS n FROM waitlist WHERE status = 'waiting'")
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n as u32))
    }

    pub async fn admin_decide_waitlist(&self, a: AdminDecideWaitlistArgs) -> Result<Outcome<WaitlistEntry>> {
        let Some(entry) = self.waitlist_entry(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "That request is not on the waitlist."));
        };
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member decided."));
        }
        if entry.status != "waiting" {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} was already {} by {}.", entry.email, entry.status, entry.decided_by.as_deref().unwrap_or("staff")),
            ));
        }
        let note: String = a.note.as_deref().unwrap_or_default().trim().chars().take(MAX_WAITLIST_NOTE).collect();
        let note = (!note.is_empty()).then_some(note);
        let mut invite_id = JsValue::NULL;
        if a.approve {
            if self.email_has_account(&entry.email).await? {
                return Ok(Outcome::fail(FailureCode::Conflict, "That address already has a g1t account."));
            }
            let minted = match self.mint_staff_invite(Some(entry.email.clone()), staff, note.as_deref()).await? {
                Outcome::Ok(invite) => invite,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            invite_id = minted.id.as_str().into();
        }
        self.db
            .prepare(format!(
                "UPDATE waitlist SET status = ?, invite_id = COALESCE(?, invite_id), decided_by = ?, decided_at = {SQL_NOW},
                   note = ?, notified_at = COALESCE(notified_at, {SQL_NOW})
                 WHERE id = ?"
            ))
            .bind(&[
                if a.approve { "invited" } else { "dismissed" }.into(),
                invite_id,
                staff.into(),
                note.as_deref().map_or(JsValue::NULL, JsValue::from),
                entry.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(match self.waitlist_entry(&entry.id).await? {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, "That request is not on the waitlist."),
        })
    }

    pub async fn admin_invites(&self, a: AdminInvitesArgs) -> Result<Vec<Invite>> {
        let query = a.query.as_deref().map(str::trim).filter(|query| !query.is_empty());
        let rows = match query {
            None => self.rows("", &[], ADMIN_INVITES_LIMIT as u32).await?,
            Some(query) => {
                // A code, or its start: matched by its hint.
                let prefix = query.to_lowercase();
                let prefix = prefix.strip_prefix("g1t-").unwrap_or(&prefix).replace('-', "");
                let hint = (prefix.len() >= GROUP && prefix.chars().all(|c| ALPHABET.contains(&(c as u8))))
                    .then(|| code_hint(&prefix));
                let pattern = crate::admin::like_pattern(Some(query)).unwrap_or_default();
                let mut binds: Vec<JsValue> = vec![pattern.as_str().into(), pattern.as_str().into(), pattern.as_str().into()];
                let mut filter = "WHERE (lower(i.email) LIKE ? ESCAPE '\\' OR iu.username LIKE ? ESCAPE '\\' OR ru.username LIKE ? ESCAPE '\\'".to_owned();
                if let Some(hint) = hint {
                    filter.push_str(" OR i.hint = ?");
                    binds.push(hint.into());
                }
                filter.push(')');
                self.rows(&filter, &binds, ADMIN_INVITES_LIMIT as u32).await?
            }
        };
        Ok(rows.into_iter().map(|row| self.shown(row, false, true)).collect())
    }

    pub async fn admin_revoke_invite(&self, a: AdminRevokeInviteArgs) -> Result<Outcome<Invite>> {
        let revoked = self
            .db
            .prepare(format!(
                "UPDATE invites SET revoked_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING id"
            ))
            .bind(&[a.id.as_str().into()])?
            .first::<Id>(None)
            .await?;
        if revoked.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "Only a pending invite can be revoked."));
        }
        worker::console_log!("invite {} revoked by staff {}", a.id, a.staff);
        Ok(match self.invite_by_id(&a.id).await? {
            Some(row) => Outcome::Ok(self.shown(row, false, true)),
            None => Outcome::fail(FailureCode::NotFound, "Invite not found."),
        })
    }

    pub async fn admin_mint_invite(&self, a: AdminMintInviteArgs) -> Result<Outcome<Invite>> {
        self.mint_staff_invite(a.email, &a.staff, None).await
    }

    /// An invite staff make, emailed with `note` when it is for an address.
    async fn mint_staff_invite(&self, email: Option<String>, staff: &str, note: Option<&str>) -> Result<Outcome<Invite>> {
        let staff = staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is minting it."));
        }
        let email = match email.as_deref().map(str::trim).filter(|email| !email.is_empty()) {
            Some(email) => match normalize_email(email) {
                Some(email) => Some(email),
                None => return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL)),
            },
            None => None,
        };
        let draft = Draft {
            email: email.as_deref(),
            kind: "account",
            workspace_id: None,
            inviter: None,
            staff: Some(staff),
            charged_to: "none",
            charged_workspace_id: None,
            limit: None,
        };
        let Some(mut invite) = self.insert_invite(draft).await? else {
            return Ok(Outcome::fail(FailureCode::Conflict, "The invite could not be made. Try again."));
        };
        if let (Some(email), Some(code)) = (&email, &invite.code) {
            self.send_invite_email(email, None, None, false, code, note).await;
        }
        invite.staff = Some(staff.to_owned());
        Ok(Outcome::Ok(invite))
    }

    pub async fn admin_grant_invites(&self, a: AdminGrantInvitesArgs) -> Result<Outcome<Allowance>> {
        if a.amount == 0 || a.amount.abs() > MAX_INVITE_GRANT {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Grant between 1 and {MAX_INVITE_GRANT} invites, or take some back with a negative number.")));
        }
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member granted them."));
        }
        let name = a.name.trim().to_lowercase();
        let target_id = match a.target {
            GrantTarget::User => self
                .db
                .prepare("SELECT id FROM users WHERE username = ?")
                .bind(&[name.as_str().into()])?
                .first::<Id>(None)
                .await?
                .map(|row| row.id),
            GrantTarget::Workspace => self.workspace_id(&name).await?,
        };
        let Some(target_id) = target_id else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no {} named {name}.", a.target.as_str())));
        };
        let note = a.note.trim();
        self.db
            .prepare(
                "INSERT INTO invite_grants (id, target_kind, target_id, amount, note, granted_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                new_id("igr", now_ms()).into(),
                a.target.as_str().into(),
                target_id.as_str().into(),
                f64::from(a.amount).into(),
                if note.is_empty() { JsValue::NULL } else { note.into() },
                staff.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(match a.target {
            GrantTarget::User => self.user_allowance(&target_id).await?,
            GrantTarget::Workspace => self.workspace_allowance(&target_id).await?,
        }))
    }

    async fn grants(&self, target: GrantTarget, id: &str) -> Result<Vec<InviteGrant>> {
        #[derive(Deserialize)]
        struct Row {
            amount: f64,
            note: Option<String>,
            granted_by: String,
            created_at: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT amount, note, granted_by, created_at FROM invite_grants
                 WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC LIMIT 100",
            )
            .bind(&[target.as_str().into(), id.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| InviteGrant {
                amount: row.amount as i32,
                note: row.note,
                granted_by: row.granted_by,
                created_at: row.created_at,
            })
            .collect())
    }

    /// Whom `user_id` invited, `depth` levels down.
    async fn invited_by_user(&self, user_id: &str, depth: usize) -> Result<Vec<InviteTreeNode>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            username: String,
            redeemed_at: String,
        }
        let rows = self
            .db
            .prepare(
                "SELECT u.id, u.username, i.redeemed_at FROM invites i JOIN users u ON u.id = i.redeemed_by
                 WHERE i.inviter_id = ? AND i.kind = 'account' ORDER BY i.redeemed_at LIMIT 200",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut nodes = Vec::with_capacity(rows.len());
        for row in rows {
            let invited = if depth > 1 { Box::pin(self.invited_by_user(&row.id, depth - 1)).await? } else { Vec::new() };
            nodes.push(InviteTreeNode {
                username: row.username,
                joined_at: row.redeemed_at,
                invited,
            });
        }
        Ok(nodes)
    }

    pub async fn admin_invite_tree(&self, a: UsernameArgs) -> Result<Option<InviteTree>> {
        let name = a.username.trim().to_lowercase();
        let Some(user) = self
            .db
            .prepare("SELECT id FROM users WHERE username = ?")
            .bind(&[name.as_str().into()])?
            .first::<Id>(None)
            .await?
        else {
            return Ok(None);
        };
        // Up the tree: who invited them, and who invited that person.
        #[derive(Deserialize)]
        struct Parent {
            inviter_id: Option<String>,
            inviter: Option<String>,
            staff: Option<String>,
        }
        let mut invited_by = Vec::new();
        let mut staff = None;
        let mut current = user.id.clone();
        for _ in 0..20 {
            let parent = self
                .db
                .prepare(
                    "SELECT i.inviter_id, u.username AS inviter, i.staff FROM invites i
                     LEFT JOIN users u ON u.id = i.inviter_id
                     WHERE i.redeemed_by = ? AND i.kind = 'account' LIMIT 1",
                )
                .bind(&[current.as_str().into()])?
                .first::<Parent>(None)
                .await?;
            let Some(parent) = parent else { break };
            if invited_by.is_empty() {
                staff = parent.staff.clone();
            }
            match (parent.inviter_id, parent.inviter) {
                (Some(id), Some(username)) if !invited_by.contains(&username) => {
                    invited_by.push(username);
                    current = id;
                }
                _ => break,
            }
        }
        let invites = self
            .rows("WHERE i.inviter_id = ?", &[user.id.as_str().into()], LIST_LIMIT)
            .await?
            .into_iter()
            .map(|row| self.shown(row, false, true))
            .collect();
        Ok(Some(InviteTree {
            username: name,
            invited_by,
            staff,
            allowance: self.user_allowance(&user.id).await?,
            grants: self.grants(GrantTarget::User, &user.id).await?,
            invites,
            invited: self.invited_by_user(&user.id, TREE_DEPTH).await?,
        }))
    }

    pub async fn admin_workspace_invites(&self, a: SlugArgs) -> Result<Option<InviteTree>> {
        let slug = a.slug.trim().to_lowercase();
        let Some(id) = self.workspace_id(&slug).await? else {
            return Ok(None);
        };
        let invites = self
            .rows("WHERE i.workspace_id = ?1 OR i.charged_workspace_id = ?1", &[id.as_str().into()], LIST_LIMIT)
            .await?
            .into_iter()
            .map(|row| self.shown(row, false, true))
            .collect();
        Ok(Some(InviteTree {
            username: slug,
            invited_by: Vec::new(),
            staff: None,
            allowance: self.workspace_allowance(&id).await?,
            grants: self.grants(GrantTarget::Workspace, &id).await?,
            invites,
            invited: Vec::new(),
        }))
    }

    // --- Audit ---

    async fn audit_invites(&self, actor: &User, action: &str, workspaces: Vec<String>, surface: Surface, message: String) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let entries: Vec<NewAuditEntry> = workspaces
            .into_iter()
            .map(|workspace| NewAuditEntry {
                actor: AuditActor::of(actor),
                action: action.to_owned(),
                surface,
                target: AuditTarget {
                    workspace,
                    ..AuditTarget::default()
                },
                outcome: AuditOutcome::Allowed,
                rule: "invite".to_owned(),
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

/// Whether using the invite joins a workspace.
fn joins_workspace(row: &InviteRow) -> bool {
    row.workspace_id.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_carry_160_bits_in_eight_groups() {
        assert_eq!(encode(&[0u8; 20]), "0".repeat(32));
        assert_eq!(encode(&[0xff; 20]), "z".repeat(32));
        let body = new_code_body();
        assert_eq!(body.len(), CODE_LENGTH);
        assert!(body.bytes().all(|b| ALPHABET.contains(&b)));
        let code = format_code(&body);
        assert!(code.starts_with("g1t-"));
        assert_eq!(code.split('-').count(), 9);
        assert_eq!(code.len(), 4 + 32 + 7);
        // Every bit is used: one bit set shows in exactly one character.
        let mut bytes = [0u8; 20];
        bytes[19] = 1;
        assert_eq!(encode(&bytes), format!("{}1", "0".repeat(31)));
    }

    #[test]
    fn codes_are_not_repeated() {
        let codes: std::collections::HashSet<String> = (0..2000).map(|_| new_code_body()).collect();
        assert_eq!(codes.len(), 2000);
    }

    #[test]
    fn a_code_reads_however_it_is_typed_or_pasted() {
        let body = "k7m2q9xd4hpwabcd0123456789efghjk";
        let shown = format_code(body);
        for typed in [
            shown.clone(),
            shown.to_uppercase(),
            body.to_owned(),
            format!("  {}  ", shown.replace('-', " ")),
            format!("https://g1t.sh/invite/{shown}"),
            format!("https://g1t.sh/register?invite={shown}&next=/"),
        ] {
            assert_eq!(normalize_code(&typed).as_deref(), Some(body), "{typed}");
        }
        // Letters people misread are read as Crockford reads them.
        assert_eq!(normalize_code(&"o".repeat(32)), Some("0".repeat(32)));
        assert_eq!(normalize_code(&"il".repeat(16)), Some("1".repeat(32)));
        assert_eq!(normalize_code("g1t-k7m2"), None);
        assert_eq!(normalize_code(&format!("{body}0")), None);
        assert_eq!(normalize_code(&"u".repeat(32)), None);
        assert_eq!(normalize_code(""), None);
    }

    #[test]
    fn only_the_hash_and_a_short_hint_are_kept() {
        let body = "k7m2q9xd4hpwabcd0123456789efghjk";
        assert_eq!(code_hash(body), crypto::sha256_hex(body));
        assert_eq!(code_hash(body).len(), 64);
        assert_ne!(code_hash(body), code_hash(&body.replace('k', "m")));
        assert_eq!(code_hint(body), "g1t-k7m2");
        // The same code typed differently finds the same row.
        let typed = normalize_code(&format_code(body).to_uppercase()).unwrap();
        assert_eq!(code_hash(&typed), code_hash(body));
    }

    const NOW: &str = "2026-10-05T12:00:00.000Z";
    const LATER: &str = "2026-11-04T12:00:00.000Z";
    const EARLIER: &str = "2026-10-01T12:00:00.000Z";

    #[test]
    fn an_invite_is_pending_until_used_revoked_or_expired() {
        assert_eq!(status_of(None, None, LATER, NOW), InviteStatus::Pending);
        assert_eq!(status_of(None, None, EARLIER, NOW), InviteStatus::Expired);
        assert_eq!(status_of(None, None, NOW, NOW), InviteStatus::Expired);
        assert_eq!(status_of(Some(EARLIER), None, LATER, NOW), InviteStatus::Revoked);
        assert_eq!(status_of(None, Some(EARLIER), EARLIER, NOW), InviteStatus::Redeemed);
    }

    #[test]
    fn revoked_and_expired_invites_give_the_allowance_back() {
        assert!(counts_against_allowance(InviteStatus::Pending));
        assert!(counts_against_allowance(InviteStatus::Redeemed));
        assert!(!counts_against_allowance(InviteStatus::Revoked));
        assert!(!counts_against_allowance(InviteStatus::Expired));
        // The SQL says the same: used, or neither revoked nor expired.
        let sql = counted_sql();
        assert!(sql.contains("i.redeemed_at IS NOT NULL OR (i.revoked_at IS NULL AND i.expires_at >"));
    }

    #[test]
    fn allowances_are_five_plus_grants_or_unlimited_for_staff() {
        assert_eq!(limit_for(INVITES_PER_USER, 0, false), Some(5));
        assert_eq!(limit_for(5, 10, false), Some(15));
        assert_eq!(limit_for(5, -3, false), Some(2));
        assert_eq!(limit_for(5, -30, false), Some(0));
        assert_eq!(limit_for(5, 0, true), None);
        // A workspace has only what staff granted it.
        assert_eq!(limit_for(0, 0, false), Some(0));
        assert_eq!(limit_for(0, 25, false), Some(25));
        let full = Allowance::new(Some(5), 5);
        assert!(full.exhausted());
        assert_eq!(full.remaining, Some(0));
        let over = Allowance::new(Some(2), 4);
        assert_eq!(over.remaining, Some(0));
        let open = Allowance::new(None, 400);
        assert!(!open.exhausted());
        assert_eq!(open.remaining, None);
        assert_eq!(Allowance::new(Some(5), 3).remaining, Some(2));
    }

    fn invite(kind: &'static str, email: Option<&'static str>, status: InviteStatus) -> Admits<'static> {
        Admits { kind, email, status }
    }

    #[test]
    fn an_invite_admits_only_its_address_while_pending() {
        let open = invite("account", None, InviteStatus::Pending);
        assert_eq!(admits(Some(&open), "anyone@example.com", true), Ok(()));
        let bound = invite("account", Some("ada@example.com"), InviteStatus::Pending);
        assert_eq!(admits(Some(&bound), "ada@example.com", true), Ok(()));
        assert_eq!(admits(Some(&bound), " ADA@Example.com ", true), Ok(()));
        assert_eq!(admits(Some(&bound), "eve@example.com", true), Err(Refusal::WrongEmail));
        for status in [InviteStatus::Redeemed, InviteStatus::Revoked, InviteStatus::Expired] {
            assert_eq!(admits(Some(&invite("account", None, status)), "a@example.com", true), Err(Refusal::Invalid));
            // A dead code says nothing about whom it was for.
            assert_eq!(
                admits(Some(&invite("account", Some("ada@example.com"), status)), "eve@example.com", true),
                Err(Refusal::Invalid)
            );
        }
        assert_eq!(admits(None, "a@example.com", true), Err(Refusal::Invalid));
    }

    #[test]
    fn a_workspace_invite_never_makes_an_account() {
        let join = invite("workspace", Some("ada@example.com"), InviteStatus::Pending);
        assert_eq!(admits(Some(&join), "ada@example.com", true), Err(Refusal::Invalid));
        assert_eq!(admits(Some(&join), "ada@example.com", false), Ok(()));
        assert_eq!(admits(Some(&join), "eve@example.com", false), Err(Refusal::WrongEmail));
        // An account invite for a workspace can be accepted by the address
        // once it has an account.
        let account = invite("account", Some("ada@example.com"), InviteStatus::Pending);
        assert_eq!(admits(Some(&account), "ada@example.com", false), Ok(()));
    }

    #[test]
    fn addresses_are_checked_and_masked() {
        assert_eq!(normalize_email(" Ada@Example.COM ").as_deref(), Some("ada@example.com"));
        for bad in ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com", "ada@.com", "ada@example.", "a@b@c.com"] {
            assert_eq!(normalize_email(bad), None, "{bad}");
        }
        assert_eq!(mask_email("ada@example.com"), "a•••@example.com");
        assert_eq!(mask_email("x@example.com"), "x•••@example.com");
    }

    #[test]
    fn rate_limits_count_in_hour_long_windows() {
        assert_eq!(bucket(0, HOUR_MS), 0);
        assert_eq!(bucket(HOUR_MS - 1, HOUR_MS), 0);
        assert_eq!(bucket(HOUR_MS, HOUR_MS), 1);
        // The limits stop guessing long before a code could be found, and
        // leave room for people who mistype.
        assert!((5..=100).contains(&FAILURES_PER_HOUR));
        const { assert!(CREATES_PER_HOUR >= INVITES_PER_USER) };
        const { assert!(REQUESTS_PER_HOUR >= 1) };
    }

    #[test]
    fn staff_hear_about_requests_at_most_every_15_minutes() {
        assert_eq!(SUMMARY_EVERY_MS, 15 * 60 * 1000);
        let since = "2026-10-05T11:45:00.000Z";
        assert!(summary_due(None, since));
        assert!(summary_due(Some("2026-10-05T11:30:00.000Z"), since));
        assert!(summary_due(Some(since), since));
        assert!(!summary_due(Some("2026-10-05T11:50:00.000Z"), since));
        const { assert!(CONFIRMATIONS_PER_HOUR >= ANONYMOUS_REQUESTS_PER_HOUR) };
    }

    #[test]
    fn registration_is_invite_only_unless_opened() {
        assert_eq!(RegistrationMode::parse(None), RegistrationMode::Invite);
        assert_eq!(RegistrationMode::parse(Some("invite")), RegistrationMode::Invite);
        assert_eq!(RegistrationMode::parse(Some("")), RegistrationMode::Invite);
        assert_eq!(RegistrationMode::parse(Some("opne")), RegistrationMode::Invite);
        assert_eq!(RegistrationMode::parse(Some(" Open ")), RegistrationMode::Open);
    }
}
