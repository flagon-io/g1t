//! Two-factor authentication: a time-based code from an authenticator app
//! (TOTP, RFC 6238, with HMAC-SHA1, six digits and 30-second steps, as every
//! app reads it), and recovery codes for when the app is lost.
//!
//! **Turning it on.** `two_factor_start` makes a secret, sealed at rest
//! with `IDENTITY_KEY` and bound to the account (`g1t_secrets::Sealer`),
//! and returns it with an `otpauth://` address for a QR code. A code from
//! the app given to `two_factor_enable` confirms it; ten recovery codes are
//! made then and shown once, kept only as their SHA-256. Both, and turning
//! it off, need the person to prove it is them (security.rs, "sudo mode");
//! turning it off also needs a code.
//!
//! **Signing in.** With it on, a right password makes no session:
//! `sign_in` returns a challenge (lib.rs, `start_session`) that
//! `two_factor_sign_in` trades, with a code, for the session. A challenge
//! lasts ten minutes and [`TWO_FACTOR_ATTEMPTS`] wrong codes. Git over HTTPS
//! takes an access token then, never the password.
//!
//! **Codes.** A code is accepted for its own step and one either side, for
//! clocks a little off, and never twice: `two_factor.last_step` keeps the
//! last step used, and only a later one is accepted after it. A recovery
//! code works once.
//!
//! Each change is in the account's security log, mailed to its primary and
//! backup addresses, and recorded in the audit log of every workspace the
//! person belongs to.

use g1t_contracts::accounts::*;
use g1t_contracts::identity::{SignedIn, UserArgs};
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Outcome, Role, User};
use g1t_kit::now_ms;
use g1t_secrets::Sealer;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use worker::Result;

use crate::security::{PEOPLE_ONLY, is_person};
use crate::{Identity, crypto};

const NOT_ON: &str = "Two-factor authentication is not on for this account.";
const WRONG_CODE: &str = "That code is not right. Use the current code from your authenticator app, or a recovery code.";
const NO_KEY: &str = "Two-factor authentication is not available right now.";

// --- TOTP, RFC 6238 ---

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32, without padding, as authenticator apps take secrets.
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            out.push(BASE32[((buffer >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The bytes of a base32 secret; spaces, case and padding ignored.
pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in text.chars().filter(|c| !c.is_whitespace() && *c != '=') {
        let value = BASE32.iter().position(|&b| b as char == c.to_ascii_uppercase())? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            out.push(((buffer >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

/// The HOTP value (RFC 4226) of `secret` at `counter`, as six digits.
pub fn hotp(secret: &[u8], counter: u64) -> String {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    format!("{:0width$}", binary % 10u32.pow(TOTP_DIGITS), width = TOTP_DIGITS as usize)
}

/// The step a time falls in.
pub fn step_at(unix_seconds: u64) -> u64 {
    unix_seconds / TOTP_STEP_SECONDS
}

/// The step `code` is right for, within [`TOTP_SKEW_STEPS`] of now and
/// after `last_step` (so no code is accepted twice); `None` otherwise.
pub fn verify_totp(secret: &[u8], code: &str, unix_seconds: u64, last_step: u64) -> Option<u64> {
    let code = tidy_code(code);
    if !is_totp_shaped(&code) {
        return None;
    }
    let now = step_at(unix_seconds);
    let mut found = None;
    for step in now.saturating_sub(TOTP_SKEW_STEPS)..=now + TOTP_SKEW_STEPS {
        // Compared in full every time, so timing says nothing of which.
        let right = hotp(secret, step).bytes().zip(code.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0;
        if right && step > last_step && found.is_none() {
            found = Some(step);
        }
    }
    found
}

/// A recovery code: ten characters in two groups, such as `k7m2q-9xw4d`.
fn new_recovery_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut bytes = [0u8; 10];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");
    let chars: String = bytes.iter().map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char).collect();
    format!("{}-{}", &chars[..5], &chars[5..])
}

/// What a recovery code is kept as.
pub fn recovery_hash(code: &str) -> String {
    crypto::sha256_hex(&tidy_code(code))
}

#[derive(Deserialize)]
struct Row {
    secret: String,
    enabled_at: Option<String>,
    last_step: f64,
}

impl Identity {
    fn two_factor_sealer(&self) -> Option<Sealer> {
        Sealer::new(&self.env.secret("IDENTITY_KEY").ok()?.to_string())
    }

    async fn two_factor_row(&self, user_id: &str) -> Result<Option<Row>> {
        self.db
            .prepare("SELECT secret, enabled_at, last_step FROM two_factor WHERE user_id = ?")
            .bind(&[user_id.into()])?
            .first::<Row>(None)
            .await
    }

    /// Whether the account has two-factor authentication on.
    pub async fn two_factor_enabled(&self, user_id: &str) -> Result<bool> {
        Ok(self.two_factor_row(user_id).await?.is_some_and(|row| row.enabled_at.is_some()))
    }

    /// The secret of a row, opened.
    fn opened(&self, user_id: &str, row: &Row) -> Option<Vec<u8>> {
        let text = self.two_factor_sealer()?.open(&row.secret, &bound(user_id))?;
        base32_decode(&text)
    }

    /// Whether `code` is a right code for the account, using it up: an app
    /// code's step is recorded, a recovery code is spent. With `pending`, the
    /// enrolment in progress is what is checked, and recovery codes are not.
    async fn use_code(&self, user_id: &str, code: &str, pending: bool) -> Result<bool> {
        let Some(row) = self.two_factor_row(user_id).await? else {
            return Ok(false);
        };
        if pending != row.enabled_at.is_none() {
            return Ok(false);
        }
        let tidy = tidy_code(code);
        if is_totp_shaped(&tidy) {
            let Some(secret) = self.opened(user_id, &row) else {
                return Ok(false);
            };
            let Some(step) = verify_totp(&secret, &tidy, now_ms() / 1000, row.last_step as u64) else {
                return Ok(false);
            };
            // Only a later step moves it on, so two requests with one code
            // cannot both pass.
            let moved = self
                .db
                .prepare("UPDATE two_factor SET last_step = ?1 WHERE user_id = ?2 AND last_step < ?1 RETURNING user_id")
                .bind(&[(step as f64).into(), user_id.into()])?
                .first::<serde_json::Value>(None)
                .await?;
            return Ok(moved.is_some());
        }
        if pending {
            return Ok(false);
        }
        let spent = self
            .db
            .prepare(
                "UPDATE two_factor_recovery SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
                 RETURNING code_hash",
            )
            .bind(&[rfc3339(now_ms()).into(), user_id.into(), recovery_hash(&tidy).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if spent.is_some() {
            self.log_security(user_id, "recovery_code_used", None, None).await;
        }
        Ok(spent.is_some())
    }

    /// Ten new recovery codes for the account, replacing any it had.
    async fn new_recovery_codes(&self, user_id: &str) -> Result<RecoveryCodes> {
        let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| new_recovery_code()).collect();
        let mut statements = vec![
            self.db
                .prepare("DELETE FROM two_factor_recovery WHERE user_id = ?")
                .bind(&[user_id.into()])?,
        ];
        for code in &codes {
            statements.push(
                self.db
                    .prepare("INSERT OR IGNORE INTO two_factor_recovery (user_id, code_hash) VALUES (?, ?)")
                    .bind(&[user_id.into(), recovery_hash(code).into()])?,
            );
        }
        self.db.batch(statements).await?;
        Ok(RecoveryCodes { codes })
    }

    /// The workspaces the person belongs to that require two-factor
    /// authentication, and of those, the ones they own.
    async fn requiring_workspaces(&self, user_id: &str) -> Result<Vec<(String, bool)>> {
        #[derive(Deserialize)]
        struct Requiring {
            slug: String,
            role: Role,
        }
        Ok(self
            .db
            .prepare(
                "SELECT w.slug, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                 WHERE m.user_id = ? AND w.require_two_factor = 1 AND w.deleted_at IS NULL ORDER BY w.slug",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<Requiring>()?
            .into_iter()
            .map(|row| (row.slug, row.role == Role::Owner))
            .collect())
    }

    /// `two_factor_status`.
    pub async fn two_factor_status(&self, a: UserArgs) -> Result<Outcome<TwoFactorStatus>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        #[derive(Deserialize)]
        struct Left {
            left: u32,
        }
        let row = self.two_factor_row(&a.user.id).await?;
        let left = self
            .db
            .prepare("SELECT count(*) AS left FROM two_factor_recovery WHERE user_id = ? AND used_at IS NULL")
            .bind(&[a.user.id.as_str().into()])?
            .first::<Left>(None)
            .await?
            .map_or(0, |row| row.left);
        let enabled_at = row.and_then(|row| row.enabled_at);
        Ok(Outcome::Ok(TwoFactorStatus {
            enabled: enabled_at.is_some(),
            recovery_codes_left: if enabled_at.is_some() { left } else { 0 },
            enabled_at,
            required_by: self.requiring_workspaces(&a.user.id).await?.into_iter().map(|(slug, _)| slug).collect(),
        }))
    }

    /// `two_factor_start`.
    pub async fn two_factor_start(&self, a: TwoFactorArgs) -> Result<Outcome<TwoFactorSetup>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        if let Some(refused) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refused);
        }
        if self.two_factor_enabled(&a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Two-factor authentication is already on."));
        }
        let Some(sealer) = self.two_factor_sealer() else {
            return Ok(Outcome::fail(FailureCode::Conflict, NO_KEY));
        };
        let mut bytes = [0u8; 20];
        getrandom::getrandom(&mut bytes).expect("no source of randomness");
        let secret = base32_encode(&bytes);
        self.db
            .prepare(
                "INSERT INTO two_factor (user_id, secret, enabled_at, created_at, last_step) VALUES (?1, ?2, NULL, ?3, 0)
                 ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, enabled_at = NULL,
                   created_at = excluded.created_at, last_step = 0",
            )
            .bind(&[a.user.id.as_str().into(), sealer.seal(&secret, &bound(&a.user.id)).into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(TwoFactorSetup { uri: otpauth_uri(&secret, &a.user.username), secret }))
    }

    /// `two_factor_enable`.
    pub async fn two_factor_enable(&self, a: TwoFactorCodeArgs) -> Result<Outcome<RecoveryCodes>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        if let Some(refused) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refused);
        }
        if self.two_factor_enabled(&a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "Two-factor authentication is already on."));
        }
        if self.two_factor_row(&a.user.id).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Start again: scan the QR code, then enter the code your app shows."));
        }
        if !self.use_code(&a.user.id, &a.code, true).await? {
            return Ok(Outcome::fail(FailureCode::Invalid, "That code is not right. Enter the code your app shows now."));
        }
        self.db
            .prepare(format!("UPDATE two_factor SET enabled_at = {SQL_NOW} WHERE user_id = ?"))
            .bind(&[a.user.id.as_str().into()])?
            .run()
            .await?;
        let codes = self.new_recovery_codes(&a.user.id).await?;
        self.log_security(&a.user.id, "two_factor_enabled", Some("Authenticator app"), None).await;
        self.tell_primary_and_backup(&a.user.id, &a.user.username, "Two-factor authentication was turned on").await;
        self.audit_account(&a.user, "two_factor.enabled", "Turned on two-factor authentication").await;
        Ok(Outcome::Ok(codes))
    }

    /// `two_factor_disable`.
    pub async fn two_factor_disable(&self, a: TwoFactorCodeArgs) -> Result<Outcome<bool>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        if let Some(refused) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refused);
        }
        if !self.two_factor_enabled(&a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, NOT_ON));
        }
        let owned: Vec<String> = self
            .requiring_workspaces(&a.user.id)
            .await?
            .into_iter()
            .filter_map(|(slug, owner)| owner.then_some(slug))
            .collect();
        if !owned.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!(
                    "You own {}, which requires two-factor authentication. Stop requiring it there first, or hand the workspace to another owner.",
                    owned.join(", ")
                ),
            ));
        }
        if !self.use_code(&a.user.id, &a.code, false).await? {
            return Ok(Outcome::fail(FailureCode::Invalid, WRONG_CODE));
        }
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM two_factor WHERE user_id = ?").bind(&[a.user.id.as_str().into()])?,
                self.db.prepare("DELETE FROM two_factor_recovery WHERE user_id = ?").bind(&[a.user.id.as_str().into()])?,
                self.db.prepare("DELETE FROM two_factor_challenges WHERE user_id = ?").bind(&[a.user.id.as_str().into()])?,
            ])
            .await?;
        self.log_security(&a.user.id, "two_factor_disabled", None, None).await;
        self.tell_primary_and_backup(&a.user.id, &a.user.username, "Two-factor authentication was turned off").await;
        self.audit_account(&a.user, "two_factor.disabled", "Turned off two-factor authentication").await;
        Ok(Outcome::Ok(true))
    }

    /// `two_factor_recovery_codes`.
    pub async fn two_factor_recovery_codes(&self, a: TwoFactorArgs) -> Result<Outcome<RecoveryCodes>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        if let Some(refused) = self.proof(&a.user.id, &a.reauth).await?.refusal() {
            return Ok(refused);
        }
        if !self.two_factor_enabled(&a.user.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, NOT_ON));
        }
        let codes = self.new_recovery_codes(&a.user.id).await?;
        self.log_security(&a.user.id, "recovery_codes_regenerated", None, None).await;
        self.tell_primary_and_backup(&a.user.id, &a.user.username, "New two-factor recovery codes were made; the old ones no longer work").await;
        Ok(Outcome::Ok(codes))
    }

    /// A sign-in waiting for its code: the token the caller passes back.
    pub(crate) async fn issue_challenge(&self, user_id: &str) -> Result<String> {
        let token = crypto::random_hex(32);
        self.db
            .batch(vec![
                // Old ones for the account go; a sign-in starts one afresh.
                self.db
                    .prepare(format!("DELETE FROM two_factor_challenges WHERE user_id = ? OR expires_at <= {SQL_NOW}"))
                    .bind(&[user_id.into()])?,
                self.db
                    .prepare(format!(
                        "INSERT INTO two_factor_challenges (id, user_id, expires_at, attempts) VALUES (?, ?, {}, 0)",
                        sql_after(TWO_FACTOR_CHALLENGE_SECONDS)
                    ))
                    .bind(&[crypto::sha256_hex(&token).into(), user_id.into()])?,
            ])
            .await?;
        Ok(token)
    }

    /// `two_factor_sign_in`.
    pub async fn two_factor_sign_in(&self, a: TwoFactorSignInArgs) -> Result<Outcome<SignedIn>> {
        #[derive(Deserialize)]
        struct Challenge {
            user_id: String,
            attempts: u32,
        }
        let id = crypto::sha256_hex(&a.challenge);
        let challenge = self
            .db
            .prepare(format!("SELECT user_id, attempts FROM two_factor_challenges WHERE id = ? AND expires_at > {SQL_NOW}"))
            .bind(&[id.as_str().into()])?
            .first::<Challenge>(None)
            .await?;
        let expired = || Ok(Outcome::fail(FailureCode::Unauthenticated, "This sign-in has expired. Sign in again."));
        let Some(challenge) = challenge else {
            return expired();
        };
        if challenge.attempts >= TWO_FACTOR_ATTEMPTS {
            self.db.prepare("DELETE FROM two_factor_challenges WHERE id = ?").bind(&[id.as_str().into()])?.run().await?;
            return expired();
        }
        if !self.use_code(&challenge.user_id, &a.code, false).await? {
            self.db
                .prepare("UPDATE two_factor_challenges SET attempts = attempts + 1 WHERE id = ?")
                .bind(&[id.as_str().into()])?
                .run()
                .await?;
            return Ok(Outcome::fail(FailureCode::Unauthenticated, WRONG_CODE));
        }
        self.db.prepare("DELETE FROM two_factor_challenges WHERE id = ?").bind(&[id.as_str().into()])?.run().await?;
        let user = self
            .find_user(
                "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ?",
                &challenge.user_id,
            )
            .await?;
        let Some(user) = user else {
            return expired();
        };
        self.session_for(user).await
    }

    /// Records a change to the person's own account in the audit log of
    /// every workspace they belong to, where its owners look.
    pub(crate) async fn audit_account(&self, user: &User, action: &str, message: &str) {
        let Ok(memberships) = self.memberships(&user.id).await else {
            return;
        };
        for membership in memberships {
            self.audit_workspace(user, action, &membership.slug, g1t_contracts::audit::Surface::Web, message.to_owned()).await;
        }
    }
}

/// What a sealed secret is bound to.
fn bound(user_id: &str) -> String {
    format!("two_factor:{user_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238, appendix B: the SHA-1 key and the 8-digit values, cut to
    /// six digits (the last six of each).
    #[test]
    fn codes_match_rfc_6238() {
        let secret = b"12345678901234567890";
        for (time, expected) in [
            (59u64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ] {
            assert_eq!(hotp(secret, step_at(time)), expected[2..], "at {time}");
        }
    }

    #[test]
    fn base32_round_trips_and_reads_what_apps_show() {
        let bytes = b"12345678901234567890";
        let text = base32_encode(bytes);
        assert_eq!(text, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(base32_decode(&text).unwrap(), bytes);
        assert_eq!(base32_decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").unwrap(), bytes);
        assert!(base32_decode("not base32!").is_none());
    }

    #[test]
    fn a_code_works_a_step_either_side_and_no_further() {
        let secret = b"12345678901234567890";
        let now = 1_111_111_111;
        let step = step_at(now);
        let current = hotp(secret, step);
        assert_eq!(verify_totp(secret, &current, now, 0), Some(step));
        // A clock 30 seconds behind or ahead still gets in.
        assert_eq!(verify_totp(secret, &hotp(secret, step - 1), now, 0), Some(step - 1));
        assert_eq!(verify_totp(secret, &hotp(secret, step + 1), now, 0), Some(step + 1));
        // Two steps off does not.
        assert_eq!(verify_totp(secret, &hotp(secret, step - 2), now, 0), None);
        assert_eq!(verify_totp(secret, &hotp(secret, step + 2), now, 0), None);
        // Typed with a space, it is the same code.
        assert_eq!(verify_totp(secret, &format!("{} {}", &current[..3], &current[3..]), now, 0), Some(step));
        assert_eq!(verify_totp(secret, "abcdef", now, 0), None);
    }

    #[test]
    fn a_code_is_never_accepted_twice() {
        let secret = b"12345678901234567890";
        let now = 1_111_111_111;
        let step = step_at(now);
        let current = hotp(secret, step);
        let used = verify_totp(secret, &current, now, 0).unwrap();
        // Replayed: the step it was used for is the last, so it is refused.
        assert_eq!(verify_totp(secret, &current, now, used), None);
        // And an older code, still in the window, is refused after it.
        assert_eq!(verify_totp(secret, &hotp(secret, step - 1), now, used), None);
        // The next step's code is fine.
        assert_eq!(verify_totp(secret, &hotp(secret, step + 1), now + 30, used), Some(step + 1));
    }

    #[test]
    fn recovery_codes_are_two_groups_and_kept_as_hashes() {
        let code = new_recovery_code();
        assert_eq!(code.len(), 11);
        assert_eq!(&code[5..6], "-");
        assert_eq!(recovery_hash(&code), recovery_hash(&code.to_uppercase().replace('-', " ")));
        assert_ne!(recovery_hash(&code), code);
    }
}
