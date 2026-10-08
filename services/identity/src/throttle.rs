//! Slowing down password guessing, and mail sent on request.
//!
//! Every check of a password (signing in on the site, git over HTTPS with a
//! password, confirming the password for a sensitive change) counts its
//! failures twice: against the account (or, for a name no account has,
//! against that name, so the answer never says which exist) and against
//! the client's IP address when the caller gives one. Past a key's limit in
//! its window, the key is locked for a minute, then twice as long after
//! each further failure, up to an hour ([`lockout_seconds`]). While either
//! key is locked, no password is even checked, and the answer is the same
//! [`THROTTLED`] for every account. A correct password clears the
//! account's count, never the client's. The first time an account is
//! locked in an hour, its primary and backup addresses are told.
//!
//! Requests that send mail (password resets, confirmation links) are
//! counted the same way, by address, account and client; past the limit
//! they quietly send nothing.
//!
//! Confirmation codes typed to confirm an email address are counted the
//! same way as passwords: wrong ones against the account and the client,
//! locking them the same way, with [`CODE_THROTTLED`] as the one answer
//! while locked. A right code clears the account's count.
//!
//! Counts live in `auth_throttle` (migration 0019), one row per key.

use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::{Identity, crypto};

/// What anyone hears while a key is locked.
pub const THROTTLED: &str = "Too many attempts. Wait a few minutes and try again, or reset your password.";

/// How many hits a key may have in its window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule {
    pub name: &'static str,
    pub limit: u32,
    pub window_seconds: u64,
}

const HOUR: u64 = 60 * 60;

/// Wrong passwords for one account (or one name), from anywhere.
pub const PASSWORD_ACCOUNT: Rule = Rule { name: "password.account", limit: 10, window_seconds: HOUR };
/// Wrong passwords from one client, for any accounts.
pub const PASSWORD_CLIENT: Rule = Rule { name: "password.client", limit: 30, window_seconds: HOUR };
/// Password resets asked for one address.
pub const RESET_EMAIL: Rule = Rule { name: "reset.email", limit: 5, window_seconds: HOUR };
/// Password resets asked from one client.
pub const RESET_CLIENT: Rule = Rule { name: "reset.client", limit: 20, window_seconds: HOUR };
/// Confirmation links one account asks for.
pub const CONFIRM_ACCOUNT: Rule = Rule { name: "confirm.account", limit: 10, window_seconds: HOUR };

/// Wrong confirmation codes typed for one account, from anywhere.
pub const CODE_ACCOUNT: Rule = Rule { name: "code.account", limit: 10, window_seconds: HOUR };
/// Wrong confirmation codes typed from one client, for any accounts.
pub const CODE_CLIENT: Rule = Rule { name: "code.client", limit: 30, window_seconds: HOUR };

/// What anyone hears while confirmation codes are locked for them.
pub const CODE_THROTTLED: &str = "Too many wrong codes. Wait a few minutes and try again, or follow the link in the email.";

// One account is held to less than one client, which may be an office.
const _: () = assert!(
    PASSWORD_ACCOUNT.limit < PASSWORD_CLIENT.limit
        && RESET_EMAIL.limit < RESET_CLIENT.limit
        && CODE_ACCOUNT.limit < CODE_CLIENT.limit
);

/// How long a key with `hits` in its window is locked: not at all below
/// the limit, a minute at it, doubling with each hit past it, up to an hour.
pub fn lockout_seconds(hits: u32, limit: u32) -> u64 {
    if hits < limit {
        return 0;
    }
    (60u64 << (hits - limit).min(6)).min(HOUR)
}

/// A key's name in `auth_throttle`. Addresses, IPs and names are hashed,
/// so the table holds nothing to read back.
pub fn key(rule: Rule, subject: &str) -> String {
    format!("{}:{}", rule.name, crypto::sha256_hex(&subject.trim().to_lowercase()))
}

#[derive(Deserialize)]
struct Hits {
    hits: f64,
}

/// What one more failure did.
#[derive(Debug, PartialEq, Eq)]
pub struct Counted {
    pub hits: u32,
    /// This failure is the one that locked the key.
    pub locked_now: bool,
}

impl Identity {
    /// Whether `key` is locked.
    pub async fn locked(&self, key: &str) -> Result<bool> {
        let now = rfc3339(now_ms());
        let row = self
            .db
            .prepare("SELECT 1 AS hits FROM auth_throttle WHERE key = ? AND locked_until > ?")
            .bind(&[key.into(), now.as_str().into()])?
            .first::<Hits>(None)
            .await?;
        Ok(row.is_some())
    }

    /// Counts one more hit on `key`, starting a new window when the last
    /// one has passed, and locks it past `rule`'s limit.
    pub async fn count(&self, rule: Rule, key: &str) -> Result<Counted> {
        let now = now_ms();
        let stamp = rfc3339(now);
        let window_start = rfc3339(now.saturating_sub(rule.window_seconds * 1000));
        let hits = self
            .db
            .prepare(
                "INSERT INTO auth_throttle (key, hits, window_start) VALUES (?1, 1, ?2)
                 ON CONFLICT (key) DO UPDATE SET
                   hits = CASE WHEN auth_throttle.window_start < ?3 THEN 1 ELSE auth_throttle.hits + 1 END,
                   window_start = CASE WHEN auth_throttle.window_start < ?3 THEN ?2 ELSE auth_throttle.window_start END
                 RETURNING hits",
            )
            .bind(&[key.into(), stamp.as_str().into(), window_start.as_str().into()])?
            .first::<Hits>(None)
            .await?
            .map_or(1, |row| row.hits as u32);
        let lock = lockout_seconds(hits, rule.limit);
        if lock > 0 {
            self.db
                .prepare("UPDATE auth_throttle SET locked_until = ? WHERE key = ?")
                .bind(&[rfc3339(now + lock * 1000).into(), key.into()])?
                .run()
                .await?;
        }
        if hits == 1 {
            // A new window: forget keys a day quiet.
            self.db
                .prepare("DELETE FROM auth_throttle WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)")
                .bind(&[rfc3339(now.saturating_sub(24 * HOUR * 1000)).into(), stamp.as_str().into()])?
                .run()
                .await?;
        }
        Ok(Counted { hits, locked_now: hits == rule.limit })
    }

    /// Counts a request that sends mail; false once past the limit.
    pub async fn allow(&self, rule: Rule, subject: &str) -> Result<bool> {
        Ok(self.count(rule, &key(rule, subject)).await?.hits <= rule.limit)
    }

    /// Forgets a key's failures: its owner got the password right.
    pub async fn clear(&self, key: &str) -> Result<()> {
        self.db.prepare("DELETE FROM auth_throttle WHERE key = ?").bind(&[key.into()])?.run().await?;
        Ok(())
    }

    /// The keys a password check for `login` (a username or an address)
    /// from `client` counts against: the account's, or the name's when no
    /// account has it, and the client's.
    pub fn password_keys(account: &str, client: Option<&str>) -> (String, Option<String>) {
        (
            key(PASSWORD_ACCOUNT, account),
            client.filter(|client| !client.trim().is_empty()).map(|client| key(PASSWORD_CLIENT, client)),
        )
    }

    /// Whether a password check may run now.
    pub async fn password_locked(&self, account_key: &str, client_key: Option<&str>) -> Result<bool> {
        if self.locked(account_key).await? {
            return Ok(true);
        }
        match client_key {
            Some(client_key) => self.locked(client_key).await,
            None => Ok(false),
        }
    }

    /// Counts a wrong password, and tells the account's owner the first
    /// time in an hour that it locks their account.
    pub async fn password_failed(&self, account_key: &str, client_key: Option<&str>, user: Option<(&str, &str)>) -> Result<()> {
        let counted = self.count(PASSWORD_ACCOUNT, account_key).await?;
        if let Some(client_key) = client_key {
            self.count(PASSWORD_CLIENT, client_key).await?;
        }
        if counted.locked_now
            && let Some((user_id, username)) = user
            && self.first_notice(account_key).await?
        {
            self.log_security(user_id, "password_locked", Some(&format!("{} wrong passwords", counted.hits)), None)
                .await;
            self.tell_primary_and_backup(
                user_id,
                username,
                &format!("Password sign-in was paused after {} wrong passwords", counted.hits),
            )
            .await;
        }
        Ok(())
    }

    /// Marks that the owner was told about a lock; false when they were in
    /// the last hour.
    async fn first_notice(&self, key: &str) -> Result<bool> {
        let now = now_ms();
        let row = self
            .db
            .prepare(
                "UPDATE auth_throttle SET notified_at = ?1
                 WHERE key = ?2 AND (notified_at IS NULL OR notified_at < ?3) RETURNING 1 AS hits",
            )
            .bind(&[rfc3339(now).into(), key.into(), rfc3339(now.saturating_sub(HOUR * 1000)).into()])?
            .first::<Hits>(None)
            .await?;
        Ok(row.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_locks_at_its_limit_and_backs_off_to_an_hour() {
        assert_eq!(lockout_seconds(0, 10), 0);
        assert_eq!(lockout_seconds(9, 10), 0);
        assert_eq!(lockout_seconds(10, 10), 60);
        assert_eq!(lockout_seconds(11, 10), 120);
        assert_eq!(lockout_seconds(12, 10), 240);
        assert_eq!(lockout_seconds(15, 10), 1920);
        assert_eq!(lockout_seconds(16, 10), 3600);
        assert_eq!(lockout_seconds(1000, 10), 3600);
    }

    #[test]
    fn wrong_confirmation_codes_lock_the_account_after_ten_and_the_client_after_thirty() {
        assert_eq!(lockout_seconds(CODE_ACCOUNT.limit - 1, CODE_ACCOUNT.limit), 0);
        assert_eq!(lockout_seconds(CODE_ACCOUNT.limit, CODE_ACCOUNT.limit), 60);
        assert_eq!(lockout_seconds(CODE_CLIENT.limit - 1, CODE_CLIENT.limit), 0);
        assert_eq!(lockout_seconds(CODE_CLIENT.limit, CODE_CLIENT.limit), 60);
        // With a code living an hour, an account gets about ten guesses
        // and a few more as the lock backs off: far from a million.
        let mut tries_in_an_hour = CODE_ACCOUNT.limit;
        let mut waited = 0;
        while waited < 3600 {
            waited += lockout_seconds(tries_in_an_hour, CODE_ACCOUNT.limit);
            tries_in_an_hour += 1;
        }
        assert!(tries_in_an_hour < 20, "{tries_in_an_hour}");
        // Kept apart from passwords, so one cannot lock the other.
        assert_ne!(key(CODE_ACCOUNT, "usr_1"), key(PASSWORD_ACCOUNT, "usr_1"));
        assert!(key(CODE_CLIENT, "203.0.113.9").starts_with("code.client:"));
    }

    #[test]
    fn keys_hash_their_subject_and_ignore_case() {
        let a = key(PASSWORD_ACCOUNT, "Ada@Example.com ");
        assert_eq!(a, key(PASSWORD_ACCOUNT, "ada@example.com"));
        assert!(a.starts_with("password.account:"));
        assert!(!a.contains("ada"));
        assert_ne!(a, key(RESET_EMAIL, "ada@example.com"));
    }
}
