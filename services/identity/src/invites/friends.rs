//! Invite a friend: any person invites someone to g1t by email.
//!
//! Anyone may sign up without an invite; this one is word of mouth. The
//! friend gets an email from the person who invited them, whose link opens
//! sign-up with their address filled in and, because it came from that
//! email, confirmed (invites.rs, `proves_email`). The account it makes
//! starts with a workspace of its own, and the invite records who invited
//! whom (`redeemed_by`), so the inviter sees who joined.
//!
//! Each person has `INVITES_PER_USER` (20) invites to g1t for good, plus
//! any staff grant (`invite_grants`, read with [`GRANTED`]). Pending and
//! used invites count; one revoked or expired before it was used comes
//! back. An invite to an address that already has an account, or to one
//! the person already has a pending invite for, is refused and costs
//! nothing. Inviting into a workspace or onto a repository never uses one.
//!
//! "Also invite them to a workspace" is only for a workspace the person
//! owns on a paid plan: a free workspace invites no one (paid.rs).
//!
//! The statements are constants written out in full, `SQL_NOW` included,
//! so scripts/deploy/friend-invites.test.mjs runs them as they are against
//! identity's migrations.

use g1t_contracts::audit::Surface;
use g1t_contracts::identity::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, User, new_id};
use g1t_kit::now_ms;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{BAD_EMAIL, CREATES_PER_HOUR, Count, Draft, Id, LIST_LIMIT, TOO_MANY, invite_note, normalize_email, resendable};
use crate::Identity;

/// Stores an invite (`?1`…`?14`, in the columns' order).
pub(crate) const INSERT: &str = r#"INSERT INTO invites (id, code_hash, hint, sealed_code, email, kind, workspace_id, inviter_id,
  staff, charged_to, created_at, expires_at, invitee_id, role)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
 RETURNING id"#;

/// [`INSERT`], only while the inviter `?15` has fewer than `?16` invites
/// to g1t counted against them: checked in the statement that writes, so
/// two made at once cannot both take the last one.
pub(crate) const INSERT_WITHIN_ALLOWANCE: &str = r#"INSERT INTO invites (id, code_hash, hint, sealed_code, email, kind, workspace_id, inviter_id,
  staff, charged_to, created_at, expires_at, invitee_id, role)
 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
 WHERE (SELECT count(*) FROM invites i WHERE i.inviter_id = ?15 AND i.charged_to = 'user'
   AND (i.redeemed_at IS NOT NULL OR (i.revoked_at IS NULL AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))) < ?16
 RETURNING id"#;

/// How many invites to g1t count against the person `?1`: used ones, and
/// ones neither revoked nor expired.
pub(crate) const USED: &str = r#"SELECT count(*) AS n FROM invites i WHERE i.inviter_id = ?1 AND i.charged_to = 'user'
   AND (i.redeemed_at IS NOT NULL OR (i.revoked_at IS NULL AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))"#;

/// The invites staff granted the person `?1`, together (negative takes back).
pub(crate) const GRANTED: &str =
    r#"SELECT COALESCE(SUM(amount), 0) AS n FROM invite_grants WHERE target_kind = 'user' AND target_id = ?1"#;

/// Whether the person `?1` already has a pending invite to g1t for `?2`.
pub(crate) const PENDING_FOR: &str = r#"SELECT count(*) AS n FROM invites WHERE inviter_id = ?1 AND email = ?2 AND charged_to = 'user'
   AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"#;

const ALREADY_ON_G1T: &str =
    "That address already has a g1t account, so there is nothing to invite them to. To work with them, invite them to a workspace from its People page.";
const ALREADY_PENDING: &str = "You already have a pending invite for that address. Send it again, or revoke it to make a new one.";
const ONLY_PENDING: &str = "Only a pending invite can be sent again.";
const NOT_YOURS: &str = "There is no invite to g1t of yours with that id.";

/// The message when a person has no invites left.
pub fn out_of_invites(limit: u32) -> String {
    format!("You have used all {limit} of your invites to g1t. Anyone can still sign up at g1t.sh without one.")
}

/// How many invites to g1t a person may have: the default plus staff
/// grants, never below zero.
pub fn limit_for(default: u32, granted: i64) -> u32 {
    (i64::from(default) + granted).clamp(0, i64::from(u32::MAX)) as u32
}

/// Whether an invite in this state uses up one of an allowance: pending
/// and used ones do; a revoked or expired one never used gives it back.
/// [`USED`] says the same in SQL.
pub fn counts_against_allowance(status: InviteStatus, used: bool) -> bool {
    used || status == InviteStatus::Pending
}

/// Why an invite to g1t cannot be made, checked in this order: the
/// address has an account, the person has a pending invite for it, or
/// they have none left. The first two cost nothing.
pub fn refusal(has_account: bool, pending: bool, allowance: Allowance) -> Option<(FailureCode, String)> {
    if has_account {
        return Some((FailureCode::Conflict, ALREADY_ON_G1T.to_owned()));
    }
    if pending {
        return Some((FailureCode::Conflict, ALREADY_PENDING.to_owned()));
    }
    if allowance.exhausted() {
        return Some((FailureCode::Limit, out_of_invites(allowance.limit)));
    }
    None
}

impl Identity {
    /// INVITES_PER_USER, or [`INVITES_PER_USER`] (20) when unset or not a
    /// number. A self-hoster may set it to 0 to turn invites to g1t off.
    fn invites_per_user(&self) -> u32 {
        self.var_number("INVITES_PER_USER").map_or(INVITES_PER_USER, |n| n.min(u64::from(u32::MAX)) as u32)
    }

    async fn sql_count(&self, sql: &str, binds: &[JsValue]) -> Result<f64> {
        Ok(self.db.prepare(sql).bind(binds)?.first::<Count>(None).await?.map_or(0.0, |count| count.n))
    }

    /// A person's invites to g1t: how many they may have and have used.
    pub async fn user_allowance(&self, user_id: &str) -> Result<Allowance> {
        let granted = self.sql_count(GRANTED, &[user_id.into()]).await? as i64;
        let used = self.sql_count(USED, &[user_id.into()]).await? as u32;
        Ok(Allowance::new(limit_for(self.invites_per_user(), granted), used))
    }

    /// The workspace an invite to g1t also invites its person to, from
    /// `join` (a slug): one `user` owns, on a paid plan. None for none.
    async fn joinable_workspace(&self, user: &User, join: Option<&str>) -> Result<Outcome<Option<(String, String)>>> {
        let Some(slug) = join.map(str::trim).filter(|slug| !slug.is_empty()).map(str::to_lowercase) else {
            return Ok(Outcome::Ok(None));
        };
        if user.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a workspace's owners can invite people to it."));
        }
        let Some(id) = self.workspace_id(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        // A free workspace adds no one until it starts the plan (paid.rs).
        if let Some(refused) = self.free_workspace_refusal(&slug).await? {
            return Ok(refused);
        }
        Ok(Outcome::Ok(Some((id, slug))))
    }

    pub async fn create_invite(&self, a: CreateInviteArgs) -> Result<Outcome<Invite>> {
        if let Some(reason) = Self::draft_allowed(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        let Some(email) = normalize_email(&a.email) else {
            return Ok(Outcome::fail(FailureCode::Invalid, BAD_EMAIL));
        };
        if !self.hit(&format!("invite.create:{}", a.user.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let has_account = self.email_has_account(&email).await?;
        let pending = !has_account && self.sql_count(PENDING_FOR, &[a.user.id.as_str().into(), email.as_str().into()]).await? > 0.0;
        let allowance = self.user_allowance(&a.user.id).await?;
        if let Some((code, message)) = refusal(has_account, pending, allowance) {
            return Ok(Outcome::fail(code, message));
        }
        let joins = match self.joinable_workspace(&a.user, a.join.as_deref()).await? {
            Outcome::Ok(joins) => joins,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let draft = Draft {
            email: Some(&email),
            kind: "account",
            workspace_id: joins.as_ref().map(|(id, _)| id.as_str()),
            inviter: Some(&a.user),
            staff: None,
            invitee_id: None,
            role: joins.as_ref().map(|_| if a.join_role == Some(Role::Owner) { "owner" } else { "member" }),
            charged_to: "user",
            limit: Some(allowance.limit),
        };
        let Some(invite) = self.insert_invite(draft).await? else {
            return Ok(Outcome::fail(FailureCode::Limit, out_of_invites(allowance.limit)));
        };
        if let Some(code) = &invite.code {
            let from = self.display_name(&a.user).await;
            let workspace = match &joins {
                Some((id, slug)) => Some(self.workspace_name(id, slug).await),
                None => None,
            };
            let note = invite_note(a.message.as_deref());
            self.send_invite_email(&email, Some(&from), workspace.as_deref(), false, code, &invite.id, note.as_deref()).await;
        }
        // A workspace it invites them to keeps it in its audit log; an
        // invite to g1t alone is the person's own business.
        if let Some((_, slug)) = &joins {
            let surface = a.surface.unwrap_or(Surface::Web);
            self.audit_invites(&a.user, "invite.created", vec![slug.clone()], surface, format!("Invited {email} to g1t and {slug}"))
                .await;
        }
        Ok(Outcome::Ok(invite))
    }

    pub async fn list_invites(&self, a: UserArgs) -> Result<InvitesOverview> {
        let invites = self
            .rows("WHERE i.inviter_id = ? AND i.charged_to = 'user'", &[a.user.id.as_str().into()], LIST_LIMIT)
            .await?
            .into_iter()
            .map(|row| self.shown(row, true, false))
            .collect();
        Ok(InvitesOverview { allowance: self.user_allowance(&a.user.id).await?, invites })
    }

    /// Sends a pending invite to g1t again: the same email, with the same
    /// link, to the same address. Counted with the invites made in the
    /// hour, so a list cannot be used to flood an inbox.
    pub async fn resend_invite(&self, a: RemoveArgs) -> Result<Outcome<Invite>> {
        if let Some(reason) = Self::draft_allowed(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, reason));
        }
        let row = self.invite_by_id(a.id.trim()).await?.filter(|row| {
            row.inviter_id.as_deref() == Some(a.user.id.as_str()) && row.charged_to.as_deref() == Some("user")
        });
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_YOURS));
        };
        if !resendable(row.status(&rfc3339(now_ms()))) {
            return Ok(Outcome::fail(FailureCode::Conflict, ONLY_PENDING));
        }
        if !self.hit(&format!("invite.create:{}", a.user.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let code = row.sealed_code.as_deref().and_then(|sealed| self.invite_sealer()?.open(sealed, &row.id));
        if let (Some(to), Some(code)) = (row.email.as_deref(), code.as_deref()) {
            let from = self.display_name(&a.user).await;
            let workspace = match (&row.workspace_id, &row.workspace) {
                (Some(id), Some(slug)) => Some(self.workspace_name(id, slug).await),
                _ => None,
            };
            self.send_invite_email(to, Some(&from), workspace.as_deref(), false, code, &row.id, None).await;
        }
        Ok(Outcome::Ok(self.shown(row, true, false)))
    }

    // --- Staff ---

    pub async fn admin_grant_invites(&self, a: AdminGrantInvitesArgs) -> Result<Outcome<Allowance>> {
        if a.amount == 0 || a.amount.abs() > MAX_INVITE_GRANT {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Grant between 1 and {MAX_INVITE_GRANT} invites, or take some back with a negative number."),
            ));
        }
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member granted them."));
        }
        let name = a.username.trim().trim_start_matches('@').to_lowercase();
        let user = self
            .db
            .prepare("SELECT id FROM users WHERE username = ? AND deleted_at IS NULL")
            .bind(&[name.as_str().into()])?
            .first::<Id>(None)
            .await?;
        let Some(Id { id: user_id }) = user else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no person named {name}.")));
        };
        let note = a.note.trim();
        self.db
            .prepare(
                "INSERT INTO invite_grants (id, target_kind, target_id, amount, note, granted_by, created_at)
                 VALUES (?, 'user', ?, ?, ?, ?, ?)",
            )
            .bind(&[
                new_id("igr", now_ms()).into(),
                user_id.as_str().into(),
                f64::from(a.amount).into(),
                if note.is_empty() { JsValue::NULL } else { note.into() },
                staff.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        worker::console_log!("{} invites granted to {name} by staff {staff}", a.amount);
        Ok(Outcome::Ok(self.user_allowance(&user_id).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::time::SQL_NOW;

    #[test]
    fn everyone_has_twenty_invites_to_g1t_plus_what_staff_grant() {
        assert_eq!(INVITES_PER_USER, 20);
        assert_eq!(limit_for(INVITES_PER_USER, 0), 20);
        assert_eq!(limit_for(20, 10), 30);
        assert_eq!(limit_for(20, -5), 15);
        assert_eq!(limit_for(20, -50), 0);
        // A self-hoster's 0 turns them off.
        assert_eq!(limit_for(0, 0), 0);
        let fresh = Allowance::new(20, 0);
        assert_eq!((fresh.remaining, fresh.exhausted()), (20, false));
        let last = Allowance::new(20, 19);
        assert_eq!((last.remaining, last.exhausted()), (1, false));
        let full = Allowance::new(20, 20);
        assert_eq!((full.remaining, full.exhausted()), (0, true));
        // Grants taken back below what was used: none left, never negative.
        assert_eq!(Allowance::new(15, 18).remaining, 0);
    }

    #[test]
    fn a_revoked_or_expired_invite_comes_back_and_a_used_one_is_spent() {
        assert!(counts_against_allowance(InviteStatus::Pending, false));
        assert!(!counts_against_allowance(InviteStatus::Revoked, false));
        assert!(!counts_against_allowance(InviteStatus::Expired, false));
        // Used: spent, whatever became of it after (revoked while the
        // account confirmed its address, or the workspace declined).
        for status in [
            InviteStatus::Redeemed,
            InviteStatus::AwaitingConfirmation,
            InviteStatus::AwaitingAnswer,
            InviteStatus::Revoked,
            InviteStatus::Declined,
        ] {
            assert!(counts_against_allowance(status, true), "{status:?}");
        }
        // The SQL says the same: used, or neither revoked nor expired.
        for sql in [USED, INSERT_WITHIN_ALLOWANCE] {
            assert!(sql.contains("i.redeemed_at IS NOT NULL OR (i.revoked_at IS NULL AND i.expires_at >"), "{sql}");
            assert!(sql.contains("i.charged_to = 'user'"), "{sql}");
        }
    }

    #[test]
    fn an_address_with_an_account_or_a_pending_invite_is_refused_without_costing_one() {
        let some = Allowance::new(20, 3);
        let none = Allowance::new(20, 20);
        let (code, message) = refusal(true, false, some).unwrap();
        assert_eq!(code, FailureCode::Conflict);
        assert!(message.contains("already has a g1t account"));
        // Even with none left, the account is what is said.
        assert_eq!(refusal(true, false, none).unwrap().1, ALREADY_ON_G1T);
        let (code, message) = refusal(false, true, some).unwrap();
        assert_eq!(code, FailureCode::Conflict);
        assert!(message.contains("already have a pending invite"));
        let (code, message) = refusal(false, false, none).unwrap();
        assert_eq!(code, FailureCode::Limit);
        assert!(message.contains("all 20"));
        // Never a gate: running out still says anyone can sign up.
        assert!(message.contains("Anyone can still sign up"));
        assert_eq!(refusal(false, false, some), None);
    }

    #[test]
    fn signing_up_from_a_friends_invite_confirms_the_address_and_makes_a_workspace_of_ones_own() {
        use super::super::{AwaitingJoin, InviteRow, admits, awaiting_join, email_proof, starts_confirmed};
        use super::super::invitations::makes_own_workspace;
        const KEY: &[u8] = b"identity key";
        let row = InviteRow {
            id: "inv_1".into(),
            hint: "g1t-k7m2".into(),
            sealed_code: None,
            email: Some("ada@example.com".into()),
            kind: "account".into(),
            workspace_id: None,
            workspace: None,
            inviter_id: Some("usr_bo".into()),
            inviter: Some("bo".into()),
            staff: None,
            charged_to: Some("user".into()),
            created_at: "2026-10-01T12:00:00.000Z".into(),
            expires_at: "2026-10-31T12:00:00.000Z".into(),
            revoked_at: None,
            redeemer: None,
            redeemed_at: None,
            applied_at: None,
            invitee_id: None,
            invitee: None,
            role: None,
            accepted_at: None,
            declined_at: None,
        };
        let now = "2026-10-13T12:00:00.000Z";
        // It admits its own address, and only while pending.
        assert_eq!(admits(Some(&row.admits(now)), "ada@example.com", true), Ok(()));
        assert!(admits(Some(&row.admits(now)), "eve@example.com", true).is_err());
        // Opened from its email, the address starts confirmed; the code alone does not.
        let proof = email_proof(KEY, &row.id, row.email.as_deref()).unwrap();
        assert!(starts_confirmed(KEY, false, Some(&row), "ada@example.com", Some(&proof)));
        assert!(!starts_confirmed(KEY, false, Some(&row), "ada@example.com", None));
        // It names no workspace: the account makes its own, and confirming
        // joins nothing.
        assert!(makes_own_workspace(row.workspace.as_deref(), false));
        assert_eq!(awaiting_join(&row, now), AwaitingJoin::Nothing);
        // Its inviter sees it used, by whom.
        let used = InviteRow {
            redeemer: Some("ada".into()),
            redeemed_at: Some(now.into()),
            applied_at: Some(now.into()),
            ..row
        };
        assert_eq!(used.status(now), InviteStatus::Redeemed);
        assert_eq!(super::super::charge_of(used.charged_to.as_deref()), InviteCharge::User);
    }

    #[test]
    fn the_statements_use_the_same_now_as_everything_else() {
        let now = format!("> {SQL_NOW}");
        for sql in [INSERT_WITHIN_ALLOWANCE, USED, PENDING_FOR, super::super::SPEND_CODE] {
            assert!(sql.contains(&now), "{sql}");
        }
        for sql in [super::super::REVOKE, super::super::INSERT_USER_WITH_CODE] {
            assert!(sql.contains(SQL_NOW), "{sql}");
        }
        // The guarded insert writes the same columns as the plain one.
        let columns = |sql: &str| sql.split(')').next().unwrap().to_owned();
        assert_eq!(columns(INSERT), columns(INSERT_WITHIN_ALLOWANCE));
    }
}
