//! Shared invite links: one link staff hand to a group (a conference's
//! judges, a post, a community), made in sudo.
//!
//! A shared link makes up to `max_uses` new accounts until it expires or
//! staff revoke it, optionally only for addresses at some email domains.
//! Each use makes a new account, which then makes its own workspace: a
//! shared link never joins anyone to an existing workspace, and uses
//! nobody's allowance. Its code is an ordinary invite code (`g1t-` and
//! eight groups), stored the same way: only its SHA-256, and a copy sealed
//! under IDENTITY_KEY so staff can copy the link again while it is live.
//!
//! Using one goes through [`Identity::create_account`] like any invite
//! (invites.rs): the same per-client failure throttle, the same one answer
//! for a code that is unknown, expired, revoked or used up, and a use
//! taken in the same transaction that makes the account. The statement
//! that takes a use counts the uses taken and adds one only while fewer
//! than `max_uses` are, and the account is made only if that row was
//! added, so people racing for the last use cannot both get one.
//!
//! Each use is a row in `shared_invite_uses`, which also says where the
//! account came from: sudo shows "Joined through <label>".

use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::invites::{Refusal, code_hash, code_hint, format_code, new_code_body, normalize_code};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// What sudo's audit log files shared links under: `invites` is a reserved
/// name, so no workspace has it.
pub const AUDIT_ACCOUNT: &str = "invites";

/// What someone whose address is at another domain is told. The domains
/// are no secret to whoever holds the link: the sign-up page lists them.
pub fn wrong_domain(domains: &[String]) -> String {
    let list = match domains {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    };
    format!("This invite is only for email addresses at {list}. Sign up with your address there.")
}

// --- Rules --------------------------------------------------------------------

/// Where a shared link stands at `now`. Revoked first, then used up, then
/// expired: what staff did, before what time did.
pub fn shared_status(
    revoked: bool,
    expires_at: &str,
    uses: u32,
    max_uses: u32,
    now: &str,
) -> SharedInviteStatus {
    if revoked {
        SharedInviteStatus::Revoked
    } else if uses >= max_uses {
        SharedInviteStatus::UsedUp
    } else if expires_at <= now {
        SharedInviteStatus::Expired
    } else {
        SharedInviteStatus::Live
    }
}

/// Whether `email` is at one of `domains`: the part after the last `@`,
/// exactly (a subdomain is another domain). Any address when `domains` is
/// empty.
pub fn domain_allowed(domains: &[String], email: &str) -> bool {
    if domains.is_empty() {
        return true;
    }
    let Some((_, domain)) = email.trim().rsplit_once('@') else {
        return false;
    };
    domains
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(domain))
}

/// The parts of a shared link that decide whether it makes an account.
#[derive(Debug)]
pub struct SharedAdmits<'a> {
    pub status: SharedInviteStatus,
    pub domains: &'a [String],
}

/// Whether a shared link makes an account for `email`. Anything but a
/// live link is [`Refusal::Invalid`], the one answer every unusable code
/// gets, so nobody learns whether a link was used up, revoked or expired.
pub fn shared_admits(link: Option<&SharedAdmits>, email: &str) -> std::result::Result<(), Refusal> {
    match link {
        Some(link) if link.status == SharedInviteStatus::Live => {
            if domain_allowed(link.domains, email) {
                Ok(())
            } else {
                Err(Refusal::WrongDomain)
            }
        }
        _ => Err(Refusal::Invalid),
    }
}

/// One email domain as staff typed it (`@Cloudflare.com ` reads as
/// `cloudflare.com`), if it is one.
pub fn normalize_domain(input: &str) -> Option<String> {
    let domain = input
        .trim()
        .trim_start_matches('@')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let well_formed = (3..=253).contains(&domain.len())
        && domain.contains('.')
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    well_formed.then_some(domain)
}

/// What staff asked for, checked: what a shared link is made from.
#[derive(Debug, PartialEq, Eq)]
pub struct SharedDraft {
    pub label: String,
    pub max_uses: u32,
    /// RFC 3339.
    pub expires_at: String,
    pub domains: Vec<String>,
}

/// The end of `YYYY-MM-DD` (UTC), in g1t's format, if it is a real day.
fn end_of_day(date: &str) -> Option<String> {
    let date = date.trim();
    if date.len() != 10 {
        return None;
    }
    let end = format!("{date}T23:59:59.999Z");
    // Round-trips only for a day that exists: not 2026-02-30.
    let ms = parse_rfc3339(&end)?;
    (rfc3339(ms) == end).then_some(end)
}

/// Checks what staff asked for at `now_ms`: a label, 1 to 1000 uses, an
/// expiry from today to a year ahead (14 days when none is given), and up
/// to 10 domains. Every problem is said the way sudo shows it.
pub fn check_draft(
    label: &str,
    max_uses: u32,
    expires_on: Option<&str>,
    domains: &[String],
    now_ms: u64,
) -> std::result::Result<SharedDraft, String> {
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        return Err("Give the link a label, such as Cloudflare judges.".to_owned());
    }
    if label.chars().count() > MAX_SHARED_INVITE_LABEL {
        return Err(format!(
            "Keep the label to {MAX_SHARED_INVITE_LABEL} characters."
        ));
    }
    if !(1..=MAX_SHARED_INVITE_USES).contains(&max_uses) {
        return Err(format!(
            "A shared link makes between 1 and {MAX_SHARED_INVITE_USES} accounts."
        ));
    }
    let now = rfc3339(now_ms);
    let expires_at = match expires_on.map(str::trim).filter(|date| !date.is_empty()) {
        None => rfc3339(now_ms + SHARED_INVITE_TTL_DAYS * DAY_MS),
        Some(date) => {
            let Some(end) = end_of_day(date) else {
                return Err("Give the expiry as a date, such as 2026-10-28.".to_owned());
            };
            if end <= now {
                return Err("The expiry has passed. Choose today or a later day.".to_owned());
            }
            // The last day allowed is a year from today.
            if end[..10] > rfc3339(now_ms + SHARED_INVITE_MAX_DAYS * DAY_MS)[..10] {
                return Err(format!(
                    "A shared link works for at most {SHARED_INVITE_MAX_DAYS} days."
                ));
            }
            end
        }
    };
    let mut checked: Vec<String> = Vec::new();
    for domain in domains
        .iter()
        .flat_map(|entry| entry.split([',', ' ', '\n', '\r', '\t']))
    {
        if domain.trim().is_empty() {
            continue;
        }
        let Some(domain) = normalize_domain(domain) else {
            return Err(format!(
                "{} is not an email domain. Write domains such as cloudflare.com.",
                domain.trim()
            ));
        };
        if !checked.contains(&domain) {
            checked.push(domain);
        }
    }
    if checked.len() > MAX_SHARED_INVITE_DOMAINS {
        return Err(format!(
            "Limit a link to at most {MAX_SHARED_INVITE_DOMAINS} domains."
        ));
    }
    Ok(SharedDraft {
        label,
        max_uses,
        expires_at,
        domains: checked,
    })
}

/// The domains column as a list.
pub fn domains_of(column: Option<&str>) -> Vec<String> {
    column
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|domain| !domain.is_empty())
        .map(str::to_owned)
        .collect()
}

// --- Taking a use -------------------------------------------------------------

/// Takes one use of shared link `?2` for new account `?1`: adds the row
/// only while the link is not revoked, not expired, and has fewer uses
/// than `max_uses`, counted in this same statement. Runs in one batch
/// (a transaction) with [`make_account_sql`], so either both happen or
/// neither does.
pub fn take_use_sql() -> String {
    format!(
        "INSERT INTO shared_invite_uses (user_id, shared_invite_id, created_at)
         SELECT ?1, s.id, {SQL_NOW} FROM shared_invites s
         WHERE s.id = ?2 AND s.revoked_at IS NULL AND s.expires_at > {SQL_NOW}
           AND (SELECT count(*) FROM shared_invite_uses u WHERE u.shared_invite_id = s.id) < s.max_uses"
    )
}

/// Makes the account (`?1` to `?4`: id, username, email, password hash)
/// only if [`take_use_sql`] took a use of link `?5` for it.
pub fn make_account_sql(verified_at: &str) -> String {
    format!(
        "INSERT INTO users (id, username, email, password_hash, email_verified_at)
         SELECT ?1, ?2, ?3, ?4, {verified_at}
         WHERE EXISTS (SELECT 1 FROM shared_invite_uses WHERE user_id = ?1 AND shared_invite_id = ?5)"
    )
}

/// Forgets the sealed code of link `?1` once its last use is taken: there
/// is nothing left to copy.
pub fn seal_used_up_sql() -> &'static str {
    "UPDATE shared_invites SET sealed_code = NULL
     WHERE id = ?1 AND (SELECT count(*) FROM shared_invite_uses u WHERE u.shared_invite_id = ?1) >= max_uses"
}

/// Revokes link `?2` for staff member `?1`, once: its sealed code goes
/// with it, and the accounts it made stay.
pub fn revoke_sql() -> String {
    format!(
        "UPDATE shared_invites SET revoked_at = {SQL_NOW}, revoked_by = ?1, sealed_code = NULL
         WHERE id = ?2 AND revoked_at IS NULL RETURNING id"
    )
}

// --- Rows ---------------------------------------------------------------------

const COLUMNS: &str = "s.id, s.label, s.hint, s.sealed_code, s.max_uses, s.domains, s.staff, s.created_at, s.expires_at,
  s.revoked_at, s.revoked_by,
  (SELECT count(*) FROM shared_invite_uses u WHERE u.shared_invite_id = s.id) AS uses
  FROM shared_invites s";

/// The most shared links sudo lists.
const LIST_LIMIT: usize = 200;

#[derive(Debug, Deserialize)]
pub struct SharedRow {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub sealed_code: Option<String>,
    pub max_uses: f64,
    pub domains: Option<String>,
    pub staff: String,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub revoked_by: Option<String>,
    pub uses: f64,
}

impl SharedRow {
    pub fn status(&self, now: &str) -> SharedInviteStatus {
        shared_status(
            self.revoked_at.is_some(),
            &self.expires_at,
            self.uses as u32,
            self.max_uses as u32,
            now,
        )
    }

    pub fn domains(&self) -> Vec<String> {
        domains_of(self.domains.as_deref())
    }
}

impl Identity {
    pub(crate) async fn shared_by_code(&self, code: &str) -> Result<Option<SharedRow>> {
        let Some(body) = normalize_code(code) else {
            return Ok(None);
        };
        self.db
            .prepare(format!("SELECT {COLUMNS} WHERE s.code_hash = ?"))
            .bind(&[code_hash(&body).into()])?
            .first::<SharedRow>(None)
            .await
    }

    async fn shared_by_id(&self, id: &str) -> Result<Option<SharedRow>> {
        self.db
            .prepare(format!("SELECT {COLUMNS} WHERE s.id = ?"))
            .bind(&[id.into()])?
            .first::<SharedRow>(None)
            .await
    }

    /// The statements that take a use of `link` and make the account, for
    /// create_account's batch: the account row comes to exist only if the
    /// use was taken for it.
    pub(crate) fn shared_account_statements(
        &self,
        link: &SharedRow,
        values: &[JsValue; 4],
        verified_at: &str,
    ) -> Result<Vec<worker::D1PreparedStatement>> {
        let user_id = values[0].clone();
        let mut make = values.to_vec();
        make.push(link.id.as_str().into());
        Ok(vec![
            self.db
                .prepare(take_use_sql())
                .bind(&[user_id, link.id.as_str().into()])?,
            self.db.prepare(make_account_sql(verified_at)).bind(&make)?,
            self.db
                .prepare(seal_used_up_sql())
                .bind(&[link.id.as_str().into()])?,
        ])
    }

    /// What the sign-up page shows for a live shared link's code.
    pub(crate) fn shared_preview(&self, link: &SharedRow) -> InvitePreview {
        InvitePreview {
            kind: InviteKind::Account,
            status: InviteStatus::Pending,
            invited_by: None,
            workspace: None,
            repository: None,
            email: None,
            address: None,
            has_account: false,
            for_viewer: None,
            expires_at: link.expires_at.clone(),
            shared_label: Some(link.label.clone()),
            shared_domains: link.domains(),
        }
    }

    /// The shared link an account was made with, if it was.
    pub(crate) async fn shared_source(&self, user_id: &str) -> Result<Option<SharedInviteSource>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            label: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT s.id, s.label FROM shared_invite_uses u JOIN shared_invites s ON s.id = u.shared_invite_id
                 WHERE u.user_id = ?",
            )
            .bind(&[user_id.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| SharedInviteSource { id: row.id, label: row.label }))
    }

    /// A shared link as staff see it, with its code while it is live.
    fn shown_shared(&self, row: SharedRow, accounts: Vec<SharedInviteAccount>) -> SharedInvite {
        let status = row.status(&rfc3339(now_ms()));
        let code = if status == SharedInviteStatus::Live {
            row.sealed_code
                .as_deref()
                .and_then(|sealed| self.invite_sealer()?.open(sealed, &row.id))
        } else {
            None
        };
        let domains = row.domains();
        SharedInvite {
            id: row.id,
            label: row.label,
            code,
            hint: row.hint,
            max_uses: row.max_uses as u32,
            uses: row.uses as u32,
            domains,
            status,
            staff: row.staff,
            created_at: row.created_at,
            expires_at: row.expires_at,
            revoked_at: row.revoked_at,
            revoked_by: row.revoked_by,
            accounts,
        }
    }

    /// The accounts each of `ids` made, oldest first.
    async fn shared_accounts(&self, ids: &[String]) -> Result<Vec<(String, SharedInviteAccount)>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Deserialize)]
        struct Row {
            shared_invite_id: String,
            username: Option<String>,
            created_at: String,
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let binds: Vec<JsValue> = ids.iter().map(|id| JsValue::from(id.as_str())).collect();
        Ok(self
            .db
            .prepare(format!(
                "SELECT u.shared_invite_id, us.username, u.created_at FROM shared_invite_uses u
                 LEFT JOIN users us ON us.id = u.user_id
                 WHERE u.shared_invite_id IN ({marks}) ORDER BY u.created_at, u.user_id"
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| {
                (
                    row.shared_invite_id,
                    SharedInviteAccount {
                        username: row.username,
                        joined_at: row.created_at,
                    },
                )
            })
            .collect())
    }

    /// `admin_shared_invites`.
    pub async fn admin_shared_invites(&self) -> Result<Vec<SharedInvite>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT {COLUMNS} ORDER BY s.created_at DESC, s.id DESC LIMIT {LIST_LIMIT}"
            ))
            .all()
            .await?
            .results::<SharedRow>()?;
        let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        let mut accounts = self.shared_accounts(&ids).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let (mine, rest): (Vec<_>, Vec<_>) =
                    accounts.drain(..).partition(|(id, _)| *id == row.id);
                accounts = rest;
                let mine = mine.into_iter().map(|(_, account)| account).collect();
                self.shown_shared(row, mine)
            })
            .collect())
    }

    /// `admin_create_shared_invite`.
    pub async fn admin_create_shared_invite(
        &self,
        a: AdminCreateSharedInviteArgs,
    ) -> Result<Outcome<SharedInvite>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Say which staff member is making it.",
            ));
        }
        let now = now_ms();
        let draft = match check_draft(
            &a.label,
            a.max_uses,
            a.expires_on.as_deref(),
            &a.domains,
            now,
        ) {
            Ok(draft) => draft,
            Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
        };
        let body = new_code_body();
        let code = format_code(&body);
        let id = new_id("sinv", now);
        let sealed = self.invite_sealer().map(|sealer| sealer.seal(&code, &id));
        let domains = draft.domains.join(",");
        self.db
            .prepare(
                "INSERT INTO shared_invites (id, label, code_hash, hint, sealed_code, max_uses, domains, staff, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                draft.label.as_str().into(),
                code_hash(&body).into(),
                code_hint(&body).into(),
                sealed.as_deref().map_or(JsValue::NULL, JsValue::from),
                f64::from(draft.max_uses).into(),
                if domains.is_empty() { JsValue::NULL } else { domains.as_str().into() },
                staff.into(),
                rfc3339(now).into(),
                draft.expires_at.as_str().into(),
            ])?
            .run()
            .await?;
        let only = if draft.domains.is_empty() {
            String::new()
        } else {
            format!(", only {}", draft.domains.join(", "))
        };
        self.record_for_staff(
            AUDIT_ACCOUNT,
            "shared_invite_created",
            &format!(
                "Shared invite link {} ({}) for {}: up to {} accounts until {}{only}",
                code_hint(&body),
                id,
                draft.label,
                draft.max_uses,
                &draft.expires_at[..10]
            ),
            staff,
        )
        .await;
        let Some(row) = self.shared_by_id(&id).await? else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "The link could not be made. Try again.",
            ));
        };
        let mut shown = self.shown_shared(row, Vec::new());
        shown.code = Some(code);
        Ok(Outcome::Ok(shown))
    }

    /// `admin_revoke_shared_invite`.
    pub async fn admin_revoke_shared_invite(
        &self,
        a: AdminRevokeSharedInviteArgs,
    ) -> Result<Outcome<SharedInvite>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Say which staff member is revoking it.",
            ));
        }
        let revoked = self
            .db
            .prepare(revoke_sql())
            .bind(&[staff.into(), a.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if revoked.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That link is revoked already, or there is no such link.",
            ));
        }
        let Some(row) = self.shared_by_id(&a.id).await? else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "Shared invite link not found.",
            ));
        };
        self.record_for_staff(
            AUDIT_ACCOUNT,
            "shared_invite_revoked",
            &format!(
                "Revoked shared invite link {} ({}) for {} after {} of {} uses",
                row.hint, row.id, row.label, row.uses as u32, row.max_uses as u32
            ),
            staff,
        )
        .await;
        let accounts = self
            .shared_accounts(std::slice::from_ref(&row.id))
            .await?
            .into_iter()
            .map(|(_, account)| account)
            .collect();
        Ok(Outcome::Ok(self.shown_shared(row, accounts)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-08T12:00:00.000Z";
    const LATER: &str = "2026-10-22T12:00:00.000Z";
    const EARLIER: &str = "2026-10-01T12:00:00.000Z";
    /// 2026-10-08T12:00:00.000Z.
    const NOW_MS: u64 = 1_791_460_800_000;

    #[test]
    fn the_test_clock_is_what_it_says() {
        assert_eq!(rfc3339(NOW_MS), NOW);
    }

    #[test]
    fn a_link_is_live_until_revoked_used_up_or_expired() {
        assert_eq!(
            shared_status(false, LATER, 0, 10, NOW),
            SharedInviteStatus::Live
        );
        assert_eq!(
            shared_status(false, LATER, 9, 10, NOW),
            SharedInviteStatus::Live
        );
        assert_eq!(
            shared_status(false, LATER, 10, 10, NOW),
            SharedInviteStatus::UsedUp
        );
        assert_eq!(
            shared_status(false, EARLIER, 3, 10, NOW),
            SharedInviteStatus::Expired
        );
        // It stops at its expiry, not a moment after.
        assert_eq!(
            shared_status(false, NOW, 3, 10, NOW),
            SharedInviteStatus::Expired
        );
        assert_eq!(
            shared_status(true, LATER, 3, 10, NOW),
            SharedInviteStatus::Revoked
        );
        // What staff did comes before what time did.
        assert_eq!(
            shared_status(true, EARLIER, 10, 10, NOW),
            SharedInviteStatus::Revoked
        );
        assert_eq!(
            shared_status(false, EARLIER, 10, 10, NOW),
            SharedInviteStatus::UsedUp
        );
    }

    #[test]
    fn expired_revoked_and_used_up_links_all_get_the_one_answer() {
        let none: [String; 0] = [];
        for status in [
            SharedInviteStatus::UsedUp,
            SharedInviteStatus::Expired,
            SharedInviteStatus::Revoked,
        ] {
            let link = SharedAdmits {
                status,
                domains: &none,
            };
            assert_eq!(
                shared_admits(Some(&link), "ada@example.com"),
                Err(Refusal::Invalid),
                "{status:?}"
            );
            // Even at another domain: a dead link says nothing about whom it was for.
            let domains = ["cloudflare.com".to_owned()];
            let bound = SharedAdmits {
                status,
                domains: &domains,
            };
            assert_eq!(
                shared_admits(Some(&bound), "eve@example.com"),
                Err(Refusal::Invalid)
            );
        }
        assert_eq!(
            shared_admits(None, "ada@example.com"),
            Err(Refusal::Invalid)
        );
        let live = SharedAdmits {
            status: SharedInviteStatus::Live,
            domains: &none,
        };
        assert_eq!(shared_admits(Some(&live), "anyone@anywhere.dev"), Ok(()));
    }

    #[test]
    fn a_link_limited_to_domains_admits_only_addresses_there() {
        let domains = ["cloudflare.com".to_owned(), "flagon.io".to_owned()];
        let live = SharedAdmits {
            status: SharedInviteStatus::Live,
            domains: &domains,
        };
        assert_eq!(shared_admits(Some(&live), "judge@cloudflare.com"), Ok(()));
        assert_eq!(shared_admits(Some(&live), " Judge@CloudFlare.COM "), Ok(()));
        assert_eq!(shared_admits(Some(&live), "chase@flagon.io"), Ok(()));
        assert_eq!(
            shared_admits(Some(&live), "eve@example.com"),
            Err(Refusal::WrongDomain)
        );
        // A subdomain, or a domain that only ends the same, is another domain.
        assert_eq!(
            shared_admits(Some(&live), "a@eu.cloudflare.com"),
            Err(Refusal::WrongDomain)
        );
        assert_eq!(
            shared_admits(Some(&live), "a@notcloudflare.com"),
            Err(Refusal::WrongDomain)
        );
        // The last @ decides.
        assert_eq!(
            shared_admits(Some(&live), "\"a@cloudflare.com\"@evil.com"),
            Err(Refusal::WrongDomain)
        );
        assert_eq!(
            shared_admits(Some(&live), "no-at-sign"),
            Err(Refusal::WrongDomain)
        );
        assert_eq!(
            wrong_domain(&domains),
            "This invite is only for email addresses at cloudflare.com or flagon.io. Sign up with your address there."
        );
        assert!(
            wrong_domain(&["a.com".into(), "b.com".into(), "c.com".into()])
                .contains("a.com, b.com or c.com")
        );
    }

    #[test]
    fn a_use_is_taken_only_under_max_uses_in_the_statement_that_takes_it() {
        let take = take_use_sql();
        // The count, the cap, revocation and expiry are all checked in the
        // insert itself: no read-then-write gap for a race to slip into.
        assert!(take.starts_with("INSERT INTO shared_invite_uses"));
        assert!(take.contains("(SELECT count(*) FROM shared_invite_uses u WHERE u.shared_invite_id = s.id) < s.max_uses"));
        assert!(take.contains("s.revoked_at IS NULL"));
        assert!(take.contains(&format!("s.expires_at > {SQL_NOW}")));
        assert!(!take.contains("VALUES"));
        // The account is made only if this sign-up took the use.
        let make = make_account_sql("NULL");
        assert!(make.starts_with("INSERT INTO users"));
        assert!(make.contains("WHERE EXISTS (SELECT 1 FROM shared_invite_uses WHERE user_id = ?1 AND shared_invite_id = ?5)"));
        assert!(make.contains("SELECT ?1, ?2, ?3, ?4, NULL"));
        // The sealed code goes once the last use does.
        assert!(seal_used_up_sql().contains(">= max_uses"));
    }

    /// The take-a-use statement's rule, applied to sign-ups one after
    /// another as D1 runs them (one writer; each batch a transaction).
    fn race(max_uses: u32, signups: u32, revoked: bool, expires_at: &str) -> u32 {
        let mut uses = 0;
        for _ in 0..signups {
            if shared_status(revoked, expires_at, uses, max_uses, NOW) == SharedInviteStatus::Live {
                uses += 1;
            }
        }
        uses
    }

    #[test]
    fn however_many_race_for_it_a_link_never_passes_max_uses() {
        assert_eq!(race(1, 50, false, LATER), 1);
        assert_eq!(race(25, 1000, false, LATER), 25);
        assert_eq!(race(1000, 999, false, LATER), 999);
        assert_eq!(race(10, 10, true, LATER), 0);
        assert_eq!(race(10, 10, false, EARLIER), 0);
    }

    fn draft(
        label: &str,
        max_uses: u32,
        expires_on: Option<&str>,
        domains: &[&str],
    ) -> std::result::Result<SharedDraft, String> {
        let domains: Vec<String> = domains.iter().map(|d| (*d).to_owned()).collect();
        check_draft(label, max_uses, expires_on, &domains, NOW_MS)
    }

    #[test]
    fn a_link_needs_a_label_and_one_to_a_thousand_uses() {
        let made = draft("  Cloudflare   judges ", 40, None, &[]).unwrap();
        assert_eq!(made.label, "Cloudflare judges");
        assert_eq!(made.max_uses, 40);
        assert!(made.domains.is_empty());
        assert!(draft("", 10, None, &[]).unwrap_err().contains("label"));
        assert!(draft("   ", 10, None, &[]).unwrap_err().contains("label"));
        assert!(draft(&"x".repeat(MAX_SHARED_INVITE_LABEL + 1), 10, None, &[]).is_err());
        assert!(draft(&"x".repeat(MAX_SHARED_INVITE_LABEL), 10, None, &[]).is_ok());
        assert!(
            draft("Judges", 0, None, &[])
                .unwrap_err()
                .contains("between 1 and 1000")
        );
        assert!(draft("Judges", 1001, None, &[]).is_err());
        assert!(draft("Judges", 1, None, &[]).is_ok());
        assert!(draft("Judges", 1000, None, &[]).is_ok());
    }

    #[test]
    fn a_link_expires_in_14_days_unless_given_a_day_within_a_year() {
        assert_eq!(
            draft("Judges", 10, None, &[]).unwrap().expires_at,
            "2026-10-22T12:00:00.000Z"
        );
        assert_eq!(
            draft("Judges", 10, Some(""), &[]).unwrap().expires_at,
            "2026-10-22T12:00:00.000Z"
        );
        // A day works until its end, UTC.
        assert_eq!(
            draft("Judges", 10, Some("2026-10-14"), &[])
                .unwrap()
                .expires_at,
            "2026-10-14T23:59:59.999Z"
        );
        assert_eq!(
            draft("Judges", 10, Some("2026-10-08"), &[])
                .unwrap()
                .expires_at,
            "2026-10-08T23:59:59.999Z"
        );
        assert!(
            draft("Judges", 10, Some("2026-10-07"), &[])
                .unwrap_err()
                .contains("passed")
        );
        assert!(draft("Judges", 10, Some("2027-10-08"), &[]).is_ok());
        assert!(
            draft("Judges", 10, Some("2027-10-09"), &[])
                .unwrap_err()
                .contains("365 days")
        );
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "next week",
            "2026-10-8",
            "2026/10/14",
        ] {
            assert!(
                draft("Judges", 10, Some(bad), &[])
                    .unwrap_err()
                    .contains("as a date"),
                "{bad}"
            );
        }
    }

    #[test]
    fn domains_are_tidied_and_checked() {
        let made = draft(
            "Judges",
            10,
            None,
            &["@Cloudflare.com, flagon.io", "cloudflare.com\nexample.dev."],
        )
        .unwrap();
        assert_eq!(made.domains, ["cloudflare.com", "flagon.io", "example.dev"]);
        assert!(draft("Judges", 10, None, &["not a domain!"]).is_err());
        assert!(
            draft("Judges", 10, None, &["localhost"])
                .unwrap_err()
                .contains("localhost is not an email domain")
        );
        assert!(draft("Judges", 10, None, &["-bad.com"]).is_err());
        let eleven: Vec<String> = (0..11).map(|n| format!("d{n}.com")).collect();
        let eleven: Vec<&str> = eleven.iter().map(String::as_str).collect();
        assert!(
            draft("Judges", 10, None, &eleven)
                .unwrap_err()
                .contains("at most 10")
        );
        assert_eq!(
            normalize_domain(" @EXAMPLE.com. ").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            domains_of(Some("cloudflare.com,flagon.io")),
            ["cloudflare.com", "flagon.io"]
        );
        assert!(domains_of(None).is_empty());
        assert!(domains_of(Some("")).is_empty());
    }

    #[test]
    fn a_shared_code_is_an_ordinary_invite_code() {
        let body = new_code_body();
        let link = format!("https://g1t.sh/register?invite={}", format_code(&body));
        assert_eq!(normalize_code(&link).as_deref(), Some(body.as_str()));
        assert_eq!(code_hash(&body).len(), 64);
        assert_eq!(AUDIT_ACCOUNT, "invites");
        assert!(g1t_contracts::is_reserved_name(AUDIT_ACCOUNT));
    }

    #[test]
    fn revoking_stops_new_accounts_and_forgets_the_code_once() {
        let revoke = revoke_sql();
        assert!(revoke.contains("revoked_by = ?1"));
        assert!(revoke.contains("sealed_code = NULL"));
        // Revoking twice changes nothing the second time.
        assert!(revoke.contains("AND revoked_at IS NULL"));
        // It deletes nothing: the accounts it made, and their uses, stay.
        assert!(!revoke.contains("DELETE"));
        let none: [String; 0] = [];
        let revoked = SharedAdmits { status: shared_status(true, LATER, 0, 10, NOW), domains: &none };
        assert_eq!(shared_admits(Some(&revoked), "ada@example.com"), Err(Refusal::Invalid));
    }

    #[test]
    fn each_use_records_where_the_account_came_from_and_outlives_a_purge() {
        // The row that takes a use names the account and the link: sudo's
        // "Joined through <label>".
        assert!(take_use_sql().contains("INSERT INTO shared_invite_uses (user_id, shared_invite_id, created_at)"));
        assert!(take_use_sql().contains("SELECT ?1, s.id,"));
        // Purging the account keeps the use, so it is never given back.
        let purge = crate::account_deletion::purge_statements();
        assert!(!purge.is_empty());
        assert!(purge.iter().all(|(sql, _)| !sql.contains("shared_invite_uses")));
    }
}
