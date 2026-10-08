//! Device sign-in (RFC 8628): how an agent or command-line tool gets an
//! access token without ever seeing a password.
//!
//! The tool starts a request and shows the person a short code and a URL.
//! The person signs in on the website, or registers there, and approves the
//! code. The tool polls until that happens and receives a token. Account
//! creation and passwords stay in the browser, where they can be protected.

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, sql_after};
use g1t_contracts::{FailureCode, Outcome, User};
use serde::Deserialize;
use worker::Result;

use crate::{Identity, crypto};

const EXPIRES_IN_SECONDS: u64 = 15 * 60;
const POLL_INTERVAL_SECONDS: u32 = 5;
/// No vowels, so a code never spells a word, and nothing easily confused.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";

#[derive(Deserialize)]
struct DeviceRow {
    user_code: String,
    client_name: String,
    status: String,
    user_id: Option<String>,
}

/// Eight letters as `XXXX-XXXX`.
fn new_user_code() -> String {
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random).expect("no source of randomness");
    let letters: String = random
        .iter()
        .map(|byte| USER_CODE_ALPHABET[*byte as usize % USER_CODE_ALPHABET.len()] as char)
        .collect();
    format!("{}-{}", &letters[..4], &letters[4..])
}

/// A user code as stored, however it was typed.
fn normalize(user_code: &str) -> String {
    let letters: String = user_code
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    match letters.len() {
        8 => format!("{}-{}", &letters[..4], &letters[4..]),
        _ => letters,
    }
}

impl Identity {
    pub async fn device_start(&self, a: DeviceStartArgs) -> Result<DeviceStart> {
        let device_code = crypto::random_hex(32);
        let user_code = new_user_code();
        let client_name: String = match a.client_name.trim() {
            "" => "An application".to_owned(),
            name => name.chars().take(60).collect(),
        };
        self.db
            .prepare(format!(
                "INSERT INTO device_codes (id, user_code, client_name, expires_at)
                 VALUES (?, ?, ?, {})",
                sql_after(EXPIRES_IN_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&device_code).into(),
                user_code.as_str().into(),
                client_name.into(),
            ])?
            .run()
            .await?;
        Ok(DeviceStart {
            device_code,
            user_code,
            expires_in: EXPIRES_IN_SECONDS as u32,
            interval: POLL_INTERVAL_SECONDS,
        })
    }

    /// The pending, unexpired request with this user code.
    async fn pending_device(&self, user_code: &str) -> Result<Option<DeviceRow>> {
        self.db
            .prepare(format!(
                "SELECT user_code, client_name, status, user_id FROM device_codes
                 WHERE user_code = ? AND status = 'pending' AND expires_at > {SQL_NOW}"
            ))
            .bind(&[normalize(user_code).into()])?
            .first::<DeviceRow>(None)
            .await
    }

    pub async fn device_lookup(&self, a: DeviceLookupArgs) -> Result<Option<DeviceRequest>> {
        Ok(self
            .pending_device(&a.user_code)
            .await?
            .map(|row| DeviceRequest {
                user_code: row.user_code,
                client_name: row.client_name,
            }))
    }

    pub async fn device_resolve(&self, a: DeviceResolveArgs) -> Result<Outcome<bool>> {
        // A token for an account that cannot use it yet (emails.rs).
        if a.approve && a.user.awaits_confirmation() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address before signing in to an application."));
        }
        let Some(row) = self.pending_device(&a.user_code).await? else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "That code is not valid or has expired. Start again from the application.",
            ));
        };
        self.db
            .prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE user_code = ?")
            .bind(&[
                if a.approve { "approved" } else { "denied" }.into(),
                a.user.id.into(),
                row.user_code.into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(a.approve))
    }

    pub async fn device_claim(&self, a: DeviceClaimArgs) -> Result<DeviceClaim> {
        let id = crypto::sha256_hex(&a.device_code);
        let row = self
            .db
            .prepare(format!(
                "SELECT user_code, client_name, status, user_id FROM device_codes
                 WHERE id = ? AND expires_at > {SQL_NOW}"
            ))
            .bind(&[id.as_str().into()])?
            .first::<DeviceRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(DeviceClaim::Expired);
        };
        let user_id = match (row.status.as_str(), row.user_id) {
            ("pending", _) => return Ok(DeviceClaim::Pending),
            ("approved", Some(user_id)) => user_id,
            _ => {
                self.forget_device(&id).await?;
                return Ok(DeviceClaim::Denied);
            }
        };
        // A device code yields exactly one token.
        self.forget_device(&id).await?;
        let Some(user) = self
            .find_user(
                "SELECT id, username, email_verified_at IS NOT NULL AS verified
                 FROM users WHERE id = ? AND deleted_at IS NULL",
                &user_id,
            )
            .await?
        else {
            return Ok(DeviceClaim::Expired);
        };
        let created = self
            .create_access_token(CreateAccessTokenArgs {
                user: User { ..user.clone() },
                name: row.client_name,
                ttl_seconds: None,
                // A tool a person signed in to themselves acts as them.
                scopes: None,
                listed: false,
            })
            .await?;
        Ok(DeviceClaim::Approved {
            token: created.token,
            user,
        })
    }

    async fn forget_device(&self, id: &str) -> Result<()> {
        self.db
            .prepare("DELETE FROM device_codes WHERE id = ?")
            .bind(&[id.into()])?
            .run()
            .await?;
        Ok(())
    }
}
