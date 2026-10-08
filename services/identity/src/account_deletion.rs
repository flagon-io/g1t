//! Deleting an account.
//!
//! A person deletes their own account from their settings: signed in as
//! themselves (never with a token or as an agent), typing their username,
//! and proving it is them ([`Identity::proof`], security.rs). g1t's staff
//! can delete one from sudo, with a reason. Both are refused for a
//! protected account (`g1t`, `g1t-agent`, `ghost`, and whatever
//! `PROTECTED_ACCOUNTS` names, through
//! `g1t_contracts::identity::protected_names`), and while the account is
//! the only owner of any live workspace: its owner makes someone else an
//! owner, or deletes the workspace (deletion.rs, which settles its billing
//! with `close_workspace`), first. Billing is per workspace, so a workspace
//! the account co-owns is someone else's to pay for, and one it owns alone
//! is in the way already.
//!
//! Deleting is soft first, as for a workspace. At once, in one batch: the
//! row gets `deleted_at`, `deleted_by` and `purge_after`
//! ([`ACCOUNT_RESTORE_DAYS`] on); its sessions, access tokens (classic,
//! fine-grained and agents'), OAuth grants and codes, device sign-ins, SSH
//! keys, the deploy keys it added, two-factor sign-ins in progress, emailed
//! links and GitHub sign-ins in progress go; it leaves every workspace,
//! team and repository, its pending repository invitations are revoked and
//! the invites it made and nobody used are revoked. Every read that
//! resolves a person leaves it out from then on: it cannot sign in (the
//! answer is the one any wrong password gets), its profile is not found,
//! nobody can add it to anything, and nothing is emailed to it. Its
//! username stays held by its row. `user.deleting` tells services to stop
//! what they do for it. The memberships, teams and repository roles it
//! left are kept in `deleted_went`, so a restore puts them back.
//!
//! Until `purge_after`, staff can restore it from sudo: the columns are
//! cleared, its memberships come back where their workspace is still
//! there, and `user.restored` tells services. Its old sessions, tokens and
//! keys stay ended; the person signs in again with their password.
//!
//! The purge, by the scheduled sweep or by staff, removes the row, and with
//! it (by cascade and here) its addresses, keys, two-factor secret, GitHub
//! link, security log and profile. Its username goes into `deleted_users`,
//! so it is never given to another account or workspace. A workspace it
//! made names `ghost` as its creator instead. `user.deleted` tells services
//! to drop what they keep for it and show what it wrote as `ghost`.
//! Billing's ledgers and invoices and the audit logs keep its username.
//!
//! There is no API route for any of this: only the site and sudo call it.

use g1t_contracts::FailureCode;
use g1t_contracts::Outcome;
use g1t_contracts::User;
use g1t_contracts::account_deletion::*;
use g1t_contracts::billing::CloseWorkspaceArgs;
use g1t_contracts::events::{UserDeleted, UserDeleting, UserRestored};
use g1t_contracts::identity::{UserArgs, protected_names};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::security::is_person;

type Refusal = (FailureCode, String);

/// How many accounts one sweep purges.
const PURGES_PER_SWEEP: u32 = 25;

pub const PEOPLE_ONLY: &str = "Only you can delete your account, signed in as yourself; never with a token or as an agent.";

/// When an account deleted at `now_ms` is purged.
pub fn purge_after(now_ms: u64) -> String {
    rfc3339(now_ms + ACCOUNT_RESTORE_DAYS * 86_400_000)
}

/// Whether an account to be purged at `purge_after` can still be restored
/// at `now` (both RFC 3339, which compare as text).
pub fn restorable(purge_after: &str, now: &str) -> bool {
    now < purge_after
}

/// Whether the person may delete their account, from what is in the way
/// and what they typed. Protection first, then the workspaces they own
/// alone, then the typed username.
pub fn may_delete_own(person: bool, deletion: &AccountDeletion, confirm: &str) -> std::result::Result<(), Refusal> {
    if !person {
        return Err((FailureCode::Forbidden, PEOPLE_ONLY.to_owned()));
    }
    may_delete(deletion, confirm)
}

/// Whether an account may be deleted, for the person or staff alike.
pub fn may_delete(deletion: &AccountDeletion, confirm: &str) -> std::result::Result<(), Refusal> {
    if deletion.protected {
        return Err((FailureCode::Forbidden, protected_account_refusal(&deletion.username)));
    }
    if let Some(reason) = sole_owner_refusal(&deletion.sole_owner_of) {
        return Err((FailureCode::Conflict, reason));
    }
    if !confirms_username(&deletion.username, confirm) {
        return Err((FailureCode::Invalid, format!("Type {} to confirm.", deletion.username)));
    }
    Ok(())
}

/// Whether staff may restore a deleted account, now `now`.
pub fn may_restore(username: &str, purge_after: &str, now: &str) -> std::result::Result<(), Refusal> {
    if !restorable(purge_after, now) {
        return Err((
            FailureCode::Conflict,
            format!("{username} is being purged and can no longer be restored."),
        ));
    }
    Ok(())
}

/// Whether a deleted account may be purged, by staff (`confirm` is what
/// they typed) or by the sweep (`None`). Never a protected one.
pub fn may_purge(protected: bool, username: &str, confirm: Option<&str>) -> std::result::Result<(), Refusal> {
    if protected {
        return Err((FailureCode::Forbidden, protected_account_refusal(username)));
    }
    if let Some(typed) = confirm
        && !confirms_username(username, typed)
    {
        return Err((FailureCode::Invalid, format!("Type {username} to confirm.")));
    }
    Ok(())
}

/// What a deletion ends at once, in the batch that marks the row, each
/// with how many of the account's id (`?1`) and now (`?2`) it takes.
pub fn revoke_statements() -> Vec<(String, usize)> {
    let mut sql: Vec<(String, usize)> = vec![
        // A fine-grained token's repositories go with it, before it.
        ("DELETE FROM token_repositories WHERE token_id IN (SELECT id FROM access_tokens WHERE user_id = ?1)".to_owned(), 1),
    ];
    // Everything it signs in or acts with: sessions, tokens (classic,
    // fine-grained, agents'), applications, device sign-ins, SSH keys,
    // two-factor sign-ins in progress, emailed links, GitHub sign-ins in
    // progress. Then its place in workspaces and teams.
    for table in [
        "sessions",
        "access_tokens",
        "oauth_grants",
        "oauth_codes",
        "device_codes",
        "ssh_keys",
        "two_factor_challenges",
        "email_tokens",
        "github_states",
        "workspace_members",
        "team_members",
    ] {
        sql.push((format!("DELETE FROM {table} WHERE user_id = ?1"), 1));
    }
    sql.extend([
        // Deploy keys it added to repositories.
        ("DELETE FROM deploy_keys WHERE created_by = ?1".to_owned(), 1),
        // g1t keeps no GitHub token for it any more.
        ("UPDATE github_accounts SET tokens = NULL WHERE user_id = ?1".to_owned(), 1),
        ("DELETE FROM repo_grants WHERE principal_kind = 'user' AND principal_id = ?1".to_owned(), 1),
        (
            "UPDATE repo_invitations SET revoked_at = ?2
             WHERE invitee_id = ?1 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL"
                .to_owned(),
            2,
        ),
        // Invites it made that nobody used.
        (
            "UPDATE invites SET revoked_at = ?2, sealed_code = NULL
             WHERE inviter_id = ?1 AND redeemed_at IS NULL AND revoked_at IS NULL"
                .to_owned(),
            2,
        ),
    ]);
    sql
}

/// What a purge runs, in one batch, each with how many of the account's
/// id (`?1`), username (`?2`), when it was deleted (`?3`) and now (`?4`) it
/// takes. Every statement acts only while the account is still deleted and
/// awaiting its purge, so a restore a moment before wins whole.
pub fn purge_statements() -> Vec<(String, usize)> {
    const STILL: &str = "EXISTS (SELECT 1 FROM users WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after IS NOT NULL)";
    let mut sql = vec![(
        format!(
            "INSERT OR REPLACE INTO deleted_users (username, user_id, deleted_at, purged_at)
             SELECT ?2, ?1, ?3, ?4 WHERE {STILL}"
        ),
        4,
    )];
    // What names it as its maker or deleter names ghost: a workspace's
    // creator must be an account.
    for (table, column) in [("workspaces", "created_by"), ("workspaces", "deleted_by"), ("teams", "created_by")] {
        sql.push((format!("UPDATE {table} SET {column} = '{GHOST_ID}' WHERE {column} = ?1 AND {STILL}"), 1));
    }
    // Its personal data. Most goes by cascade with the row; each is said
    // outright so nothing depends on that.
    for table in [
        "user_emails",
        "github_accounts",
        "two_factor",
        "two_factor_recovery",
        "two_factor_challenges",
        "security_events",
        "sessions",
        "access_tokens",
        "oauth_grants",
        "oauth_codes",
        "device_codes",
        "email_tokens",
        "ssh_keys",
        "workspace_members",
        "team_members",
    ] {
        sql.push((format!("DELETE FROM {table} WHERE user_id = ?1 AND {STILL}"), 1));
    }
    sql.push(("DELETE FROM users WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after IS NOT NULL".to_owned(), 1));
    sql
}

/// A membership the account left, as it was.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Member {
    workspace_id: String,
    role: String,
    #[serde(default)]
    billing_manager: u8,
    #[serde(default)]
    security_manager: u8,
    created_at: String,
}

/// A team the account left.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct TeamMember {
    team_id: String,
    role: String,
    created_at: String,
}

/// A role on a repository the account had directly.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Grant {
    repo_id: String,
    workspace_id: String,
    repo_name: String,
    role: String,
    #[serde(default)]
    granted_by: Option<String>,
    created_at: String,
    updated_at: String,
}

/// What `deleted_went` holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    went: AccountWent,
    #[serde(default)]
    memberships: Vec<Member>,
    #[serde(default)]
    teams: Vec<TeamMember>,
    #[serde(default)]
    grants: Vec<Grant>,
}

fn snapshot_of(stored: Option<&str>) -> Snapshot {
    stored.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
}

/// A deleted account's row.
#[derive(Deserialize)]
struct DeletedRow {
    id: String,
    username: String,
    deleted_at: String,
    purge_after: String,
    #[serde(default)]
    deleted_went: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

impl DeletedRow {
    fn listed(&self, now: &str) -> DeletedAccount {
        DeletedAccount {
            user_id: self.id.clone(),
            username: self.username.clone(),
            deleted_at: self.deleted_at.clone(),
            purge_after: self.purge_after.clone(),
            went: snapshot_of(self.deleted_went.as_deref()).went,
            restorable: restorable(&self.purge_after, now),
        }
    }
}

/// Deleted accounts awaiting their purge: never `ghost`, whose row has no
/// purge time.
const DELETED_COLUMNS: &str = "id, username, deleted_at, purge_after, deleted_went, avatar
  FROM users WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL";

/// A live account, as found by username.
#[derive(Deserialize)]
struct Live {
    id: String,
    username: String,
}

impl Identity {
    /// `PROTECTED_ACCOUNTS`, with what is always protected.
    fn protected_account_names(&self) -> Vec<String> {
        let configured = self.env.var("PROTECTED_ACCOUNTS").ok().map(|v| v.to_string());
        protected_names(configured.as_deref())
    }

    /// Whether `user_id` is an account that has not been deleted.
    pub(crate) async fn account_live(&self, user_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS live FROM users WHERE id = ? AND deleted_at IS NULL")
            .bind(&[user_id.into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    async fn live_account(&self, column: &str, value: &str) -> Result<Option<Live>> {
        self.db
            .prepare(format!("SELECT id, username FROM users WHERE {column} = ? AND deleted_at IS NULL"))
            .bind(&[value.into()])?
            .first::<Live>(None)
            .await
    }

    /// The live workspaces `user_id` is the only owner of.
    async fn sole_owned(&self, user_id: &str) -> Result<Vec<SoleOwnedWorkspace>> {
        #[derive(Deserialize)]
        struct Row {
            slug: String,
            name: String,
            members: u32,
        }
        let rows = self
            .db
            .prepare(
                "SELECT w.slug, w.name,
                   (SELECT count(*) FROM workspace_members a WHERE a.workspace_id = w.id) AS members
                 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                 WHERE m.user_id = ?1 AND m.role = 'owner' AND w.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM workspace_members o
                                   WHERE o.workspace_id = w.id AND o.role = 'owner' AND o.user_id <> ?1)
                 ORDER BY w.slug",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(rows
            .into_iter()
            .map(|row| SoleOwnedWorkspace { slug: row.slug, name: row.name, members: row.members, billing: None })
            .collect())
    }

    /// What deleting the account would take with it, and what stands in
    /// the way. With `actor` (the person), billing says for each workspace
    /// they own alone what deleting it first would need.
    pub(crate) async fn account_deletion_facts(&self, user_id: &str, username: &str, actor: Option<&User>) -> Result<AccountDeletion> {
        #[derive(Deserialize)]
        struct Counts {
            workspaces: u32,
            tokens: u32,
            ssh_keys: u32,
            applications: u32,
            repositories: u32,
        }
        let counts = self
            .db
            .prepare(
                "SELECT
                   (SELECT count(*) FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                     WHERE m.user_id = ?1 AND w.deleted_at IS NULL) AS workspaces,
                   (SELECT count(*) FROM access_tokens WHERE user_id = ?1 AND agent_scope IS NULL
                     AND (expires_at IS NULL OR listed = 1)) AS tokens,
                   (SELECT count(*) FROM ssh_keys WHERE user_id = ?1) AS ssh_keys,
                   (SELECT count(*) FROM oauth_grants WHERE user_id = ?1) AS applications,
                   (SELECT count(*) FROM repo_grants WHERE principal_kind = 'user' AND principal_id = ?1) AS repositories",
            )
            .bind(&[user_id.into()])?
            .first::<Counts>(None)
            .await?
            .unwrap_or(Counts { workspaces: 0, tokens: 0, ssh_keys: 0, applications: 0, repositories: 0 });
        let mut sole_owner_of = self.sole_owned(user_id).await?;
        if let Some(actor) = actor
            && !sole_owner_of.is_empty()
        {
            let billing = self.env.service("BILLING")?;
            for workspace in &mut sole_owner_of {
                let closing: Result<Outcome<bool>> = g1t_kit::call(
                    &billing,
                    "close_workspace",
                    &CloseWorkspaceArgs { actor: actor.clone(), workspace: workspace.slug.clone(), dry_run: true },
                )
                .await;
                workspace.billing = match closing {
                    Ok(Outcome::Fail(failure)) => Some(failure.message),
                    _ => None,
                };
            }
        }
        Ok(AccountDeletion {
            username: username.to_owned(),
            workspaces: counts.workspaces,
            tokens: counts.tokens,
            ssh_keys: counts.ssh_keys,
            applications: counts.applications,
            repositories: counts.repositories,
            sole_owner_of,
            protected: is_protected_account(&self.protected_account_names(), user_id, username),
        })
    }

    /// `check_account_deletion`: what deleting the person's own account
    /// would take, and what is in the way, changing nothing.
    pub async fn check_account_deletion(&self, a: UserArgs) -> Result<Outcome<AccountDeletion>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let Some(live) = self.live_account("id", &a.user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Account not found."));
        };
        Ok(Outcome::Ok(self.account_deletion_facts(&live.id, &live.username, Some(&a.user)).await?))
    }

    /// `delete_account`: the person deletes their own account.
    pub async fn delete_account(&self, a: DeleteAccountArgs) -> Result<Outcome<bool>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let Some(live) = self.live_account("id", &a.user.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Account not found."));
        };
        let deletion = self.account_deletion_facts(&live.id, &live.username, None).await?;
        if let Err((code, message)) = may_delete_own(true, &deletion, &a.confirm) {
            return Ok(Outcome::fail(code, message));
        }
        // Proof last: nothing else in the way, so a password typed now is
        // the last thing asked.
        if let Some(refusal) = self.proof(&live.id, &a.reauth).await?.refusal() {
            return Ok(refusal);
        }
        self.soft_delete(&live, &deletion, Some(&live.id), None).await?;
        Ok(Outcome::Ok(true))
    }

    /// `admin_delete_account`: staff delete an account, with a reason.
    pub async fn admin_delete_account(&self, a: AdminDeleteAccountArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        let reason = a.reason.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is deleting it."));
        }
        if reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why the account is being deleted."));
        }
        let Some(live) = self.live_account("username", &a.username.trim().to_lowercase()).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account, or it is already deleted."));
        };
        let deletion = self.account_deletion_facts(&live.id, &live.username, None).await?;
        if let Err((code, message)) = may_delete(&deletion, &a.confirm) {
            // Staff read "you" as the account's.
            let message = message.replacen("You are the only owner", &format!("{} is the only owner", live.username), 1);
            return Ok(Outcome::fail(code, message));
        }
        self.soft_delete(&live, &deletion, None, Some((staff, reason))).await?;
        self.record_for_staff(
            &live.username,
            "account_deleted",
            &format!("Deleted the account {}: {reason}", live.username),
            staff,
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// Deletes an account softly: see the module docs.
    async fn soft_delete(
        &self,
        live: &Live,
        deletion: &AccountDeletion,
        deleted_by: Option<&str>,
        staff: Option<(&str, &str)>,
    ) -> Result<()> {
        let id = live.id.as_str();
        let snapshot = self.snapshot(id, deletion, staff).await?;
        let now = now_ms();
        let at = rfc3339(now);
        let purge = purge_after(now);
        let by_staff = staff.is_some();
        // Recorded in each workspace it was in, while it still is.
        let person = User { id: live.id.clone(), username: live.username.clone(), ..User::default() };
        let action = if by_staff { "account.deleted_by_staff" } else { "account.deleted" };
        self.audit_account(&person, action, &format!("Deleted the account {}", live.username)).await;
        // The person hears of it while their addresses are still there.
        for address in self.notice_recipients(id, false).await.unwrap_or_default() {
            if let Err(error) = crate::email::send_account_deleted(&self.env, &address, &live.username, by_staff, ACCOUNT_RESTORE_DAYS).await {
                worker::console_error!("account deleted notice failed: {error}");
            }
        }
        let went = serde_json::to_string(&snapshot).unwrap_or_default();
        let by: JsValue = deleted_by.map_or(JsValue::NULL, Into::into);
        let mut statements = vec![
            // Only while it is still live: two deletions at once delete once.
            self.db
                .prepare(
                    "UPDATE users SET deleted_at = ?, deleted_by = ?, purge_after = ?, deleted_went = ?
                     WHERE id = ? AND deleted_at IS NULL",
                )
                .bind(&[at.as_str().into(), by, purge.as_str().into(), went.into(), id.into()])?,
        ];
        let values = [id, at.as_str()];
        for (sql, binds) in revoke_statements() {
            let binds: Vec<JsValue> = values[..binds].iter().map(|value| JsValue::from(*value)).collect();
            statements.push(self.db.prepare(sql).bind(&binds)?);
        }
        self.db.batch(statements).await?;
        self.log_security(id, "account_deleted", None, staff).await;
        self.announce(
            "user.deleting",
            deleted_by,
            UserDeleting { user_id: live.id.clone(), username: live.username.clone(), by_staff, purge_after: purge },
        )
        .await;
        Ok(())
    }

    /// What the account has now, kept so a restore can put it back.
    async fn snapshot(&self, id: &str, deletion: &AccountDeletion, staff: Option<(&str, &str)>) -> Result<Snapshot> {
        let memberships = self
            .db
            .prepare(
                "SELECT workspace_id, role, billing_manager, security_manager, created_at
                 FROM workspace_members WHERE user_id = ?",
            )
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<Member>()?;
        let teams = self
            .db
            .prepare("SELECT team_id, role, created_at FROM team_members WHERE user_id = ?")
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<TeamMember>()?;
        let grants = self
            .db
            .prepare(
                "SELECT repo_id, workspace_id, repo_name, role, granted_by, created_at, updated_at
                 FROM repo_grants WHERE principal_kind = 'user' AND principal_id = ?",
            )
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<Grant>()?;
        Ok(Snapshot {
            went: AccountWent {
                workspaces: deletion.workspaces,
                teams: teams.len() as u32,
                repositories: grants.len() as u32,
                tokens: deletion.tokens,
                ssh_keys: deletion.ssh_keys,
                staff: staff.map(|(who, _)| who.to_owned()),
                reason: staff.map(|(_, why)| why.to_owned()),
            },
            memberships,
            teams,
            grants,
        })
    }

    /// Deleted accounts not purged yet, newest first. Staff only.
    pub async fn admin_deleted_accounts(&self) -> Result<Vec<DeletedAccount>> {
        let rows = self
            .db
            .prepare(format!("SELECT {DELETED_COLUMNS} ORDER BY deleted_at DESC LIMIT 500"))
            .all()
            .await?
            .results::<DeletedRow>()?;
        let now = rfc3339(now_ms());
        Ok(rows.iter().map(|row| row.listed(&now)).collect())
    }

    async fn deleted_account_row(&self, column: &str, value: &str) -> Result<Option<DeletedRow>> {
        self.db
            .prepare(format!("SELECT {DELETED_COLUMNS} AND {column} = ?"))
            .bind(&[value.into()])?
            .first::<DeletedRow>(None)
            .await
    }

    /// The deletion of `user_id`, when it is deleted and not purged.
    pub(crate) async fn deleted_account(&self, user_id: &str) -> Result<Option<DeletedAccount>> {
        let now = rfc3339(now_ms());
        Ok(self.deleted_account_row("id", user_id).await?.map(|row| row.listed(&now)))
    }

    /// Staff bring a deleted account back within its window, with the
    /// memberships, teams and repository roles it left. Staff only.
    pub async fn admin_restore_account(&self, a: AdminDeletedAccountArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is restoring it."));
        }
        let Some(row) = self.deleted_account_row("id", &a.user_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no deleted account with that id."));
        };
        if let Err((code, message)) = may_restore(&row.username, &row.purge_after, &rfc3339(now_ms())) {
            return Ok(Outcome::fail(code, message));
        }
        let snapshot = snapshot_of(row.deleted_went.as_deref());
        let id = row.id.as_str();
        let mut statements = vec![
            self.db
                .prepare(
                    "UPDATE users SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, deleted_went = NULL
                     WHERE id = ? AND deleted_at IS NOT NULL",
                )
                .bind(&[id.into()])?,
        ];
        // Back where the workspace, team or repository's workspace is
        // still there; never over what was given since.
        for member in &snapshot.memberships {
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO workspace_members
                           (workspace_id, user_id, role, created_at, billing_manager, security_manager)
                         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?1)",
                    )
                    .bind(&[
                        member.workspace_id.as_str().into(),
                        id.into(),
                        member.role.as_str().into(),
                        member.created_at.as_str().into(),
                        member.billing_manager.into(),
                        member.security_manager.into(),
                    ])?,
            );
        }
        for team in &snapshot.teams {
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at)
                         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM teams WHERE id = ?1)",
                    )
                    .bind(&[team.team_id.as_str().into(), id.into(), team.role.as_str().into(), team.created_at.as_str().into()])?,
            );
        }
        for grant in &snapshot.grants {
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO repo_grants
                           (repo_id, principal_kind, principal_id, workspace_id, repo_name, role, granted_by, created_at, updated_at)
                         SELECT ?1, 'user', ?2, ?3, ?4, ?5, ?6, ?7, ?8
                         WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3)",
                    )
                    .bind(&[
                        grant.repo_id.as_str().into(),
                        id.into(),
                        grant.workspace_id.as_str().into(),
                        grant.repo_name.as_str().into(),
                        grant.role.as_str().into(),
                        grant.granted_by.as_deref().map_or(JsValue::NULL, Into::into),
                        grant.created_at.as_str().into(),
                        grant.updated_at.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        self.log_security(id, "account_restored", None, Some((staff, "Restored by g1t's staff"))).await;
        self.record_for_staff(&row.username, "account_restored", &format!("Restored the account {}", row.username), staff)
            .await;
        self.announce("user.restored", None, UserRestored { user_id: row.id.clone(), username: row.username.clone() })
            .await;
        Ok(Outcome::Ok(true))
    }

    /// Staff purge a deleted account now rather than at `purge_after`.
    pub async fn admin_purge_account(&self, a: AdminDeletedAccountArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is purging it."));
        }
        let Some(row) = self.deleted_account_row("id", &a.user_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no deleted account with that id."));
        };
        let protected = is_protected_account(&self.protected_account_names(), &row.id, &row.username);
        if let Err((code, message)) = may_purge(protected, &row.username, Some(&a.confirm)) {
            return Ok(Outcome::fail(code, message));
        }
        self.purge_account(&row).await?;
        self.record_for_staff(&row.username, "account_purged", &format!("Purged the account {} now", row.username), staff)
            .await;
        Ok(Outcome::Ok(true))
    }

    /// The sweep: purges deleted accounts whose restore window has passed.
    pub async fn purge_due_accounts(&self) -> Result<u32> {
        let due = self
            .db
            .prepare(format!(
                "SELECT {DELETED_COLUMNS} AND purge_after <= ? ORDER BY purge_after LIMIT {PURGES_PER_SWEEP}"
            ))
            .bind(&[rfc3339(now_ms()).into()])?
            .all()
            .await?
            .results::<DeletedRow>()?;
        let names = self.protected_account_names();
        let mut purged = 0;
        for row in due {
            if let Err((_, why)) = may_purge(is_protected_account(&names, &row.id, &row.username), &row.username, None) {
                worker::console_error!("{} not purged: {why}", row.username);
                continue;
            }
            match self.purge_account(&row).await {
                Ok(()) => purged += 1,
                Err(error) => worker::console_error!("{} not purged: {error}", row.username),
            }
        }
        Ok(purged)
    }

    /// Removes a deleted account for good: see the module docs.
    async fn purge_account(&self, row: &DeletedRow) -> Result<()> {
        let now = rfc3339(now_ms());
        let values = [row.id.as_str(), row.username.as_str(), row.deleted_at.as_str(), now.as_str()];
        let mut batch = Vec::new();
        for (sql, binds) in purge_statements() {
            let binds: Vec<JsValue> = values[..binds].iter().map(|value| JsValue::from(*value)).collect();
            batch.push(self.db.prepare(sql).bind(&binds)?);
        }
        self.db.batch(batch).await?;
        if let Err(error) = self.forget_avatar(row.avatar.clone()).await {
            worker::console_error!("avatar of {} not removed: {error}", row.username);
        }
        self.announce("user.deleted", None, UserDeleted { user_id: row.id.clone(), username: row.username.clone() })
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deletion(username: &str) -> AccountDeletion {
        AccountDeletion { username: username.into(), ..AccountDeletion::default() }
    }

    fn sole(slug: &str) -> SoleOwnedWorkspace {
        SoleOwnedWorkspace { slug: slug.into(), name: slug.into(), members: 2, billing: None }
    }

    #[test]
    fn only_the_person_typing_their_username() {
        assert!(may_delete_own(true, &deletion("ada"), " ADA ").is_ok());
        assert_eq!(may_delete_own(false, &deletion("ada"), "ada").unwrap_err().0, FailureCode::Forbidden);
        assert_eq!(may_delete_own(true, &deletion("ada"), "").unwrap_err(), (FailureCode::Invalid, "Type ada to confirm.".into()));
        assert_eq!(may_delete_own(true, &deletion("ada"), "ada-l").unwrap_err().0, FailureCode::Invalid);
    }

    #[test]
    fn the_only_owner_of_a_live_workspace_is_refused_with_its_name() {
        let owner = AccountDeletion { sole_owner_of: vec![sole("acme"), sole("globex")], ..deletion("ada") };
        let (code, message) = may_delete_own(true, &owner, "ada").unwrap_err();
        assert_eq!(code, FailureCode::Conflict);
        assert!(message.contains("acme and globex"), "{message}");
        // Staff are refused the same way.
        assert_eq!(may_delete(&owner, "ada").unwrap_err().0, FailureCode::Conflict);
    }

    #[test]
    fn a_protected_account_is_refused_to_everyone_and_never_purged() {
        let names = protected_names(None);
        for username in ["g1t", "g1t-agent", "ghost"] {
            assert!(is_protected_account(&names, "usr_1", username));
            let protected = AccountDeletion { protected: true, ..deletion(username) };
            let (code, message) = may_delete_own(true, &protected, username).unwrap_err();
            assert_eq!(code, FailureCode::Forbidden);
            assert_eq!(message, format!("{username} is protected and can never be deleted."));
            assert_eq!(may_purge(true, username, None).unwrap_err().0, FailureCode::Forbidden);
            assert_eq!(may_purge(true, username, Some(username)).unwrap_err().0, FailureCode::Forbidden);
        }
        // Named in PROTECTED_ACCOUNTS, by username or id.
        let named = protected_names(Some("ada,usr_9"));
        assert!(is_protected_account(&named, "usr_2", "Ada"));
        assert!(is_protected_account(&named, "usr_9", "grace"));
        assert!(!is_protected_account(&named, "usr_3", "grace"));
    }

    #[test]
    fn a_deleted_account_is_restorable_for_thirty_days_then_due() {
        let deleted = 1_790_000_000_000;
        let purge = purge_after(deleted);
        assert_eq!(purge, rfc3339(deleted + 30 * 86_400_000));
        assert!(restorable(&purge, &rfc3339(deleted + 29 * 86_400_000)));
        assert!(!restorable(&purge, &purge));
        assert!(may_restore("ada", &purge, &rfc3339(deleted + 86_400_000)).is_ok());
        assert_eq!(
            may_restore("ada", &purge, &rfc3339(deleted + 31 * 86_400_000)).unwrap_err(),
            (FailureCode::Conflict, "ada is being purged and can no longer be restored.".to_owned())
        );
    }

    #[test]
    fn staff_purge_only_with_the_username_typed() {
        assert!(may_purge(false, "ada", None).is_ok());
        assert!(may_purge(false, "ada", Some(" Ada ")).is_ok());
        assert_eq!(may_purge(false, "ada", Some("")).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(may_purge(false, "ada", Some("grace")).unwrap_err().0, FailureCode::Invalid);
    }

    #[test]
    fn what_it_left_is_kept_for_a_restore_and_read_back() {
        let snapshot = Snapshot {
            went: AccountWent { workspaces: 2, teams: 1, repositories: 1, tokens: 3, ssh_keys: 1, staff: Some("s@g1t.sh".into()), reason: Some("asked".into()) },
            memberships: vec![Member {
                workspace_id: "wsp_1".into(),
                role: "owner".into(),
                billing_manager: 0,
                security_manager: 1,
                created_at: "2026-01-01T00:00:00.000Z".into(),
            }],
            teams: vec![TeamMember { team_id: "tem_1".into(), role: "maintainer".into(), created_at: "x".into() }],
            grants: vec![Grant {
                repo_id: "rep_1".into(),
                workspace_id: "wsp_2".into(),
                repo_name: "api".into(),
                role: "write".into(),
                granted_by: None,
                created_at: "x".into(),
                updated_at: "y".into(),
            }],
        };
        let stored = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(snapshot_of(Some(&stored)), snapshot);
        assert_eq!(snapshot_of(None), Snapshot::default());
        assert_eq!(snapshot_of(Some("not json")), Snapshot::default());
    }

    /// The highest `?N` a statement names: D1 refuses a statement given
    /// more or fewer values than that.
    fn highest_bind(sql: &str) -> usize {
        (1..=9).filter(|n| sql.contains(&format!("?{n}"))).max().unwrap_or(0)
    }

    #[test]
    fn every_statement_is_given_exactly_the_values_it_names() {
        for (sql, binds) in revoke_statements().into_iter().chain(purge_statements()) {
            assert_eq!(highest_bind(&sql), binds, "{sql}");
        }
    }

    #[test]
    fn deleting_ends_everything_it_signs_in_with_and_every_membership() {
        let sql: Vec<String> = revoke_statements().into_iter().map(|(sql, _)| sql).collect();
        for table in [
            "sessions",
            "access_tokens",
            "oauth_grants",
            "device_codes",
            "ssh_keys",
            "two_factor_challenges",
            "email_tokens",
            "workspace_members",
            "team_members",
        ] {
            assert!(sql.iter().any(|s| s == &format!("DELETE FROM {table} WHERE user_id = ?1")), "{table}");
        }
        assert!(sql.iter().any(|s| s.starts_with("DELETE FROM deploy_keys WHERE created_by = ?1")));
        assert!(sql.iter().any(|s| s.starts_with("DELETE FROM repo_grants")));
        assert!(sql.iter().any(|s| s.starts_with("UPDATE github_accounts SET tokens = NULL")));
        // A token's repositories go before the token, which the subquery needs.
        let repositories = sql.iter().position(|s| s.contains("token_repositories")).unwrap();
        let tokens = sql.iter().position(|s| s == "DELETE FROM access_tokens WHERE user_id = ?1").unwrap();
        assert!(repositories < tokens);
    }

    #[test]
    fn a_purge_keeps_the_username_hands_authorship_to_ghost_and_loses_to_a_restore() {
        let sql: Vec<String> = purge_statements().into_iter().map(|(sql, _)| sql).collect();
        assert!(sql[0].starts_with("INSERT OR REPLACE INTO deleted_users"));
        assert!(sql.iter().any(|s| s.starts_with("UPDATE workspaces SET created_by = 'usr_ghost' WHERE created_by = ?1")));
        for table in ["user_emails", "github_accounts", "two_factor", "two_factor_recovery", "security_events", "ssh_keys"] {
            assert!(sql.iter().any(|s| s.starts_with(&format!("DELETE FROM {table} WHERE user_id = ?1"))), "{table}");
        }
        // The row goes last, and everything before it only while the
        // account is still deleted, so a restore a moment before wins.
        assert!(sql.last().unwrap().starts_with("DELETE FROM users WHERE id = ?1 AND deleted_at IS NOT NULL"));
        for s in &sql[..sql.len() - 1] {
            assert!(s.contains("deleted_at IS NOT NULL AND purge_after IS NOT NULL"), "{s}");
        }
    }

    #[test]
    fn the_deleted_list_never_shows_ghost() {
        // ghost's row is deleted with no purge time; the list and the
        // sweep both need one.
        assert!(DELETED_COLUMNS.contains("purge_after IS NOT NULL"));
    }
}
