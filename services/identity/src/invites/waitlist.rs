//! The private preview: who may make an account, and the waitlist.
//!
//! In `invite` mode (g1t.sh's private preview) an account is made only
//! with an invite to g1t for its own address: from an invitation into a
//! workspace or onto a repository, Invite a friend, or staff approving a
//! request here. In `open` mode anyone signs up. Staff flip it in sudo
//! (`admin_set_registration`), kept in `identity_settings`, so it changes
//! with no deploy and no code coming out; until anyone has, the
//! `REGISTRATION_MODE` var says, and unset is `open`, as a self-hosted g1t
//! has it. The gate is in [`Identity::create_account`], the
//! one place an account is made, so sign-up with a password and through
//! GitHub are held to it alike.
//!
//! Without an invite, people ask for one (`request_access`): one row of
//! `waitlist` per address, which staff approve or dismiss in sudo. The
//! person asking gets one confirmation, ever; staff get a summary of new
//! requests at `WAITLIST_NOTIFY_EMAIL`, at most once every 15 minutes, sent
//! by the request that finds one due or else by the 15-minute sweep.
//!
//! Any other way in answers a request too, so the queue never holds
//! someone who is already in: an invite made for a waiting address (Invite
//! a friend, a workspace or repository invitation) marks it invited, by
//! whoever sent it; so does an account made with that address; and someone
//! asking who already has an account, or a pending invite, is marked so at
//! once, with no confirmation and nothing told to staff.

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{BAD_EMAIL, Count, Draft, Id, TOO_MANY, normalize_email};
use crate::{Identity, crypto};

/// Requests one client address may make in an hour.
const REQUESTS_PER_HOUR: u32 = 5;
/// Requests in an hour, together, from callers that name no client.
const ANONYMOUS_REQUESTS_PER_HOUR: u32 = 200;
/// Confirmations sent in an hour across everyone: anyone can type any
/// address, so this caps what the form can make g1t send.
const CONFIRMATIONS_PER_HOUR: u32 = 300;
/// The least time between two summaries to staff.
const SUMMARY_EVERY_MS: u64 = 15 * 60 * 1000;

/// What a new account without an invite is told in private preview.
pub const PREVIEW_ONLY: &str = "g1t is in private preview. Ask for access and we'll email you an invite.";
const NOT_ON_IT: &str = "That request is not on the waitlist.";
/// The row of `identity_settings` holding the mode staff set.
const REGISTRATION_KEY: &str = "registration_mode";

/// Who answered a request by inviting its address: `@username`, else the
/// staff member, else g1t.
pub fn invited_by(inviter: Option<&str>, staff: Option<&str>) -> String {
    match (inviter, staff) {
        (Some(inviter), _) => format!("@{inviter}"),
        (None, Some(staff)) => staff.to_owned(),
        (None, None) => "g1t".to_owned(),
    }
}

/// Whether staff may be sent a summary of new requests: none was sent yet,
/// or the last went before `since` (15 minutes ago). RFC 3339 times.
pub fn summary_due(last: Option<&str>, since: &str) -> bool {
    last.is_none_or(|last| last <= since)
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

// Joined as: the account the request's own invite made, else whichever
// account has the address (one that came in by another invite).
const COLUMNS: &str = "wl.id, wl.email, wl.about, wl.status, wl.invite_id, wl.decided_by, wl.decided_at, wl.note,
  COALESCE(ju.username, (SELECT eu.username FROM users eu WHERE eu.email = wl.email LIMIT 1)) AS joined_as,
  wl.created_at, wl.updated_at
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

impl Identity {
    /// What `REGISTRATION_MODE` says: the mode until staff set one.
    fn default_registration_mode(&self) -> RegistrationMode {
        RegistrationMode::parse(self.env.var("REGISTRATION_MODE").ok().map(|v| v.to_string()).as_deref())
    }

    pub async fn admin_registration(&self) -> Result<RegistrationSetting> {
        #[derive(Deserialize)]
        struct Row {
            value: String,
            set_by: String,
            set_at: String,
        }
        let row = self
            .db
            .prepare("SELECT value, set_by, set_at FROM identity_settings WHERE key = ?")
            .bind(&[REGISTRATION_KEY.into()])?
            .first::<Row>(None)
            .await?;
        let default_mode = self.default_registration_mode();
        Ok(match row {
            Some(row) => RegistrationSetting {
                mode: RegistrationMode::parse(Some(&row.value)),
                default_mode,
                set_by: Some(row.set_by),
                set_at: Some(row.set_at),
            },
            None => RegistrationSetting { mode: default_mode, default_mode, set_by: None, set_at: None },
        })
    }

    pub async fn registration_mode(&self) -> Result<RegistrationMode> {
        Ok(self.admin_registration().await?.mode)
    }

    /// Whether a new account needs an invite for its address.
    pub async fn invites_required(&self) -> Result<bool> {
        Ok(self.registration_mode().await? == RegistrationMode::Invite)
    }

    pub async fn admin_set_registration(&self, a: AdminSetRegistrationArgs) -> Result<RegistrationSetting> {
        let staff = a.staff.trim();
        let value = match a.mode {
            RegistrationMode::Open => "open",
            RegistrationMode::Invite => "invite",
        };
        let before = self.registration_mode().await?;
        self.db
            .prepare(
                "INSERT INTO identity_settings (key, value, set_by, set_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at",
            )
            .bind(&[REGISTRATION_KEY.into(), value.into(), staff.into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        if before != a.mode {
            let detail = match a.mode {
                RegistrationMode::Open => "Opened sign-up to everyone",
                RegistrationMode::Invite => "Closed sign-up to invites only (private preview)",
            };
            // Filed under g1t's own workspace: the change is to g1t, not to a customer.
            self.record_for_staff("flagon-io", "registration_changed", detail, staff).await;
        }
        self.admin_registration().await
    }

    pub async fn request_access(&self, a: RequestAccessArgs) -> Result<Outcome<bool>> {
        let Some(email) = normalize_email(&a.email) else {
            return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL));
        };
        let allowed = match a.client.as_deref().map(str::trim).filter(|client| !client.is_empty()) {
            Some(client) => self.hit(&format!("waitlist:{}", crypto::sha256_hex(client)), REQUESTS_PER_HOUR).await?,
            None => self.hit("waitlist:anonymous", ANONYMOUS_REQUESTS_PER_HOUR).await?,
        };
        if !allowed {
            return Ok(Outcome::fail(FailureCode::Limit, TOO_MANY));
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
        // Only a first request is confirmed and told to staff; asking again
        // updates what they said, which staff see in sudo. Someone already
        // in, or already invited, waits for nothing.
        if let Some(row) = row.filter(|row| row.created_at == now) {
            if self.already_answered(&email).await? {
                return Ok(Outcome::Ok(true));
            }
            self.acknowledge_request(&row.id, &email).await?;
            self.notify_staff_of_requests().await?;
        }
        Ok(Outcome::Ok(true))
    }

    /// Marks a waiting request for `email` invited, by `by` (`@friend`, or
    /// a staff member), with the invite that answered it if there is one.
    /// Nothing for an address that is not waiting.
    pub(crate) async fn settle_waitlist(&self, email: &str, invite_id: Option<&str>, by: &str) -> Result<()> {
        self.db
            .prepare(format!(
                "UPDATE waitlist SET status = 'invited', invite_id = COALESCE(?, invite_id), decided_by = ?,
                   decided_at = {SQL_NOW}, notified_at = COALESCE(notified_at, {SQL_NOW})
                 WHERE email = ? AND status = 'waiting'"
            ))
            .bind(&[invite_id.map_or(JsValue::NULL, JsValue::from), by.into(), email.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Whether `email` needs nothing from the waitlist: it has an account,
    /// or a pending invite to make one. If so, its request is marked so.
    async fn already_answered(&self, email: &str) -> Result<bool> {
        if let Some(username) = self.username_with_email(email).await? {
            self.settle_waitlist(email, None, &format!("@{username} (has an account)")).await?;
            return Ok(true);
        }
        #[derive(Deserialize)]
        struct Pending {
            id: String,
            inviter: Option<String>,
            staff: Option<String>,
        }
        let pending = self
            .db
            .prepare(format!(
                "SELECT i.id, iu.username AS inviter, i.staff FROM invites i LEFT JOIN users iu ON iu.id = i.inviter_id
                 WHERE i.email = ? AND i.kind = 'account' AND i.redeemed_at IS NULL AND i.revoked_at IS NULL
                   AND i.expires_at > {SQL_NOW}
                 ORDER BY i.created_at DESC LIMIT 1"
            ))
            .bind(&[email.into()])?
            .first::<Pending>(None)
            .await?;
        let Some(pending) = pending else {
            return Ok(false);
        };
        let by = invited_by(pending.inviter.as_deref(), pending.staff.as_deref());
        self.settle_waitlist(email, Some(&pending.id), &by).await?;
        Ok(true)
    }

    /// An account's address, as it signed up with it.
    pub(crate) async fn email_of(&self, user_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Email {
            email: String,
        }
        Ok(self
            .db
            .prepare("SELECT email FROM users WHERE id = ?")
            .bind(&[user_id.into()])?
            .first::<Email>(None)
            .await?
            .map(|row| row.email))
    }

    async fn username_with_email(&self, email: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Name {
            username: String,
        }
        Ok(self
            .db
            .prepare("SELECT username FROM users WHERE email = ? LIMIT 1")
            .bind(&[email.into()])?
            .first::<Name>(None)
            .await?
            .map(|name| name.username))
    }

    /// The one confirmation an address gets for asking: claimed in the
    /// database first, so a repeat request (or two at once) never sends a
    /// second.
    async fn acknowledge_request(&self, id: &str, email: &str) -> Result<()> {
        if !self.hit("waitlist.ack", CONFIRMATIONS_PER_HOUR).await? {
            return Ok(());
        }
        let claimed = self
            .db
            .prepare(format!("UPDATE waitlist SET acknowledged_at = {SQL_NOW} WHERE id = ? AND acknowledged_at IS NULL RETURNING id"))
            .bind(&[id.into()])?
            .first::<Id>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        if let Err(error) = crate::email::send_waitlist_confirmation(&self.env, email).await {
            worker::console_error!("waitlist confirmation failed: {error}");
            // Not sent: leave it unclaimed, so staff can see it was not.
            self.db.prepare("UPDATE waitlist SET acknowledged_at = NULL WHERE id = ?").bind(&[id.into()])?.run().await?;
        }
        Ok(())
    }

    /// Where staff hear about new requests: WAITLIST_NOTIFY_EMAIL, unset or
    /// empty for nobody.
    fn waitlist_notify_email(&self) -> Option<String> {
        let to = self.env.var("WAITLIST_NOTIFY_EMAIL").ok()?.to_string();
        normalize_email(&to)
    }

    /// Tells staff about every waiting request they have not heard about,
    /// unless a summary went in the last 15 minutes. The rows are claimed
    /// before sending, so two requests at once send one summary.
    pub(crate) async fn notify_staff_of_requests(&self) -> Result<()> {
        let Some(to) = self.waitlist_notify_email() else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Last {
            at: Option<String>,
        }
        let last = self.db.prepare("SELECT max(notified_at) AS at FROM waitlist").first::<Last>(None).await?.and_then(|last| last.at);
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
        let waiting = self.admin_waitlist_pending().await?;
        let new: Vec<crate::email::Requested> =
            new.into_iter().map(|row| crate::email::Requested { email: row.email, about: row.about }).collect();
        if let Err(error) = crate::email::send_waitlist_summary(&self.env, &to, &new, waiting).await {
            worker::console_error!("waitlist summary failed: {error}");
            // Not sent: the next request, or the sweep, tries again.
            self.db.prepare("UPDATE waitlist SET notified_at = NULL WHERE notified_at = ?").bind(&[stamp.as_str().into()])?.run().await?;
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
        // Waiting is a queue, taken from the front; the rest is history.
        let order = if a.status == Some(WaitlistStatus::Waiting) { "ASC" } else { "DESC" };
        Ok(self
            .db
            .prepare(format!("SELECT {COLUMNS} {filter} ORDER BY wl.created_at {order}, wl.id {order} LIMIT {ADMIN_INVITES_LIMIT}"))
            .bind(&binds)?
            .all()
            .await?
            .results::<WaitlistRow>()?
            .into_iter()
            .map(WaitlistEntry::from)
            .collect())
    }

    async fn waitlist_entry(&self, id: &str) -> Result<Option<WaitlistRow>> {
        self.db.prepare(format!("SELECT {COLUMNS} WHERE wl.id = ?")).bind(&[id.into()])?.first::<WaitlistRow>(None).await
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
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_ON_IT));
        };
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member decided."));
        }
        let note: String = a.note.as_deref().unwrap_or_default().trim().chars().take(MAX_WAITLIST_NOTE).collect();
        let note = (!note.is_empty()).then_some(note);
        // Claimed first, so two staff deciding at once cannot both send an
        // invite; an approval that then fails puts it back.
        let claimed = self
            .db
            .prepare(format!(
                "UPDATE waitlist SET status = ?, decided_by = ?, decided_at = {SQL_NOW}, note = ?,
                   notified_at = COALESCE(notified_at, {SQL_NOW})
                 WHERE id = ? AND status = 'waiting' RETURNING id"
            ))
            .bind(&[
                if a.approve { "invited" } else { "dismissed" }.into(),
                staff.into(),
                note.as_deref().map_or(JsValue::NULL, JsValue::from),
                entry.id.as_str().into(),
            ])?
            .first::<Id>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} was already {} by {}.", entry.email, entry.status, entry.decided_by.as_deref().unwrap_or("staff")),
            ));
        }
        if a.approve {
            let refused = if self.email_has_account(&entry.email).await? {
                Some("That address already has a g1t account.")
            } else {
                match self.invite_from_staff(&entry.email, staff, note.as_deref()).await? {
                    Some(invite_id) => {
                        self.db
                            .prepare("UPDATE waitlist SET invite_id = ? WHERE id = ?")
                            .bind(&[invite_id.as_str().into(), entry.id.as_str().into()])?
                            .run()
                            .await?;
                        None
                    }
                    None => Some("The invite could not be made. Try again."),
                }
            };
            if let Some(message) = refused {
                self.db
                    .prepare("UPDATE waitlist SET status = 'waiting', decided_by = NULL, decided_at = NULL, note = NULL WHERE id = ?")
                    .bind(&[entry.id.as_str().into()])?
                    .run()
                    .await?;
                return Ok(Outcome::fail(FailureCode::Conflict, message));
            }
        }
        Ok(match self.waitlist_entry(&entry.id).await? {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, NOT_ON_IT),
        })
    }

    /// An invite to g1t from staff, bound to `email`, charged to nobody, and
    /// emailed with `note`. Its id, or None if it could not be stored.
    async fn invite_from_staff(&self, email: &str, staff: &str, note: Option<&str>) -> Result<Option<String>> {
        let Some(invite) = self
            .insert_invite(Draft {
                email: Some(email),
                kind: "account",
                workspace_id: None,
                inviter: None,
                staff: Some(staff),
                invitee_id: None,
                role: None,
                charged_to: "none",
                limit: None,
            })
            .await?
        else {
            return Ok(None);
        };
        if let Some(code) = &invite.code {
            self.send_invite_email(email, None, None, false, code, &invite.id, note).await;
        }
        Ok(Some(invite.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_summary_waits_fifteen_minutes_after_the_last() {
        let since = "2026-10-24T11:45:00.000Z";
        assert!(summary_due(None, since));
        assert!(summary_due(Some("2026-10-24T11:30:00.000Z"), since));
        assert!(summary_due(Some(since), since));
        assert!(!summary_due(Some("2026-10-24T11:50:00.000Z"), since));
    }

    #[test]
    fn a_request_answered_by_an_invite_names_who_sent_it() {
        assert_eq!(invited_by(Some("ada"), None), "@ada");
        assert_eq!(invited_by(Some("ada"), Some("staff@g1t.sh")), "@ada");
        assert_eq!(invited_by(None, Some("staff@g1t.sh")), "staff@g1t.sh");
        assert_eq!(invited_by(None, None), "g1t");
    }

    #[test]
    fn only_invite_closes_registration() {
        assert_eq!(RegistrationMode::parse(None), RegistrationMode::Open);
        assert_eq!(RegistrationMode::parse(Some("")), RegistrationMode::Open);
        assert_eq!(RegistrationMode::parse(Some("open")), RegistrationMode::Open);
        assert_eq!(RegistrationMode::parse(Some(" Invite ")), RegistrationMode::Invite);
    }
}
