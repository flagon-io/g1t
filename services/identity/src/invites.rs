//! Invite codes, and the one place every new account is made.
//!
//! [`Identity::create_account`] is the only way an account comes to exist.
//! Anyone may register; an invite code is optional. An invitation into a
//! workspace or onto a repository, sent to an address without an account,
//! carries one: an account made with it gets that invitation once its
//! address is confirmed. A code that is unknown, spent, revoked, expired or
//! for another address is ignored and the account is made without it. The
//! code is spent in the same transaction that makes the account, so two
//! people racing with one code cannot both use it.
//!
//! A code is 160 random bits in Crockford base32, shown as `g1t-` and eight
//! groups of four. Only its SHA-256 is kept to find it, with a copy sealed
//! under IDENTITY_KEY so whoever made it can copy the link again while it
//! is pending.
//!
//! Sign-ups with a password are rate limited per client address
//! ([`REGISTRATIONS_PER_HOUR`]); new accounts confirm their address before
//! they can invite anyone.
//!
//! Vars: INVITE_TTL_DAYS.

use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::events::{InviteCreated, InviteRedeemed, JoinedHow};
use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use g1t_secrets::Sealer;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Identity, crypto};

mod invitations;

/// Crockford base32, as ids use: no i, l, o or u.
const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// 32 characters of 5 bits: 160 random bits.
const CODE_LENGTH: usize = 32;
const GROUP: usize = 4;

pub const INVALID: &str =
    "That invite code is not valid. It may have been used, revoked or expired; ask whoever invited you for a new one.";
pub const WRONG_EMAIL: &str = "This invite is for a different email address. Use the address it was sent to.";
const TOO_MANY: &str = "Too many attempts. Try again in an hour.";
const PEOPLE_ONLY: &str = "Only a person can make invites, not an agent or a workspace's token.";
const CONFIRM_FIRST: &str = "Confirm your email address before inviting anyone.";

const HOUR_MS: u64 = 60 * 60 * 1000;
/// Invites one person may make in an hour, whatever their allowance.
const CREATES_PER_HOUR: u32 = 20;
/// Wrong codes one client may try in an hour before being turned away.
const FAILURES_PER_HOUR: u32 = 20;
/// Accounts one client address may make with a password in an hour.
pub const REGISTRATIONS_PER_HOUR: u32 = 5;
/// Accounts made with a password by clients that sent no address,
/// together, in an hour.
const ANONYMOUS_REGISTRATIONS_PER_HOUR: u32 = 100;
/// The most invites a workspace's list shows.
const LIST_LIMIT: u32 = 200;
const TOO_MANY_SIGN_UPS: &str = "Too many accounts were made from your network in the last hour. Try again later.";

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

/// Where an invite stands at `now`, from its row. A used invite whose
/// account has not confirmed its address yet is awaiting confirmation
/// (`applied_at` is null); revoking it then stops it joining anything.
pub fn status_of(
    revoked_at: Option<&str>,
    redeemed_at: Option<&str>,
    applied_at: Option<&str>,
    expires_at: &str,
    now: &str,
) -> InviteStatus {
    if redeemed_at.is_some() {
        if revoked_at.is_some() {
            InviteStatus::Revoked
        } else if applied_at.is_some() {
            InviteStatus::Redeemed
        } else {
            InviteStatus::AwaitingConfirmation
        }
    } else if revoked_at.is_some() {
        InviteStatus::Revoked
    } else if expires_at <= now {
        InviteStatus::Expired
    } else {
        InviteStatus::Pending
    }
}

/// Whether an invitation can be sent again: only while it waits to be
/// used. One whose account is confirming its address or answering already
/// has what it needs; the rest are over.
pub fn resendable(status: InviteStatus) -> bool {
    status == InviteStatus::Pending
}

/// The note an inviter wrote, as the email quotes it: trimmed and cut to
/// [`MAX_INVITE_MESSAGE`] characters; none when blank.
pub fn invite_note(message: Option<&str>) -> Option<String> {
    let note: String = message?.trim().chars().take(MAX_INVITE_MESSAGE).collect();
    (!note.is_empty()).then_some(note)
}

/// Where an invite stands once the workspace invitation in it is counted:
/// `base` from [`status_of`]. A declined one is declined; an account
/// invite whose account is confirmed but has not answered the workspace it
/// names (`names_workspace`: one that still exists) awaits that answer
/// until it expires.
pub fn answered_status(
    base: InviteStatus,
    kind: &str,
    names_workspace: bool,
    accepted_at: Option<&str>,
    declined_at: Option<&str>,
    expires_at: &str,
    now: &str,
) -> InviteStatus {
    if declined_at.is_some() && base != InviteStatus::Revoked {
        return InviteStatus::Declined;
    }
    if base == InviteStatus::Redeemed && kind == "account" && names_workspace && accepted_at.is_none() {
        return if expires_at <= now { InviteStatus::Expired } else { InviteStatus::AwaitingAnswer };
    }
    base
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

/// The proof for an invite's email link, or None when there is none to
/// make: no key (a development setup), or no address the invite is bound
/// to. See [`crypto::invite_proof`].
pub fn email_proof(key: &[u8], invite_id: &str, bound: Option<&str>) -> Option<String> {
    let bound = bound.map(str::trim).filter(|bound| !bound.is_empty())?;
    (!key.is_empty()).then(|| crypto::invite_proof(key, invite_id, bound))
}

/// Whether `proof` shows that whoever brings it followed the invite's own
/// email: it is the proof for this invite and the address it is bound to,
/// and `email`, the address the account is made with, is that address.
/// Anything else (no proof, a wrong or altered one, another invite's, an
/// invite bound to no address, a different address) proves nothing, and
/// the address is confirmed as any other is.
pub fn proves_email(key: &[u8], invite_id: &str, bound: Option<&str>, email: &str, proof: Option<&str>) -> bool {
    let (Some(expected), Some(proof)) = (email_proof(key, invite_id, bound), proof.map(str::trim)) else {
        return false;
    };
    let same_address = bound.is_some_and(|bound| bound.trim().to_lowercase() == email.trim().to_lowercase());
    same_address && crypto::same(&expected, &proof.to_ascii_lowercase())
}

/// Whether a new account starts with its address confirmed: GitHub
/// confirmed it (`verified`), or `invite`, the one-person invite that
/// admitted it, was followed from its own email with `proof` and `email` is
/// the address it was sent to. A code typed in or passed on, or an invite
/// bound to no address: confirmed as any other is.
pub fn starts_confirmed(key: &[u8], verified: bool, invite: Option<&InviteRow>, email: &str, proof: Option<&str>) -> bool {
    verified
        || invite.is_some_and(|row| row.kind == "account" && proves_email(key, &row.id, row.email.as_deref(), email, proof))
}

/// What an invite used to sign up does once its account confirms its
/// address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AwaitingJoin {
    /// It invites the account to this workspace: a workspace invitation
    /// now waits for its answer. Nothing is joined without one.
    Invited { workspace_id: String, slug: String },
    /// It names no workspace; repository invitations sent with it are
    /// accepted.
    Nothing,
    /// It no longer applies, and why, as the person is told.
    Lapsed(String),
}

/// [`AwaitingJoin`] for an invite's row at `now`. `row.workspace` is the
/// workspace's slug, None once it was deleted. A workspace on the free
/// plan still invites: accepting waits until it starts the plan (paid.rs).
pub fn awaiting_join(row: &InviteRow, now: &str) -> AwaitingJoin {
    let what = match &row.workspace {
        Some(slug) => format!("no longer invites you to {slug}"),
        None => "no longer applies".to_owned(),
    };
    if row.revoked_at.is_some() {
        return AwaitingJoin::Lapsed(format!(
            "Your email address is confirmed. The invite you signed up with was revoked while you were confirming it, so it {what}."
        ));
    }
    if row.expires_at.as_str() <= now {
        return AwaitingJoin::Lapsed(format!(
            "Your email address is confirmed. The invite you signed up with expired before you confirmed it, so it {what}. Ask whoever invited you to invite you again."
        ));
    }
    match (&row.workspace_id, &row.workspace) {
        (None, _) => AwaitingJoin::Nothing,
        (Some(_), None) => AwaitingJoin::Lapsed(
            "Your email address is confirmed. The workspace your invite was for has been deleted, so the invite no longer applies.".to_owned(),
        ),
        (Some(workspace_id), Some(slug)) => AwaitingJoin::Invited { workspace_id: workspace_id.clone(), slug: slug.clone() },
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

// --- Rows ---------------------------------------------------------------------

const COLUMNS: &str = "i.id, i.hint, i.sealed_code, i.email, i.kind, i.workspace_id, w.slug AS workspace,
  i.inviter_id, iu.username AS inviter, i.staff, i.created_at, i.expires_at,
  i.revoked_at, i.redeemed_by, ru.username AS redeemer, i.redeemed_at, i.applied_at,
  i.invitee_id, vu.username AS invitee, i.role, i.accepted_at, i.declined_at
  FROM invites i
  LEFT JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
  LEFT JOIN users iu ON iu.id = i.inviter_id
  LEFT JOIN users ru ON ru.id = i.redeemed_by
  LEFT JOIN users vu ON vu.id = i.invitee_id";

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
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub redeemer: Option<String>,
    pub redeemed_at: Option<String>,
    #[serde(default)]
    pub applied_at: Option<String>,
    /// The account a workspace invitation is for (invitations.rs).
    #[serde(default)]
    pub invitee_id: Option<String>,
    #[serde(default)]
    pub invitee: Option<String>,
    /// `owner` or `member`; null is member.
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub accepted_at: Option<String>,
    #[serde(default)]
    pub declined_at: Option<String>,
}

impl InviteRow {
    pub fn status(&self, now: &str) -> InviteStatus {
        answered_status(
            status_of(
                self.revoked_at.as_deref(),
                self.redeemed_at.as_deref(),
                self.applied_at.as_deref(),
                &self.expires_at,
                now,
            ),
            &self.kind,
            self.workspace.is_some(),
            self.accepted_at.as_deref(),
            self.declined_at.as_deref(),
            &self.expires_at,
            now,
        )
    }

    /// The role accepting it joins with.
    pub fn joins_as(&self) -> Role {
        if self.role.as_deref() == Some("owner") { Role::Owner } else { Role::Member }
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

#[derive(Deserialize)]
struct Count {
    n: f64,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

/// What a new account is made from.
pub struct NewAccount<'a> {
    /// Checked by the caller: valid, free, and lowercased.
    pub username: &'a str,
    /// The username as the person wrote it, when its case differs (`Ana`
    /// for `ana`): kept beside it for showing. None shows `username`.
    pub display_username: Option<&'a str>,
    /// Lowercased and checked by the caller.
    pub email: &'a str,
    /// Empty for an account with no password (made through GitHub).
    pub password_hash: &'a str,
    /// Whether the address is confirmed already (GitHub's verified email).
    pub verified: bool,
    pub invite_code: Option<&'a str>,
    /// The proof from the invite email's link ([`proves_email`]): when it
    /// is the invite's and `email` is the address the invite was sent to,
    /// the account starts with that address confirmed.
    pub email_proof: Option<&'a str>,
}

/// What an invite was made for.
struct Draft<'a> {
    email: Option<&'a str>,
    kind: &'a str,
    /// The workspace using it joins.
    workspace_id: Option<&'a str>,
    inviter: Option<&'a User>,
    staff: Option<&'a str>,
    /// The account a workspace invitation is for, when it has one already.
    invitee_id: Option<&'a str>,
    /// The role joining `workspace_id` gives: `member` or `owner`.
    role: Option<&'a str>,
}

impl Identity {
    // --- Settings ---

    fn var_number(&self, name: &str) -> Option<u64> {
        self.env.var(name).ok()?.to_string().trim().parse().ok()
    }

    fn invite_ttl_days(&self) -> u64 {
        self.var_number("INVITE_TTL_DAYS").filter(|days| (1..=365).contains(days)).unwrap_or(INVITE_TTL_DAYS)
    }

    pub(crate) fn invite_sealer(&self) -> Option<Sealer> {
        Sealer::new(&self.env.secret("IDENTITY_KEY").ok()?.to_string())
    }

    /// The key invite email proofs are made under: IDENTITY_KEY, or none
    /// in a development setup without one (then no proof is made, and none
    /// is accepted).
    fn proof_key(&self) -> Vec<u8> {
        self.env.secret("IDENTITY_KEY").map(|key| key.to_string().into_bytes()).unwrap_or_default()
    }

    /// The proof for the link of an invite emailed to `to`, the address it
    /// is bound to; never shown anywhere but in that email.
    pub(crate) fn email_proof_for(&self, invite_id: &str, to: &str) -> Option<String> {
        email_proof(&self.proof_key(), invite_id, Some(to))
    }

    /// Whether `proof` shows the invite in `row` was followed from its own
    /// email, by someone making an account with `email`.
    fn proven(&self, row: &InviteRow, email: &str, proof: Option<&str>) -> bool {
        starts_confirmed(&self.proof_key(), false, Some(row), email, proof)
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
        let role = row.workspace_id.is_some().then(|| row.joins_as());
        // An invite sent to an address never says which account has it,
        // until that account uses it.
        let invitee = row.invitee.clone().filter(|_| row.email.is_none() || row.redeemed_at.is_some());
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
            invited_by: row.inviter,
            redeemed_by: row.redeemer,
            created_at: row.created_at,
            expires_at: row.expires_at,
            redeemed_at: row.redeemed_at,
            revoked_at: row.revoked_at,
            invitee,
            role,
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

    /// Counts one sign-up with a password from `client`; false once that
    /// address (or, without one, every client that sent none) made
    /// [`REGISTRATIONS_PER_HOUR`] sign-ups this hour. Asked once the form
    /// is well formed, before anything is looked up or written.
    pub(crate) async fn sign_up_allowed(&self, client: Option<&str>) -> Result<bool> {
        match client.map(str::trim).filter(|client| !client.is_empty()) {
            Some(client) => self.hit(&format!("register:{}", crypto::sha256_hex(client)), REGISTRATIONS_PER_HOUR).await,
            None => self.hit("register:anonymous", ANONYMOUS_REGISTRATIONS_PER_HOUR).await,
        }
    }

    pub(crate) fn too_many_sign_ups() -> Outcome<SignedIn> {
        Outcome::fail(FailureCode::Limit, TOO_MANY_SIGN_UPS)
    }

    /// Makes an account: the only place one is made. `invite_code` is
    /// optional; a good one admitting `email` is spent in the same
    /// transaction as the account is made, and anything else is ignored.
    /// What the invite gives (a workspace invitation, repository
    /// invitations) is applied once the address is confirmed: at once for
    /// an address GitHub has confirmed or one proven by the invite email's
    /// link ([`proves_email`]), otherwise in the transaction that confirms
    /// it (emails.rs, `confirm_address`).
    pub async fn create_account(&self, new: NewAccount<'_>) -> Result<Outcome<User>> {
        let code = new.invite_code.map(str::trim).filter(|code| !code.is_empty());
        let invite = match code {
            Some(code) => {
                let now = rfc3339(now_ms());
                self.invite_by_code(code)
                    .await?
                    .filter(|row| admits(Some(&row.admits(&now)), new.email, true).is_ok())
            }
            None => None,
        };

        // An address GitHub has confirmed starts confirmed, and so does the
        // address an invite was emailed to, when the link followed was the
        // email's own: its proof is in no code the inviter sees or shares.
        // The code alone proves nothing (it can be passed on), so without
        // the proof the new account confirms the address like any other.
        let verified = starts_confirmed(&self.proof_key(), new.verified, invite.as_ref(), new.email, new.email_proof);
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
        let plain = format!(
            "INSERT INTO users (id, username, email, password_hash, email_verified_at)
             VALUES (?, ?, ?, ?, {verified_at})"
        );
        let made = match &invite {
            None => self.db.prepare(&plain).bind(&values)?.run().await.map(|_| ()),
            // Spend the code, then make the account only if this request
            // spent it: one transaction, so a second use finds it gone.
            Some(row) => {
                let mut insert = values.to_vec();
                insert.extend([JsValue::from(row.id.as_str()), user.id.as_str().into()]);
                self.db
                    .batch(vec![
                        self.db
                            .prepare(format!(
                                "UPDATE invites SET redeemed_by = ?1, invitee_id = ?1, redeemed_at = {SQL_NOW}, sealed_code = NULL
                                 WHERE id = ?2 AND kind = 'account' AND redeemed_at IS NULL AND revoked_at IS NULL
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
        let taken = || Ok(Outcome::fail(FailureCode::Conflict, "That username or email is already registered."));
        if let Err(error) = made {
            // Someone took the username or email a moment ago; nothing
            // was written, the code included.
            if error.to_string().contains("UNIQUE") {
                return taken();
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
            // Another sign-up spent the code first: the account is made
            // without it, and confirms its address like any other.
            let user = User { verified: new.verified, ..user.clone() };
            let verified_at = if user.verified { SQL_NOW } else { "NULL" };
            let made = self
                .db
                .prepare(format!(
                    "INSERT INTO users (id, username, email, password_hash, email_verified_at)
                     VALUES (?, ?, ?, ?, {verified_at})"
                ))
                .bind(&values)?
                .run()
                .await;
            if let Err(error) = made {
                if error.to_string().contains("UNIQUE") {
                    return taken();
                }
                return Err(error);
            }
            return self.account_made(user, new.display_username, None).await;
        }
        self.account_made(user, new.display_username, invite).await
    }

    /// What follows a new account being made: the case its name was
    /// chosen in, a workspace of its own unless its invite brings it into
    /// one, and, once its address is confirmed, what its invite gives.
    async fn account_made(&self, user: User, display_username: Option<&str>, invite: Option<InviteRow>) -> Result<Outcome<User>> {
        // The case it was chosen in, beside the lowercased name everything finds it by.
        let user = match display_username.filter(|display| display.eq_ignore_ascii_case(&user.username) && *display != user.username) {
            Some(display) => {
                self.db
                    .prepare("UPDATE users SET display_username = ? WHERE id = ?")
                    .bind(&[display.into(), user.id.as_str().into()])?
                    .run()
                    .await?;
                User { display_username: Some(display.to_owned()), ..user }
            }
            None => user,
        };
        // Nobody is left without a workspace: one of its own, unless its
        // invite brings it into one (invitations.rs).
        self.give_own_workspace(&user, invite.as_ref()).await;
        // Confirmed already (GitHub, or the invite email): what the invite
        // gives, now: a workspace it names is an invitation to accept,
        // never joined without saying yes. Otherwise
        // it waits, spent, for the address to be confirmed.
        if let Some(row) = invite
            && user.verified
        {
            self.after_redeemed(&row, &user, true).await?;
        }
        Ok(Outcome::Ok(user))
    }

    /// What using an invite gives, once its account is confirmed, and tells
    /// the event log and audit log. A new account (`created_account`) is
    /// invited to the workspace the invite names, to accept or decline
    /// (invitations.rs): nobody joins a workspace without saying yes. An
    /// existing account that opened the invite and accepted it
    /// (`accept_invite`) joins now, with the role it names.
    async fn after_redeemed(&self, row: &InviteRow, user: &User, created_account: bool) -> Result<()> {
        let mut joined = None;
        if let (Some(workspace_id), Some(slug)) = (&row.workspace_id, &row.workspace) {
            if created_account {
                self.db
                    .prepare("UPDATE invites SET expires_at = max(expires_at, ?) WHERE id = ? AND accepted_at IS NULL")
                    .bind(&[self.answer_by().into(), row.id.as_str().into()])?
                    .run()
                    .await?;
                self.invitation_sent(row, &user.username).await;
            } else {
                let role = if row.joins_as() == Role::Owner { "owner" } else { "member" };
                self.db
                    .batch(vec![
                        self.db
                            .prepare(
                                "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                                 VALUES (?, ?, ?, ?)",
                            )
                            .bind(&[workspace_id.as_str().into(), user.id.as_str().into(), role.into(), rfc3339(now_ms()).into()])?,
                        self.db
                            .prepare(format!("UPDATE invites SET accepted_at = {SQL_NOW} WHERE id = ? AND accepted_at IS NULL"))
                            .bind(&[row.id.as_str().into()])?,
                    ])
                    .await?;
                joined = Some(slug.clone());
                // They are a member now: the workspace's @g1t welcomes them (agents service).
                self.announce_member_joined(workspace_id, slug, user, row.joins_as(), JoinedHow::Joined).await;
            }
        }
        self.db
            .prepare(format!("UPDATE invites SET applied_at = {SQL_NOW} WHERE id = ? AND applied_at IS NULL"))
            .bind(&[row.id.as_str().into()])?
            .run()
            .await?;
        self.settled(row, user, created_account, joined).await;
        Ok(())
    }

    /// When a workspace invitation made now, or handed to a new account
    /// now, stops working: the invite TTL from now, RFC 3339.
    pub(crate) fn answer_by(&self) -> String {
        rfc3339(now_ms() + self.invite_ttl_days() * 24 * HOUR_MS)
    }

    /// What follows an invite's workspace being joined (`joined`, by slug)
    /// or not: repository invitations sent with its code are accepted, and
    /// the event log and the workspace's audit log are told.
    pub(crate) async fn settled(&self, row: &InviteRow, user: &User, created_account: bool, joined: Option<String>) {
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
            let role = if row.joins_as() == Role::Owner { "an owner" } else { "a member" };
            self.audit_invites(user, "invite.redeemed", vec![slug.clone()], Surface::Web, message).await;
            self.audit_invites(user, "member.added", vec![slug], Surface::Web, format!("{} joined as {role}", user.username)).await;
        }
    }

    /// The invite an account signed up with, while it waits for the account
    /// to confirm its address: spent, not yet applied.
    pub(crate) async fn awaiting_invite(&self, user_id: &str) -> Result<Option<InviteRow>> {
        Ok(self
            .rows(
                "WHERE i.redeemed_by = ? AND i.kind = 'account' AND i.redeemed_at IS NOT NULL AND i.applied_at IS NULL",
                &[user_id.into()],
                1,
            )
            .await?
            .into_iter()
            .next())
    }

    /// What an awaiting invite does now that its account is being
    /// confirmed, worked out before the batch that confirms it (which
    /// checks the same again).
    pub(crate) async fn awaiting_join(&self, row: &InviteRow) -> AwaitingJoin {
        awaiting_join(row, &rfc3339(now_ms()))
    }

    /// The statements that apply an awaiting invite, for the batch that
    /// confirms `user_id`'s address, after the statement that marks the
    /// account confirmed: give a workspace invitation the invite TTL from
    /// now to be answered in, only if the account is confirmed now; then
    /// mark the invite settled, whatever it gave. Nothing is joined here:
    /// the person accepts the invitation (invitations.rs).
    pub(crate) fn apply_invite_statements(
        &self,
        user_id: &str,
        row: &InviteRow,
        join: &AwaitingJoin,
    ) -> Result<Vec<worker::D1PreparedStatement>> {
        let confirmed = "EXISTS (SELECT 1 FROM users WHERE id = ?1 AND email_verified_at IS NOT NULL)";
        let mut statements = Vec::new();
        if let AwaitingJoin::Invited { .. } = join {
            statements.push(
                self.db
                    .prepare(format!(
                        "UPDATE invites SET expires_at = max(expires_at, ?3)
                         WHERE id = ?2 AND redeemed_by = ?1 AND applied_at IS NULL AND revoked_at IS NULL AND {confirmed}"
                    ))
                    .bind(&[user_id.into(), row.id.as_str().into(), self.answer_by().into()])?,
            );
        }
        statements.push(
            self.db
                .prepare(format!(
                    "UPDATE invites SET applied_at = {SQL_NOW}
                     WHERE id = ?2 AND redeemed_by = ?1 AND applied_at IS NULL AND {confirmed}"
                ))
                .bind(&[user_id.into(), row.id.as_str().into()])?,
        );
        Ok(statements)
    }

    /// After the batch: the workspace the account is invited to, by slug,
    /// if the invitation still waits for its answer (and it is told in
    /// its inbox); and, unless the invite lapsed, the repository
    /// invitations, event and audit entries that follow using it.
    pub(crate) async fn after_applied(&self, row: &InviteRow, user: &User, join: &AwaitingJoin) -> Result<Option<String>> {
        let invited = match join {
            AwaitingJoin::Invited { slug, .. } => self
                .db
                .prepare(format!(
                    "SELECT 1 AS n FROM invites WHERE id = ? AND applied_at IS NOT NULL AND revoked_at IS NULL
                       AND accepted_at IS NULL AND declined_at IS NULL AND expires_at > {SQL_NOW}"
                ))
                .bind(&[row.id.as_str().into()])?
                .first::<Count>(None)
                .await?
                .map(|_| slug.clone()),
            _ => None,
        };
        if invited.is_some() {
            self.invitation_sent(row, &user.username).await;
        }
        if !matches!(join, AwaitingJoin::Lapsed(_)) {
            self.settled(row, user, true, None).await;
        }
        Ok(invited)
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

    /// Stores a new invite and returns it with its code.
    async fn insert_invite(&self, draft: Draft<'_>) -> Result<Option<Invite>> {
        let body = new_code_body();
        let code = format_code(&body);
        let now = now_ms();
        let id = new_id("inv", now);
        let sealed = self.invite_sealer().map(|sealer| sealer.seal(&code, &id));
        let expires_at = rfc3339(now + self.invite_ttl_days() * 24 * HOUR_MS);
        let created_at = rfc3339(now);
        let opt = |value: Option<&str>| value.map_or(JsValue::NULL, JsValue::from);
        let binds = vec![
            JsValue::from(id.as_str()),
            code_hash(&body).into(),
            code_hint(&body).into(),
            opt(sealed.as_deref()),
            opt(draft.email),
            draft.kind.into(),
            opt(draft.workspace_id),
            opt(draft.inviter.map(|user| user.id.as_str())),
            opt(draft.staff),
            created_at.as_str().into(),
            expires_at.as_str().into(),
            opt(draft.invitee_id),
            opt(draft.role),
        ];
        let inserted = self
            .db
            .prepare(format!(
                "INSERT INTO invites (id, code_hash, hint, sealed_code, email, kind, workspace_id, inviter_id,
                   staff, charged_to, created_at, expires_at, invitee_id, role)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?)
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

    async fn send_invite_email(
        &self,
        to: &str,
        from: Option<&str>,
        workspace: Option<&str>,
        existing: bool,
        code: &str,
        invite_id: &str,
        note: Option<&str>,
    ) {
        // An invite that makes an account carries the proof that the link
        // came from this email; one for an existing account has nothing
        // to prove.
        let proof = if existing { None } else { self.email_proof_for(invite_id, to) };
        let invite = crate::email::InviteEmail {
            to,
            from,
            workspace,
            joins_existing_account: existing,
            code,
            proof: proof.as_deref(),
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

    /// Revokes a pending invite the person made, or one made for a
    /// workspace they own. An invite used to sign up whose
    /// account has not confirmed its address yet can be revoked too: the
    /// account stays, and joins nothing when it confirms.
    async fn revoke_invite(&self, a: RemoveArgs) -> Result<Outcome<Invite>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let revoked = self
            .db
            .prepare(format!(
                "UPDATE invites SET revoked_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ?2 AND revoked_at IS NULL AND declined_at IS NULL
                   AND (redeemed_at IS NULL OR applied_at IS NULL
                     -- A workspace invitation not yet answered.
                     OR (workspace_id IS NOT NULL AND accepted_at IS NULL))
                   AND (inviter_id = ?1
                     OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1 AND role = 'owner'))
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
        self.invitation_revoked(&a.user, &row).await;
        Ok(Outcome::Ok(self.shown(row, false, false)))
    }

    /// What an invite code is for: who sent it, and which workspace it
    /// joins. Any code that cannot be used gets the same answer.
    pub async fn check_invite(&self, a: InviteCodeArgs) -> Result<Outcome<InvitePreview>> {
        if self.turned_away(a.client.as_deref()).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let now = rfc3339(now_ms());
        let found = self.invite_by_code(&a.code).await?;
        // A spent code is still a real one (160 random bits): saying what
        // became of it tells a guesser nothing.
        let row = found.filter(|row| a.any_status || row.status(&now) == InviteStatus::Pending);
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
                (_, InviteStatus::Redeemed | InviteStatus::AwaitingConfirmation) => {
                    Some(row.redeemer.as_deref() == Some(viewer.username.as_str()))
                }
                (Some(bound), _) => {
                    let mine = self.verified_emails(&viewer.id).await?;
                    Some(mine.iter().any(|address| address.eq_ignore_ascii_case(bound.trim())))
                }
                // An invitation to someone by username is theirs alone.
                (None, _) => row.invitee_id.as_ref().map(|invitee| *invitee == viewer.id),
            },
            _ => None,
        };
        let has_account = match (&row.email, pending) {
            (Some(bound), true) => self.email_has_account(bound).await?,
            _ => false,
        };
        let repository = self.repository_of_code(&row.id).await?;
        // Opened from the invite's own email: the account it makes starts
        // with the address confirmed. Said only while it can make one.
        let email_proven = pending
            && !has_account
            && row.email.as_deref().is_some_and(|bound| self.proven(&row, bound, a.email_proof.as_deref()));
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
            email_proven,
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
        // An invitation to one account works for that account only.
        if row.invitee_id.as_deref().is_some_and(|invitee| invitee != a.user.id) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "This invitation is for a different g1t account. Sign in as the account it was sent to.",
            ));
        }
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
                "UPDATE invites SET redeemed_by = ?1, invitee_id = COALESCE(invitee_id, ?1), redeemed_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ?2 AND redeemed_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expires_at > {SQL_NOW}
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
        // A username, or an address; an address typed in the username's
        // place is an address.
        let username = a
            .username
            .as_deref()
            .map(|name| name.trim().trim_start_matches('@').to_lowercase())
            .filter(|name| !name.is_empty() && !name.contains('@'));
        let email = match (&username, normalize_email(a.username.as_deref().unwrap_or(&a.email))) {
            (Some(_), _) => None,
            (None, Some(email)) => Some(email),
            (None, None) => return Ok(Outcome::fail(FailureCode::Invalid, "Enter a g1t username or a valid email address.")),
        };
        let role = a.role.unwrap_or(Role::Member);
        let role_name = if role == Role::Owner { "owner" } else { "member" };
        let Some(workspace_id) = self.workspace_id(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        // A free workspace invites no one until it starts the plan (paid.rs).
        if let Some(refused) = self.free_workspace_refusal(&slug).await? {
            return Ok(refused);
        }
        let surface = a.surface.unwrap_or(Surface::Web);
        // A note from the inviter goes in the email, cut to its limit.
        let note = invite_note(a.message.as_deref());
        // Someone on g1t, by username: an invitation to accept or decline
        // (invites/invitations.rs).
        let Some(email) = email else {
            let username = username.unwrap_or_default();
            return self.invite_account(&a.actor, &slug, &workspace_id, &username, role, note.as_deref(), surface).await;
        };
        if !self.hit(&format!("invite.create:{}", a.actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let pending = self
            .rows(
                &format!(
                    "WHERE i.workspace_id = ? AND i.email = ?
                       AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > {SQL_NOW}"
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
        // The account that has confirmed the address, which the invitation
        // is for. Never shown to the inviter: the answer does not say
        // whether the address has an account.
        let invitee = self.user_with_verified_email(&email).await?;
        let draft = if has_account {
            Draft {
                email: Some(&email),
                kind: "workspace",
                workspace_id: Some(&workspace_id),
                inviter: Some(&a.actor),
                staff: None,
                invitee_id: invitee.as_deref(),
                role: Some(role_name),
            }
        } else {
            Draft {
                email: Some(&email),
                kind: "account",
                workspace_id: Some(&workspace_id),
                inviter: Some(&a.actor),
                staff: None,
                invitee_id: None,
                role: Some(role_name),
            }
        };
        let Some(invite) = self.insert_invite(draft).await? else {
            return Ok(Outcome::fail(FailureCode::Conflict, "The invitation could not be made. Try again."));
        };
        if let Some(code) = &invite.code {
            let from = self.display_name(&a.actor).await;
            let workspace = self.workspace_name(&workspace_id, &slug).await;
            self.send_invite_email(&email, Some(&from), Some(&workspace), has_account, code, &invite.id, note.as_deref()).await;
        }
        // Someone on g1t hears of it in their inbox too.
        if invitee.is_some()
            && let Some(row) = self.invite_by_id(&invite.id).await?
            && let Some(username) = row.invitee.clone()
        {
            self.invitation_sent(&row, &username).await;
        }
        self.audit_invites(&a.actor, "invite.created", vec![slug.clone()], surface, format!("Invited {email} to {slug} as {role_name}"))
            .await;
        Ok(Outcome::Ok(invite))
    }

    /// An invite code for an address without an account, invited to
    /// collaborate on one repository (access.rs). The code joins no
    /// workspace; redeeming it accepts the repository invitation that
    /// names it.
    pub(crate) async fn repo_invite_code(&self, actor: &User, email: &str) -> Result<Outcome<Invite>> {
        if let Some(reason) = Self::draft_allowed(actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        if !self.hit(&format!("invite.create:{}", actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let draft = Draft {
            email: Some(email),
            kind: "account",
            workspace_id: None,
            inviter: Some(actor),
            staff: None,
            invitee_id: None,
            role: None,
        };
        Ok(match self.insert_invite(draft).await? {
            Some(invite) => Outcome::Ok(invite),
            None => Outcome::fail(FailureCode::Conflict, "The invitation could not be made. Try again."),
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

    /// Sends one of the workspace's pending invitations again: the same
    /// email to the address it is bound to, or to the invited account's
    /// confirmed address, and the inbox notice again for an account. The
    /// invitation itself does not change. Counted against the owner's
    /// hourly allowance of invites made, so a list cannot be used to flood
    /// an inbox.
    pub async fn resend_workspace_invite(&self, a: WorkspaceInviteArgs) -> Result<Outcome<Invite>> {
        let slug = a.slug.trim().to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can send a workspace's invitations again."));
        }
        let row = self.invite_by_id(a.id.trim()).await?.filter(|row| row.workspace.as_deref() == Some(slug.as_str()));
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no invitation to this workspace with that id."));
        };
        let now = rfc3339(now_ms());
        if !resendable(row.status(&now)) {
            return Ok(Outcome::fail(FailureCode::Conflict, "Only a pending invitation can be sent again."));
        }
        if !self.hit(&format!("invite.create:{}", a.actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let Some(workspace_id) = row.workspace_id.as_deref() else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let code = row.sealed_code.as_deref().and_then(|sealed| self.invite_sealer()?.open(sealed, &row.id));
        // Where it goes: the address it is bound to, else the invited
        // account's confirmed address. An account invite (one that also
        // makes the account) carries the proof the link came from its email.
        let to = match &row.email {
            Some(email) => Some(email.clone()),
            None => match &row.invitee_id {
                Some(invitee) => self.verified_email_of(invitee).await?,
                None => None,
            },
        };
        if let (Some(to), Some(code)) = (&to, &code) {
            let from = self.display_name(&a.actor).await;
            let workspace = self.workspace_name(workspace_id, &slug).await;
            self.send_invite_email(to, Some(&from), Some(&workspace), row.kind == "workspace", code, &row.id, None).await;
        }
        if let Some(username) = row.invitee.as_deref().filter(|_| row.email.is_none()) {
            self.invitation_sent(&row, username).await;
        }
        self.audit_invites(&a.actor, "invite.resent", vec![slug.clone()], Surface::Web, format!("Sent invite {} again", row.hint)).await;
        Ok(Outcome::Ok(self.shown(row, true, false)))
    }

    /// The confirmed primary address of the account `user_id`, if it has one.
    async fn verified_email_of(&self, user_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Address {
            email: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT email FROM users WHERE id = ? AND email_verified_at IS NOT NULL AND deleted_at IS NULL")
            .bind(&[user_id.into()])?
            .first::<Address>(None)
            .await?
            .and_then(|row| row.email))
    }

    // --- Staff ---

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
    fn only_a_pending_invitation_is_sent_again() {
        assert!(resendable(InviteStatus::Pending));
        for over in [
            InviteStatus::AwaitingConfirmation,
            InviteStatus::AwaitingAnswer,
            InviteStatus::Redeemed,
            InviteStatus::Declined,
            InviteStatus::Expired,
            InviteStatus::Revoked,
        ] {
            assert!(!resendable(over), "{over:?}");
        }
    }

    #[test]
    fn an_inviters_note_is_trimmed_cut_and_dropped_when_blank() {
        assert_eq!(invite_note(None), None);
        assert_eq!(invite_note(Some("   ")), None);
        assert_eq!(invite_note(Some("  Welcome aboard  ")).as_deref(), Some("Welcome aboard"));
        let long = "x".repeat(MAX_INVITE_MESSAGE + 40);
        assert_eq!(invite_note(Some(&long)).map(|note| note.chars().count()), Some(MAX_INVITE_MESSAGE));
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
        assert_eq!(status_of(None, None, None, LATER, NOW), InviteStatus::Pending);
        assert_eq!(status_of(None, None, None, EARLIER, NOW), InviteStatus::Expired);
        assert_eq!(status_of(None, None, None, NOW, NOW), InviteStatus::Expired);
        assert_eq!(status_of(Some(EARLIER), None, None, LATER, NOW), InviteStatus::Revoked);
        assert_eq!(status_of(None, Some(EARLIER), Some(EARLIER), EARLIER, NOW), InviteStatus::Redeemed);
    }

    #[test]
    fn an_invite_used_to_sign_up_awaits_the_account_confirming_its_address() {
        // Spent, not applied: waiting, even past its expiry.
        assert_eq!(status_of(None, Some(EARLIER), None, LATER, NOW), InviteStatus::AwaitingConfirmation);
        assert_eq!(status_of(None, Some(EARLIER), None, EARLIER, NOW), InviteStatus::AwaitingConfirmation);
        // Revoked while waiting: revoked, whatever happens when it settles.
        assert_eq!(status_of(Some(NOW), Some(EARLIER), None, LATER, NOW), InviteStatus::Revoked);
        assert_eq!(status_of(Some(NOW), Some(EARLIER), Some(NOW), LATER, NOW), InviteStatus::Revoked);
        // A spent invite cannot be used again while it waits.
        let waiting = invite("account", None, InviteStatus::AwaitingConfirmation);
        assert_eq!(admits(Some(&waiting), "anyone@example.com", true), Err(Refusal::Invalid));
    }

    fn row(workspace: Option<(&str, Option<&str>)>, revoked: bool, expires_at: &str) -> InviteRow {
        InviteRow {
            id: "inv_1".into(),
            hint: "g1t-k7m2".into(),
            sealed_code: None,
            email: Some("ada@example.com".into()),
            kind: "account".into(),
            workspace_id: workspace.map(|(id, _)| id.to_owned()),
            workspace: workspace.and_then(|(_, slug)| slug.map(str::to_owned)),
            inviter_id: Some("usr_owner".into()),
            inviter: Some("bo".into()),
            staff: None,
            created_at: EARLIER.into(),
            expires_at: expires_at.into(),
            revoked_at: revoked.then(|| NOW.to_owned()),
            redeemer: Some("ada".into()),
            redeemed_at: Some(EARLIER.into()),
            applied_at: None,
            invitee_id: Some("usr_ada".into()),
            invitee: Some("ada".into()),
            role: None,
            accepted_at: None,
            declined_at: None,
        }
    }

    #[test]
    fn confirming_joins_the_workspace_the_invite_named_while_it_still_applies() {
        // Confirming no longer joins anything by itself: the workspace the
        // invite named becomes an invitation the person accepts or declines
        // (invites/invitations.rs), and accepting joins it.
        let good = row(Some(("wsp_1", Some("acme"))), false, LATER);
        assert_eq!(awaiting_join(&good, NOW), AwaitingJoin::Invited { workspace_id: "wsp_1".into(), slug: "acme".into() });
        // No workspace: nothing to join, and what came with it is accepted.
        assert_eq!(awaiting_join(&row(None, false, LATER), NOW), AwaitingJoin::Nothing);
        // Confirmed and not yet answered: awaiting the answer.
        let confirmed = InviteRow { applied_at: Some(NOW.into()), ..good };
        assert_eq!(confirmed.status(NOW), InviteStatus::AwaitingAnswer);
        // Accepted: used.
        let accepted = InviteRow { accepted_at: Some(NOW.into()), ..confirmed };
        assert_eq!(accepted.status(NOW), InviteStatus::Redeemed);
    }

    #[test]
    fn a_revoked_or_expired_invite_or_a_deleted_workspace_lapses_and_the_address_is_confirmed_anyway() {
        let lapsed = |join: AwaitingJoin| match join {
            AwaitingJoin::Lapsed(why) => why,
            other => panic!("expected a lapse, got {other:?}"),
        };
        let revoked = lapsed(awaiting_join(&row(Some(("wsp_1", Some("acme"))), true, LATER), NOW));
        assert!(revoked.starts_with("Your email address is confirmed."));
        assert!(revoked.contains("was revoked") && revoked.contains("no longer invites you to acme"));
        let expired = lapsed(awaiting_join(&row(Some(("wsp_1", Some("acme"))), false, EARLIER), NOW));
        assert!(expired.contains("expired before you confirmed it"));
        assert!(lapsed(awaiting_join(&row(Some(("wsp_1", Some("acme"))), false, NOW), NOW)).contains("expired"));
        // The workspace was deleted: its row no longer joins a slug.
        let deleted = lapsed(awaiting_join(&row(Some(("wsp_1", None)), false, LATER), NOW));
        assert!(deleted.contains("has been deleted"));
        // A free workspace still invites; accepting waits for its plan.
        assert!(matches!(awaiting_join(&row(Some(("wsp_1", Some("acme"))), false, LATER), NOW), AwaitingJoin::Invited { .. }));
        // Revoked beats expired; an invite without a workspace lapses too.
        assert!(lapsed(awaiting_join(&row(None, true, EARLIER), NOW)).contains("no longer applies"));
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

    const KEY: &[u8] = b"identity key";

    #[test]
    fn an_invite_emails_proof_is_for_its_invite_and_address_only() {
        let proof = email_proof(KEY, "inv_1", Some("ada@example.com")).unwrap();
        assert_eq!(proof.len(), 64);
        let proves = |id: &str, bound: Option<&str>, email: &str, proof: Option<&str>| proves_email(KEY, id, bound, email, proof);
        // The right invite and address, however the address is written.
        assert!(proves("inv_1", Some("ada@example.com"), "ada@example.com", Some(&proof)));
        assert!(proves("inv_1", Some("Ada@Example.com"), " ADA@example.com ", Some(&proof)));
        assert!(proves("inv_1", Some("ada@example.com"), "ada@example.com", Some(&proof.to_uppercase())));
        // Another address: the account confirms that one itself.
        assert!(!proves("inv_1", Some("ada@example.com"), "eve@example.com", Some(&proof)));
        // Another invite's proof, even for the same address.
        assert!(!proves("inv_2", Some("ada@example.com"), "ada@example.com", Some(&proof)));
        // Tampered, cut short, empty or missing.
        let mut tampered = proof.clone().into_bytes();
        tampered[10] = if tampered[10] == b'0' { b'1' } else { b'0' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(!proves("inv_1", Some("ada@example.com"), "ada@example.com", Some(&tampered)));
        assert!(!proves("inv_1", Some("ada@example.com"), "ada@example.com", Some(&proof[..32])));
        assert!(!proves("inv_1", Some("ada@example.com"), "ada@example.com", Some("")));
        assert!(!proves("inv_1", Some("ada@example.com"), "ada@example.com", None));
        // An invite bound to no address has no proof to give.
        assert_eq!(email_proof(KEY, "inv_1", None), None);
        assert!(!proves("inv_1", None, "ada@example.com", Some(&proof)));
        // Made under another key: not ours.
        let foreign = email_proof(b"another key", "inv_1", Some("ada@example.com")).unwrap();
        assert!(!proves("inv_1", Some("ada@example.com"), "ada@example.com", Some(&foreign)));
        // Without a key (development) none is made, and none is taken.
        assert_eq!(email_proof(b"", "inv_1", Some("ada@example.com")), None);
        let unkeyed = crypto::invite_proof(b"", "inv_1", "ada@example.com");
        assert!(!proves_email(b"", "inv_1", Some("ada@example.com"), "ada@example.com", Some(&unkeyed)));
    }

    #[test]
    fn an_account_starts_confirmed_only_from_the_invite_email_to_its_address() {
        let invite = row(None, false, LATER);
        let proof = email_proof(KEY, &invite.id, invite.email.as_deref()).unwrap();
        // From the invite email, with the address it was sent to.
        assert!(starts_confirmed(KEY, false, Some(&invite), "ada@example.com", Some(&proof)));
        // The code alone (typed in, or a link passed on), or a bad proof.
        assert!(!starts_confirmed(KEY, false, Some(&invite), "ada@example.com", None));
        assert!(!starts_confirmed(KEY, false, Some(&invite), "ada@example.com", Some("0123")));
        // A different address than the invite's.
        assert!(!starts_confirmed(KEY, false, Some(&invite), "eve@example.com", Some(&proof)));
        // No invite, or one bound to no address.
        assert!(!starts_confirmed(KEY, false, None, "ada@example.com", Some(&proof)));
        let unbound = InviteRow { email: None, ..row(None, false, LATER) };
        assert!(!starts_confirmed(KEY, false, Some(&unbound), "ada@example.com", Some(&proof)));
        // A workspace invite makes no account.
        let join = InviteRow { kind: "workspace".into(), ..row(None, false, LATER) };
        assert!(!starts_confirmed(KEY, false, Some(&join), "ada@example.com", Some(&proof)));
        // GitHub's confirmed address, whatever else.
        assert!(starts_confirmed(KEY, true, None, "ada@example.com", None));
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
        // A household or an office can still sign up a few people, and a
        // script cannot make accounts by the thousand.
        assert!((3..=20).contains(&REGISTRATIONS_PER_HOUR));
        const { assert!(ANONYMOUS_REGISTRATIONS_PER_HOUR >= REGISTRATIONS_PER_HOUR) };
    }
}
